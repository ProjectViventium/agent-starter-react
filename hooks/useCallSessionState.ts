'use client';

/* VIVENTIUM START
 * Purpose: Viventium agent-starter customization.
 * Feature: Call-session state hook for Wing Mode + keepalive
 *
 * Why:
 * - Keep active calls alive through long silence windows by periodically touching the call session.
 * - Expose a single persisted Wing Mode toggle for the modern playground.
 * VIVENTIUM END */
import { useCallback, useEffect, useState } from 'react';

const KEEPALIVE_INTERVAL_MS = 25_000;

type CallSessionStateResponse = {
  callSessionId?: string;
  roomName?: string;
  expiresAtMs?: number | null;
  wingModeEnabled?: boolean;
  shadowModeEnabled?: boolean;
  message?: string;
  error?: string;
};

export type UseCallSessionStateResult = {
  wingModeEnabled: boolean;
  wingModePending: boolean;
  callStateError: string | null;
  setWingModeEnabled: (enabled: boolean) => Promise<boolean>;
};

function normalizeResponse(payload: CallSessionStateResponse | null | undefined) {
  return {
    wingModeEnabled:
      payload?.wingModeEnabled === true ||
      (typeof payload?.wingModeEnabled !== 'boolean' && payload?.shadowModeEnabled === true),
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

export function useCallSessionState(
  callSessionId: string | null,
  keepAliveEnabled: boolean
): UseCallSessionStateResult {
  const [wingModeEnabled, setWingModeEnabledState] = useState(false);
  const [wingModePending, setWingModePending] = useState(false);
  const [callStateError, setCallStateError] = useState<string | null>(null);

  const syncState = useCallback(
    async (body?: Record<string, unknown>) => {
      if (!callSessionId) {
        return null;
      }
      const next = await requestCallSessionState(body ? 'POST' : 'GET', callSessionId, body);
      setWingModeEnabledState(next.wingModeEnabled);
      setCallStateError(next.message ?? null);
      return next;
    },
    [callSessionId]
  );

  useEffect(() => {
    if (!callSessionId) {
      setWingModeEnabledState(false);
      setWingModePending(false);
      setCallStateError(null);
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    requestCallSessionState('GET', callSessionId, undefined, controller.signal)
      .then((next) => {
        if (cancelled) {
          return;
        }
        setWingModeEnabledState(next.wingModeEnabled);
        setCallStateError(next.message ?? null);
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        if (isAbortError(error)) {
          return;
        }
        setCallStateError(error instanceof Error ? error.message : 'Call session check failed.');
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [callSessionId]);

  useEffect(() => {
    if (!callSessionId || !keepAliveEnabled) {
      return;
    }

    let cancelled = false;
    let activeController: AbortController | null = null;
    const tick = async () => {
      activeController?.abort();
      activeController = new AbortController();
      try {
        const next = await requestCallSessionState(
          'POST',
          callSessionId,
          { touch: true },
          activeController.signal
        );
        if (cancelled) {
          return;
        }
        setWingModeEnabledState(next.wingModeEnabled);
        setCallStateError(next.message ?? null);
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (isAbortError(error)) {
          return;
        }
        setCallStateError(
          error instanceof Error ? error.message : 'Call session keepalive failed.'
        );
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
  }, [callSessionId, keepAliveEnabled]);

  const setWingModeEnabled = useCallback(
    async (enabled: boolean) => {
      if (!callSessionId) {
        return false;
      }

      setWingModePending(true);
      try {
        const next = await syncState({ touch: true, wingModeEnabled: enabled });
        return next?.wingModeEnabled === enabled;
      } catch (error) {
        setCallStateError(error instanceof Error ? error.message : 'Wing Mode update failed.');
        return false;
      } finally {
        setWingModePending(false);
      }
    },
    [callSessionId, syncState]
  );

  return {
    wingModeEnabled,
    wingModePending,
    callStateError,
    setWingModeEnabled,
  };
}
