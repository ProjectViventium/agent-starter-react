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

const KEEPALIVE_INTERVAL_MS = 25_000;
const INITIAL_STATE_RETRY_MS = 1500;
const INITIAL_STATE_MAX_ATTEMPTS = 2;

type CallSessionStateResponse = {
  callSessionId?: string;
  roomName?: string;
  expiresAtMs?: number | null;
  wingModeEnabled?: boolean;
  shadowModeEnabled?: boolean;
  listenOnlyModeEnabled?: boolean;
  message?: string;
  error?: string;
};

export type UseCallSessionStateResult = {
  wingModeEnabled: boolean;
  wingModePending: boolean;
  listenOnlyModeEnabled: boolean;
  listenOnlyModePending: boolean;
  callStateError: string | null;
  setWingModeEnabled: (enabled: boolean) => Promise<boolean>;
  setListenOnlyModeEnabled: (enabled: boolean) => Promise<boolean>;
};

function normalizeResponse(payload: CallSessionStateResponse | null | undefined) {
  const listenOnlyModeEnabled = payload?.listenOnlyModeEnabled === true;
  return {
    wingModeEnabled:
      !listenOnlyModeEnabled &&
      (payload?.wingModeEnabled === true ||
        (typeof payload?.wingModeEnabled !== 'boolean' && payload?.shadowModeEnabled === true)),
    listenOnlyModeEnabled,
    expiresAtMs:
      typeof payload?.expiresAtMs === 'number' && Number.isFinite(payload.expiresAtMs)
        ? payload.expiresAtMs
        : null,
    message:
      typeof payload?.message === 'string' && payload.message.trim()
        ? payload.message.trim()
        : typeof payload?.error === 'string' && payload.error.trim()
          ? payload.error.trim()
          : null,
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

  const response = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
    },
    body:
      method === 'POST'
        ? JSON.stringify({
            callSessionId,
            ...(body ?? {}),
          })
        : undefined,
    cache: 'no-store',
    signal,
  });

  const payload = (await response.json().catch(() => ({}))) as CallSessionStateResponse;
  const normalized = normalizeResponse(payload);
  if (!response.ok) {
    throw new Error(normalized.message ?? `Call session request failed (${response.status}).`);
  }
  return normalized;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isLikelyFetchNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.trim().toLowerCase();
  return (
    message === 'failed to fetch' ||
    message === 'fetch failed' ||
    message === 'load failed' ||
    message.includes('networkerror')
  );
}

function formatCallSessionStateError(error: unknown, fallback: string, retrying = false): string {
  if (isLikelyFetchNetworkError(error)) {
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
  const [wingModeEnabled, setWingModeEnabledState] = useState(false);
  const [wingModePending, setWingModePending] = useState(false);
  const [listenOnlyModeEnabled, setListenOnlyModeEnabledState] = useState(false);
  const [listenOnlyModePending, setListenOnlyModePending] = useState(false);
  const [callStateError, setCallStateError] = useState<string | null>(null);
  const stateRequestGenerationRef = useRef(0);
  const modeMutationPendingRef = useRef(false);

  const applyState = useCallback((next: ReturnType<typeof normalizeResponse>) => {
    setWingModeEnabledState(next.wingModeEnabled);
    setListenOnlyModeEnabledState(next.listenOnlyModeEnabled);
    setCallStateError(next.message ?? null);
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

  const syncState = useCallback(
    async (body?: Record<string, unknown>) => {
      if (!callSessionId) {
        return null;
      }
      const requestGeneration = beginStateRequest();
      const next = await requestCallSessionState(body ? 'POST' : 'GET', callSessionId, body);
      if (!shouldApplyStateResponse(requestGeneration)) {
        return null;
      }
      applyState(next);
      return next;
    },
    [applyState, beginStateRequest, callSessionId, shouldApplyStateResponse]
  );

  useEffect(() => {
    if (!callSessionId) {
      setWingModeEnabledState(false);
      setWingModePending(false);
      setListenOnlyModeEnabledState(false);
      setListenOnlyModePending(false);
      setCallStateError(null);
      return;
    }

    let cancelled = false;
    let retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();
    const loadState = (attempt: number) => {
      const requestGeneration = beginStateRequest();
      const blockedByModeMutation = modeMutationPendingRef.current;
      requestCallSessionState('GET', callSessionId, undefined, controller.signal)
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
            isLikelyFetchNetworkError(error) && attempt + 1 < INITIAL_STATE_MAX_ATTEMPTS;
          setCallStateError(
            formatCallSessionStateError(error, 'Call session check failed.', shouldRetry)
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
  }, [applyState, beginStateRequest, callSessionId, shouldApplyStateResponse]);

  useEffect(() => {
    if (!callSessionId || !keepAliveEnabled) {
      return;
    }

    let cancelled = false;
    let activeController: AbortController | null = null;
    const tick = async () => {
      activeController?.abort();
      activeController = new AbortController();
      const requestGeneration = beginStateRequest();
      const blockedByModeMutation = modeMutationPendingRef.current;
      try {
        const next = await requestCallSessionState(
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
      }
    };

    void tick();
    const intervalId = window.setInterval(() => {
      void tick();
    }, KEEPALIVE_INTERVAL_MS);

    return () => {
      cancelled = true;
      activeController?.abort();
      window.clearInterval(intervalId);
    };
  }, [applyState, beginStateRequest, callSessionId, keepAliveEnabled, shouldApplyStateResponse]);

  const setWingModeEnabled = useCallback(
    async (enabled: boolean) => {
      if (!callSessionId) {
        return false;
      }

      setWingModePending(true);
      modeMutationPendingRef.current = true;
      try {
        const next = await syncState({ touch: true, wingModeEnabled: enabled });
        return next?.wingModeEnabled === enabled;
      } catch (error) {
        setCallStateError(formatCallSessionStateError(error, 'Wing Mode update failed.'));
        return false;
      } finally {
        modeMutationPendingRef.current = false;
        setWingModePending(false);
      }
    },
    [callSessionId, syncState]
  );

  const setListenOnlyModeEnabled = useCallback(
    async (enabled: boolean) => {
      if (!callSessionId) {
        return false;
      }

      setListenOnlyModePending(true);
      modeMutationPendingRef.current = true;
      try {
        const next = await syncState({ touch: true, listenOnlyModeEnabled: enabled });
        return next?.listenOnlyModeEnabled === enabled;
      } catch (error) {
        setCallStateError(formatCallSessionStateError(error, 'Listen-Only Mode update failed.'));
        return false;
      } finally {
        modeMutationPendingRef.current = false;
        setListenOnlyModePending(false);
      }
    },
    [callSessionId, syncState]
  );

  return {
    wingModeEnabled,
    wingModePending,
    listenOnlyModeEnabled,
    listenOnlyModePending,
    callStateError,
    setWingModeEnabled,
    setListenOnlyModeEnabled,
  };
}
