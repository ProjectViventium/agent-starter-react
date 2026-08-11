'use client';

/* VIVENTIUM START
 * Purpose: Viventium agent-starter customization.
 * Feature: Call-session state hook for Wing Mode, Listen-Only Mode, and keepalive
 *
 * Why:
 * - Keep active calls alive through long silence windows by periodically touching the call session.
 * - Expose persisted call-mode toggles for the modern playground.
 * VIVENTIUM END */
import { useCallback, useEffect, useRef, useState } from 'react';
import { callBrowserCapabilityHeaders } from '@/lib/call-browser-capability';
import { type CallIssue, CallRequestError, callIssueFromResponse } from '@/lib/call-start';
import { type VoiceCallStateV1, type VoiceCallStatus, parseVoiceCallState } from '@/lib/call-state';

const KEEPALIVE_INTERVAL_MS = 25_000;
const STARTUP_RECONCILIATION_INTERVAL_MS = 1_000;
const STARTUP_RECONCILIATION_MAX_MS = 15_000;
const INITIAL_STATE_RETRY_MS = 1500;
const INITIAL_STATE_MAX_ATTEMPTS = 2;
const CALL_STATE_REQUEST_TIMEOUT_MS = 5_000;
const STARTUP_SETTLED_CALL_STATUSES = new Set<VoiceCallStatus>([
  'listening',
  'speaking',
  'working',
  'needs_input',
  'degraded',
  'failed',
  'ended',
]);

export type VoiceCallMode = 'call' | 'wing' | 'listen_only';

type CallSessionStateResponse = {
  callSessionId?: string;
  roomName?: string;
  expiresAtMs?: number | null;
  wingModeEnabled?: boolean;
  shadowModeEnabled?: boolean;
  listenOnlyModeEnabled?: boolean;
  mode?: VoiceCallMode;
  message?: string;
  error?: unknown;
  code?: unknown;
  retryable?: unknown;
  version?: unknown;
  status?: unknown;
  revision?: unknown;
  updatedAt?: unknown;
};

export type UseCallSessionStateResult = {
  mode: VoiceCallMode;
  modePending: boolean;
  wingModeEnabled: boolean;
  wingModePending: boolean;
  listenOnlyModeEnabled: boolean;
  listenOnlyModePending: boolean;
  callStateError: string | null;
  callStateIssue: CallIssue | null;
  callStateRetryable: boolean;
  lastModeTransition: VoiceCallStateV1 | null;
  setMode: (mode: VoiceCallMode) => Promise<boolean>;
  setWingModeEnabled: (enabled: boolean) => Promise<boolean>;
  setListenOnlyModeEnabled: (enabled: boolean) => Promise<boolean>;
};

function normalizeResponse(payload: CallSessionStateResponse | null | undefined) {
  const legacyMode: VoiceCallMode =
    payload?.listenOnlyModeEnabled === true
      ? 'listen_only'
      : payload?.wingModeEnabled === true ||
          (typeof payload?.wingModeEnabled !== 'boolean' && payload?.shadowModeEnabled === true)
        ? 'wing'
        : 'call';
  const mode: VoiceCallMode =
    payload?.mode === 'call' || payload?.mode === 'wing' || payload?.mode === 'listen_only'
      ? payload.mode
      : legacyMode;
  const listenOnlyModeEnabled = mode === 'listen_only';
  const authoritativeCallState = parseVoiceCallState(payload);
  const status = authoritativeCallState?.status ?? null;
  const stateError =
    payload?.error && typeof payload.error === 'object' && !Array.isArray(payload.error)
      ? payload.error
      : null;
  const structuredIssue =
    (status === 'failed' || status === 'degraded') && stateError
      ? callIssueFromResponse(200, stateError)
      : null;
  return {
    mode,
    wingModeEnabled: mode === 'wing',
    listenOnlyModeEnabled,
    expiresAtMs:
      typeof payload?.expiresAtMs === 'number' && Number.isFinite(payload.expiresAtMs)
        ? payload.expiresAtMs
        : null,
    message: structuredIssue?.message ?? null,
    issue: structuredIssue,
    retryable: structuredIssue?.retryable === true,
    authoritativeCallState,
  };
}

async function requestCallSessionState(
  method: 'GET' | 'POST',
  callSessionId: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal
) {
  const url =
    method === 'GET'
      ? `/api/call-session-state?callSessionId=${encodeURIComponent(callSessionId)}`
      : '/api/call-session-state';

  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) {
    abortFromParent();
  } else {
    signal?.addEventListener('abort', abortFromParent, { once: true });
  }
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CALL_STATE_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...callBrowserCapabilityHeaders(callSessionId),
      },
      body:
        method === 'POST'
          ? JSON.stringify({
              callSessionId,
              ...(body ?? {}),
            })
          : undefined,
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) {
      throw new CallRequestError(
        {
          kind: 'gateway_down',
          message: 'Call state timed out before the voice runtime responded. You can retry safely.',
        },
        true
      );
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', abortFromParent);
  }

  const payload = (await response.json().catch(() => ({}))) as CallSessionStateResponse;
  const normalized = normalizeResponse(payload);
  if (!response.ok) {
    const issue = callIssueFromResponse(response.status, payload);
    throw new CallRequestError(
      {
        ...issue,
        message: normalized.message ?? issue.message,
      },
      payload.retryable === true
    );
  }
  return normalized;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function formatCallSessionStateError(error: unknown, fallback: string, retrying = false): string {
  if (error instanceof TypeError) {
    return retrying
      ? 'Viventium is reconnecting to the voice runtime. Retrying call state...'
      : 'Viventium could not reach the voice runtime for call state. Check the connection and retry.';
  }
  return error instanceof Error && error.message.trim() ? error.message.trim() : fallback;
}

export function useCallSessionState(
  callSessionId: string | null,
  keepAliveEnabled: boolean
): UseCallSessionStateResult {
  const [mode, setModeState] = useState<VoiceCallMode>('call');
  const [modePending, setModePending] = useState(false);
  const [wingModeEnabled, setWingModeEnabledState] = useState(false);
  const [wingModePending, setWingModePending] = useState(false);
  const [listenOnlyModeEnabled, setListenOnlyModeEnabledState] = useState(false);
  const [listenOnlyModePending, setListenOnlyModePending] = useState(false);
  const [callStateError, setCallStateError] = useState<string | null>(null);
  const [callStateIssue, setCallStateIssue] = useState<CallIssue | null>(null);
  const [callStateRetryable, setCallStateRetryable] = useState(false);
  const [lastModeTransition, setLastModeTransition] = useState<VoiceCallStateV1 | null>(null);
  const stateRequestGenerationRef = useRef(0);
  const stateRequestsInFlightRef = useRef(0);
  const latestCallStatusRef = useRef<VoiceCallStatus | null>(null);
  const modeMutationPendingRef = useRef(false);

  const applyState = useCallback((next: ReturnType<typeof normalizeResponse>) => {
    setModeState(next.mode);
    setWingModeEnabledState(next.wingModeEnabled);
    setListenOnlyModeEnabledState(next.listenOnlyModeEnabled);
    setCallStateError(next.message ?? null);
    setCallStateIssue(next.issue);
    setCallStateRetryable(next.retryable);
    if (next.authoritativeCallState) {
      latestCallStatusRef.current = next.authoritativeCallState.status;
    }
  }, []);

  const beginStateRequest = useCallback(() => {
    stateRequestGenerationRef.current += 1;
    return stateRequestGenerationRef.current;
  }, []);

  const shouldApplyStateResponse = useCallback(
    (requestGeneration: number, blockedByModeMutation = false) =>
      !blockedByModeMutation && requestGeneration === stateRequestGenerationRef.current,
    []
  );

  const performStateRequest = useCallback(
    async (
      method: 'GET' | 'POST',
      currentCallSessionId: string,
      body?: Record<string, unknown>,
      signal?: AbortSignal
    ) => {
      stateRequestsInFlightRef.current += 1;
      try {
        return await requestCallSessionState(method, currentCallSessionId, body, signal);
      } finally {
        stateRequestsInFlightRef.current = Math.max(0, stateRequestsInFlightRef.current - 1);
      }
    },
    []
  );

  const syncState = useCallback(
    async (body?: Record<string, unknown>) => {
      if (!callSessionId) {
        return null;
      }
      const requestGeneration = beginStateRequest();
      const next = await performStateRequest(body ? 'POST' : 'GET', callSessionId, body);
      if (!shouldApplyStateResponse(requestGeneration)) {
        return null;
      }
      applyState(next);
      return next;
    },
    [applyState, beginStateRequest, callSessionId, performStateRequest, shouldApplyStateResponse]
  );

  useEffect(() => {
    if (!callSessionId) {
      setModeState('call');
      setModePending(false);
      setWingModeEnabledState(false);
      setWingModePending(false);
      setListenOnlyModeEnabledState(false);
      setListenOnlyModePending(false);
      setCallStateError(null);
      setCallStateIssue(null);
      setCallStateRetryable(false);
      setLastModeTransition(null);
      latestCallStatusRef.current = null;
      return;
    }

    latestCallStatusRef.current = null;
    let cancelled = false;
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const loadState = (attempt: number) => {
      if (stateRequestsInFlightRef.current > 0 || modeMutationPendingRef.current) {
        retryTimeoutId = setTimeout(() => {
          retryTimeoutId = null;
          loadState(attempt);
        }, STARTUP_RECONCILIATION_INTERVAL_MS);
        return;
      }
      const requestGeneration = beginStateRequest();
      const blockedByModeMutation = modeMutationPendingRef.current;
      performStateRequest('GET', callSessionId, undefined, controller.signal)
        .then((next) => {
          if (cancelled || !shouldApplyStateResponse(requestGeneration, blockedByModeMutation)) {
            return;
          }
          applyState(next);
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          if (isAbortError(error)) {
            return;
          }
          const shouldRetry =
            error instanceof TypeError && attempt + 1 < INITIAL_STATE_MAX_ATTEMPTS;
          const issue =
            error instanceof CallRequestError
              ? { kind: error.code, message: error.message }
              : error instanceof TypeError
                ? {
                    kind: 'gateway_down' as const,
                    message: formatCallSessionStateError(
                      error,
                      'Call session check failed.',
                      shouldRetry
                    ),
                  }
                : {
                    kind: 'unknown' as const,
                    message: formatCallSessionStateError(error, 'Call session check failed.'),
                  };
          setCallStateIssue(issue);
          setCallStateError(issue.message);
          setCallStateRetryable(
            error instanceof CallRequestError ? error.retryable : error instanceof TypeError
          );
          if (shouldRetry) {
            retryTimeoutId = setTimeout(() => {
              retryTimeoutId = null;
              loadState(attempt + 1);
            }, INITIAL_STATE_RETRY_MS);
          }
        });
    };

    loadState(0);

    return () => {
      cancelled = true;
      controller.abort();
      if (retryTimeoutId !== null) {
        clearTimeout(retryTimeoutId);
      }
    };
  }, [applyState, beginStateRequest, callSessionId, performStateRequest, shouldApplyStateResponse]);

  useEffect(() => {
    if (!callSessionId || !keepAliveEnabled) {
      return;
    }

    let cancelled = false;
    let activeController: AbortController | null = null;
    let startupTimerId: number | null = null;
    const startupStartedAt = Date.now();
    const startupSettled = () => {
      const status = latestCallStatusRef.current;
      return status !== null && STARTUP_SETTLED_CALL_STATUSES.has(status);
    };
    const scheduleStartupTick = () => {
      if (
        cancelled ||
        startupSettled() ||
        Date.now() - startupStartedAt >= STARTUP_RECONCILIATION_MAX_MS ||
        startupTimerId !== null
      ) {
        return;
      }
      startupTimerId = window.setTimeout(() => {
        startupTimerId = null;
        void tick(true);
      }, STARTUP_RECONCILIATION_INTERVAL_MS);
    };
    const tick = async (startup = false) => {
      if (cancelled) {
        return;
      }
      if (startup && startupSettled()) {
        return;
      }
      if (stateRequestsInFlightRef.current > 0 || modeMutationPendingRef.current) {
        if (startup) {
          scheduleStartupTick();
        }
        return;
      }
      activeController = new AbortController();
      const requestGeneration = beginStateRequest();
      const blockedByModeMutation = modeMutationPendingRef.current;
      try {
        const next = await performStateRequest(
          'POST',
          callSessionId,
          { touch: true },
          activeController.signal
        );
        if (cancelled || !shouldApplyStateResponse(requestGeneration, blockedByModeMutation)) {
          return;
        }
        applyState(next);
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (isAbortError(error)) {
          return;
        }
        setCallStateError(formatCallSessionStateError(error, 'Call session keepalive failed.'));
        setCallStateIssue(
          error instanceof CallRequestError
            ? { kind: error.code, message: error.message }
            : error instanceof TypeError
              ? {
                  kind: 'gateway_down',
                  message: formatCallSessionStateError(error, 'Call session keepalive failed.'),
                }
              : {
                  kind: 'unknown',
                  message: formatCallSessionStateError(error, 'Call session keepalive failed.'),
                }
        );
        setCallStateRetryable(
          error instanceof CallRequestError ? error.retryable : error instanceof TypeError
        );
      } finally {
        activeController = null;
        if (startup) {
          scheduleStartupTick();
        }
      }
    };

    scheduleStartupTick();
    const intervalId = window.setInterval(() => {
      void tick(false);
    }, KEEPALIVE_INTERVAL_MS);

    return () => {
      cancelled = true;
      activeController?.abort();
      if (startupTimerId !== null) {
        window.clearTimeout(startupTimerId);
      }
      window.clearInterval(intervalId);
    };
  }, [
    applyState,
    beginStateRequest,
    callSessionId,
    keepAliveEnabled,
    performStateRequest,
    shouldApplyStateResponse,
  ]);

  const setMode = useCallback(
    async (nextMode: VoiceCallMode) => {
      if (!callSessionId) {
        return false;
      }

      setModePending(true);
      setWingModePending(nextMode === 'wing' || mode === 'wing');
      setListenOnlyModePending(nextMode === 'listen_only' || mode === 'listen_only');
      modeMutationPendingRef.current = true;
      try {
        const next = await syncState({
          touch: true,
          mode: nextMode,
          wingModeEnabled: nextMode === 'wing',
          listenOnlyModeEnabled: nextMode === 'listen_only',
        });
        if (next?.mode === nextMode && next.authoritativeCallState?.mode === nextMode) {
          setLastModeTransition(next.authoritativeCallState);
        }
        return next?.mode === nextMode;
      } catch (error) {
        const message = formatCallSessionStateError(error, 'Call mode update failed.');
        setCallStateError(message);
        setCallStateIssue(
          error instanceof CallRequestError
            ? { kind: error.code, message: error.message }
            : error instanceof TypeError
              ? { kind: 'gateway_down', message }
              : { kind: 'unknown', message }
        );
        setCallStateRetryable(
          error instanceof CallRequestError ? error.retryable : error instanceof TypeError
        );
        return false;
      } finally {
        modeMutationPendingRef.current = false;
        setModePending(false);
        setWingModePending(false);
        setListenOnlyModePending(false);
      }
    },
    [callSessionId, mode, syncState]
  );

  const setWingModeEnabled = useCallback(
    async (enabled: boolean) => setMode(enabled ? 'wing' : 'call'),
    [setMode]
  );

  const setListenOnlyModeEnabled = useCallback(
    async (enabled: boolean) => {
      return setMode(enabled ? 'listen_only' : 'call');
    },
    [setMode]
  );

  return {
    mode,
    modePending,
    wingModeEnabled,
    wingModePending,
    listenOnlyModeEnabled,
    listenOnlyModePending,
    callStateError,
    callStateIssue,
    callStateRetryable,
    lastModeTransition,
    setMode,
    setWingModeEnabled,
    setListenOnlyModeEnabled,
  };
}
