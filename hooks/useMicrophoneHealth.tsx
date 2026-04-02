'use client';

/* VIVENTIUM START
 * Feature: Microphone health monitoring for live voice calls
 * Added: 2026-03-10
 *
 * Purpose:
 * - Detect when the browser/session stays connected but the local microphone stops
 *   sending audio, which otherwise looks like a transcription outage.
 * - Keep non-intrusive session state so the UI can distinguish a blocked mic from a dispatch bug
 *   without forcing banners or toasts.
 * VIVENTIUM END */
import { useMemo } from 'react';
import { useLocalParticipant, useSessionContext } from '@livekit/components-react';

export interface MicrophoneHealthState {
  issue: string | null;
  isInputBlocked: boolean;
}

function normalizeMicErrorMessage(message: string | undefined): string {
  const trimmed = (message || '').trim();
  if (!trimmed) {
    return 'Microphone is unavailable.';
  }
  return trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
}

export function useMicrophoneHealth(): MicrophoneHealthState {
  const { isConnected } = useSessionContext();
  const { isMicrophoneEnabled, microphoneTrack, lastMicrophoneError } = useLocalParticipant();

  const issue = useMemo(() => {
    if (!isConnected) {
      return null;
    }
    if (lastMicrophoneError) {
      return normalizeMicErrorMessage(lastMicrophoneError.message);
    }
    if (!isMicrophoneEnabled) {
      return 'Microphone is muted.';
    }
    if (microphoneTrack?.isMuted) {
      return 'Microphone track stopped sending audio.';
    }
    return null;
  }, [isConnected, isMicrophoneEnabled, lastMicrophoneError, microphoneTrack]);

  return {
    issue,
    isInputBlocked: Boolean(issue),
  };
}
