'use client';

import * as React from 'react';
import {
  callBrowserCapabilityHeaders,
  clearCallBrowserCapability,
} from '@/lib/call-browser-capability';

const END_RETRY_DELAYS_MS = [0, 300, 900, 2_000];
const END_ATTEMPT_TIMEOUT_MS = 5_000;

export async function endCallSessionWithRetry(
  callSessionId: string,
  {
    fetchImpl = fetch,
    wait = (delayMs: number) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
    clearCapability = () => clearCallBrowserCapability(callSessionId),
    attemptTimeoutMs = END_ATTEMPT_TIMEOUT_MS,
  }: {
    fetchImpl?: typeof fetch;
    wait?: (delayMs: number) => Promise<unknown>;
    clearCapability?: () => void;
    attemptTimeoutMs?: number;
  } = {}
): Promise<boolean> {
  for (let attempt = 0; attempt < END_RETRY_DELAYS_MS.length; attempt += 1) {
    if (END_RETRY_DELAYS_MS[attempt] > 0) await wait(END_RETRY_DELAYS_MS[attempt]);
    const attemptController = new AbortController();
    const timeout = window.setTimeout(
      () => attemptController.abort(),
      Math.max(1, Math.min(attemptTimeoutMs, END_ATTEMPT_TIMEOUT_MS))
    );
    try {
      const response = await fetchImpl('/api/call-session-state', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...callBrowserCapabilityHeaders(callSessionId),
        },
        body: JSON.stringify({ callSessionId, status: 'ended', touch: false }),
        cache: 'no-store',
        keepalive: true,
        signal: attemptController.signal,
      });
      // Keep the bounded call capability after a confirmed end so refresh can render the durable
      // terminal state. Clear only a bearer the server has already rejected as terminal.
      if (response.ok) {
        return true;
      }
      if (response.status === 410) {
        clearCapability();
        return true;
      }
      if (![408, 429].includes(response.status) && response.status < 500) return false;
    } catch {
      // Retry bounded transient network errors while this call page remains alive.
    } finally {
      window.clearTimeout(timeout);
    }
  }
  return false;
}

export function useCallEndLifecycle({
  callSessionId,
  onEnded,
}: {
  callSessionId: string | null;
  onEnded: () => void;
}) {
  const endedTransitionSentRef = React.useRef(false);
  const endingRef = React.useRef(false);

  const markEnded = React.useCallback(() => {
    if (!callSessionId || endedTransitionSentRef.current) {
      return false;
    }
    endedTransitionSentRef.current = true;
    void endCallSessionWithRetry(callSessionId);
    return true;
  }, [callSessionId]);

  const notifyEnded = React.useCallback(() => {
    markEnded();
    onEnded();
  }, [markEnded, onEnded]);

  return React.useCallback(
    (endAudio: () => Promise<unknown>) => {
      if (endingRef.current) {
        return;
      }
      endingRef.current = true;
      // Start the durable terminal transition before tearing down the room. This lets the bound
      // worker observe `ended`, while the transport still closes without waiting on the network.
      notifyEnded();
      void Promise.resolve()
        .then(endAudio)
        .catch(() => undefined);
    },
    [notifyEnded]
  );
}
