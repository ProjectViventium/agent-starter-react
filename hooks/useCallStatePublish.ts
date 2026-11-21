'use client';

/*
 * Tells the voice agent the call's mode (seam S4, CP-CMP-008).
 *
 * Every mode change the server confirmed is sent once to the agent over the room's data
 * channel (`viventium.call.state.v1`), while connected, with up to three tries.
 */
import { useEffect, useRef } from 'react';
import type { UseSessionReturn } from '@livekit/components-react';
import { type VoiceCallStateV1, publishVoiceCallState } from '@/lib/call-state';

const RETRY_DELAYS_MS = [250, 500];

export function useCallStatePublish(
  session: UseSessionReturn,
  callSessionId: string | null,
  transition: VoiceCallStateV1 | null
): void {
  const publishedRef = useRef<{ callSessionId: string; revision: number } | null>(null);
  const { room, isConnected } = session;

  useEffect(() => {
    if (!transition || !callSessionId || transition.callSessionId !== callSessionId) return;
    if (!isConnected) return;
    const published = publishedRef.current;
    if (
      published?.callSessionId === transition.callSessionId &&
      published.revision >= transition.revision
    ) {
      return;
    }
    let cancelled = false;
    let retryTimer: number | null = null;
    const publish = (attempt: number) => {
      publishVoiceCallState(room.localParticipant, transition)
        .then(() => {
          if (!cancelled) {
            publishedRef.current = {
              callSessionId: transition.callSessionId,
              revision: transition.revision,
            };
          }
        })
        .catch((error) => {
          if (cancelled) return;
          if (attempt < RETRY_DELAYS_MS.length) {
            retryTimer = window.setTimeout(() => publish(attempt + 1), RETRY_DELAYS_MS[attempt]);
          } else {
            console.warn('[Viventium] The call mode did not reach the voice agent:', error);
          }
        });
    };
    publish(0);
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [callSessionId, isConnected, room, transition]);
}
