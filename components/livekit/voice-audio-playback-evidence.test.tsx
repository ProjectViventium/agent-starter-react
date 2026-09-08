import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { VoiceAudioPlaybackEvidence } from '@/components/livekit/voice-audio-playback-evidence';

type PlaybackState = {
  muted?: boolean;
  volume?: number;
  paused?: boolean;
  readyState?: number;
  currentTime?: number;
  trackId?: string;
  trackEnabled?: boolean;
  trackMuted?: boolean;
  trackReadyState?: MediaStreamTrackState;
};

function setPlaybackState(
  element: HTMLAudioElement,
  {
    muted = false,
    volume = 1,
    paused = false,
    readyState = 3,
    currentTime = 0.25,
    trackId = 'remote-audio-track',
    trackEnabled = true,
    trackMuted = false,
    trackReadyState = 'live',
  }: PlaybackState = {}
) {
  Object.defineProperties(element, {
    muted: { configurable: true, value: muted },
    volume: { configurable: true, value: volume },
    paused: { configurable: true, value: paused },
    readyState: { configurable: true, value: readyState },
    currentTime: { configurable: true, value: currentTime },
    srcObject: {
      configurable: true,
      value: {
        getAudioTracks: () => [
          {
            id: trackId,
            enabled: trackEnabled,
            muted: trackMuted,
            readyState: trackReadyState,
          },
        ],
      },
    },
  });
}

describe('VoiceAudioPlaybackEvidence', () => {
  it('confirms real remote audio playback only when the element and media track are audible', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { container } = render(
      <VoiceAudioPlaybackEvidence resetKey="call-one">
        <audio aria-label="Remote voice" />
      </VoiceAudioPlaybackEvidence>
    );
    const audio = screen.getByLabelText('Remote voice') as HTMLAudioElement;
    setPlaybackState(audio);

    fireEvent.playing(audio);

    const evidence = container.querySelector('[data-viventium-audio-proof-version="1"]');
    expect(evidence).toHaveAttribute('data-viventium-audio-playback', 'confirmed');
    expect(evidence).toHaveAttribute('data-viventium-audio-element-muted', 'false');
    expect(evidence).toHaveAttribute('data-viventium-audio-element-volume', '1');
    expect(evidence).toHaveAttribute('data-viventium-audio-element-paused', 'false');
    expect(evidence).toHaveAttribute('data-viventium-audio-ready-state', '3');
    expect(evidence).toHaveAttribute('data-viventium-audio-current-time', '0.25');
    expect(evidence).toHaveAttribute('data-viventium-audio-track-id', 'remote-audio-track');
    expect(evidence).toHaveAttribute('data-viventium-audio-track-enabled', 'true');
    expect(evidence).toHaveAttribute('data-viventium-audio-track-muted', 'false');
    expect(evidence).toHaveAttribute('data-viventium-audio-track-ready-state', 'live');
    expect(info).toHaveBeenCalledWith(
      '[ViventiumVoiceAudio] {"event":"remote_audio_playback_confirmed","elementMuted":false,"elementVolume":1,"elementPaused":false,"elementReadyState":3,"elementCurrentTime":0.25,"trackId":"remote-audio-track","trackEnabled":true,"trackMuted":false,"trackReadyState":"live"}'
    );
  });

  it.each<[string, PlaybackState]>([
    ['muted element', { muted: true }],
    ['zero-volume element', { volume: 0 }],
    ['paused element', { paused: true }],
    ['element without decoded data', { readyState: 1 }],
    ['element without playback progress', { currentTime: 0 }],
    ['disabled media track', { trackEnabled: false }],
    ['muted media track', { trackMuted: true }],
    ['ended media track', { trackReadyState: 'ended' }],
  ])('does not claim playback for a %s', (_label, state) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const { container } = render(
      <VoiceAudioPlaybackEvidence resetKey="call-unconfirmed">
        <audio aria-label="Unconfirmed remote voice" />
      </VoiceAudioPlaybackEvidence>
    );
    const audio = screen.getByLabelText('Unconfirmed remote voice') as HTMLAudioElement;
    setPlaybackState(audio, state);

    fireEvent.playing(audio);

    const evidence = container.querySelector('[data-viventium-audio-proof-version="1"]');
    expect(evidence).toHaveAttribute('data-viventium-audio-playback', 'observed_unconfirmed');
    expect(info).not.toHaveBeenCalled();
  });

  it('keeps confirmed evidence after the remote track element is removed', () => {
    const { container, rerender } = render(
      <VoiceAudioPlaybackEvidence resetKey="call-ended">
        <audio aria-label="Ending remote voice" />
      </VoiceAudioPlaybackEvidence>
    );
    const audio = screen.getByLabelText('Ending remote voice') as HTMLAudioElement;
    setPlaybackState(audio);
    fireEvent.playing(audio);

    rerender(<VoiceAudioPlaybackEvidence resetKey="call-ended" />);

    const evidence = container.querySelector('[data-viventium-audio-proof-version="1"]');
    expect(evidence).toHaveAttribute('data-viventium-audio-playback', 'confirmed');
    expect(container.querySelector('audio')).toBeNull();
  });

  it('clears stale playback evidence when the call identity changes', () => {
    const { container, rerender } = render(
      <VoiceAudioPlaybackEvidence resetKey="call-old">
        <audio aria-label="Old remote voice" />
      </VoiceAudioPlaybackEvidence>
    );
    const audio = screen.getByLabelText('Old remote voice') as HTMLAudioElement;
    setPlaybackState(audio);
    fireEvent.playing(audio);

    rerender(<VoiceAudioPlaybackEvidence resetKey="call-new" />);

    expect(container.querySelector('[data-viventium-audio-proof-version="1"]')).toHaveAttribute(
      'data-viventium-audio-playback',
      'idle'
    );
  });
});
