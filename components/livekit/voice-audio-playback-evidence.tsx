'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

type AudioPlaybackEvidence = {
  confirmed: boolean;
  elementMuted: boolean;
  elementVolume: number;
  elementPaused: boolean;
  elementReadyState: number;
  elementCurrentTime: number;
  trackId: string | null;
  trackEnabled: boolean | null;
  trackMuted: boolean | null;
  trackReadyState: MediaStreamTrackState | null;
};

function readAudioPlaybackEvidence(element: HTMLAudioElement): AudioPlaybackEvidence {
  const mediaStream = element.srcObject as
    | (MediaProvider & {
        getAudioTracks?: () => MediaStreamTrack[];
      })
    | null;
  const audioTrack =
    mediaStream && typeof mediaStream.getAudioTracks === 'function'
      ? mediaStream.getAudioTracks()[0]
      : undefined;
  const evidence = {
    elementMuted: element.muted,
    elementVolume: element.volume,
    elementPaused: element.paused,
    elementReadyState: element.readyState,
    elementCurrentTime: element.currentTime,
    trackId: audioTrack?.id ?? null,
    trackEnabled: audioTrack?.enabled ?? null,
    trackMuted: audioTrack?.muted ?? null,
    trackReadyState: audioTrack?.readyState ?? null,
  };

  return {
    confirmed:
      evidence.elementMuted === false &&
      evidence.elementVolume > 0 &&
      evidence.elementPaused === false &&
      evidence.elementReadyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
      evidence.elementCurrentTime > 0 &&
      evidence.trackEnabled === true &&
      evidence.trackMuted === false &&
      evidence.trackReadyState === 'live',
    ...evidence,
  };
}

export function VoiceAudioPlaybackEvidence({
  children,
  resetKey,
}: {
  children?: React.ReactNode;
  resetKey: string;
}) {
  const [evidence, setEvidence] = useState<AudioPlaybackEvidence | null>(null);
  const confirmedRef = useRef(false);

  useEffect(() => {
    confirmedRef.current = false;
    setEvidence(null);
  }, [resetKey]);

  const observePlayback = useCallback((event: React.SyntheticEvent<HTMLDivElement>) => {
    if (confirmedRef.current || !(event.target instanceof HTMLAudioElement)) {
      return;
    }
    const nextEvidence = readAudioPlaybackEvidence(event.target);
    setEvidence(nextEvidence);
    if (!nextEvidence.confirmed) {
      return;
    }

    confirmedRef.current = true;
    const browserEvidence: Partial<AudioPlaybackEvidence> = { ...nextEvidence };
    delete browserEvidence.confirmed;
    console.info(
      `[ViventiumVoiceAudio] ${JSON.stringify({
        event: 'remote_audio_playback_confirmed',
        ...browserEvidence,
      })}`
    );
  }, []);

  return (
    <div
      style={{ display: 'contents' }}
      data-viventium-audio-proof-version="1"
      data-viventium-audio-playback={
        evidence?.confirmed ? 'confirmed' : evidence ? 'observed_unconfirmed' : 'idle'
      }
      data-viventium-audio-element-muted={evidence ? String(evidence.elementMuted) : undefined}
      data-viventium-audio-element-volume={evidence?.elementVolume}
      data-viventium-audio-element-paused={evidence ? String(evidence.elementPaused) : undefined}
      data-viventium-audio-ready-state={evidence?.elementReadyState}
      data-viventium-audio-current-time={evidence?.elementCurrentTime}
      data-viventium-audio-track-id={evidence?.trackId ?? undefined}
      data-viventium-audio-track-enabled={
        evidence?.trackEnabled == null ? undefined : String(evidence.trackEnabled)
      }
      data-viventium-audio-track-muted={
        evidence?.trackMuted == null ? undefined : String(evidence.trackMuted)
      }
      data-viventium-audio-track-ready-state={evidence?.trackReadyState ?? undefined}
      onPlayingCapture={observePlayback}
      onTimeUpdateCapture={observePlayback}
    >
      {children}
    </div>
  );
}
