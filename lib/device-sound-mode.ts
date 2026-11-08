import type { AudioCaptureOptions } from 'livekit-client';
import type { DeviceSoundMode } from '@/hooks/useDeviceSoundMode';

/** Preserve the SDK's device and processing defaults; only echo control changes. */
export function deviceSoundCaptureOptions(
  defaults: AudioCaptureOptions,
  mode: DeviceSoundMode
): AudioCaptureOptions {
  return {
    ...defaults,
    deviceId: defaults.deviceId ?? { ideal: 'default' },
    echoCancellation: mode === 'standard',
  };
}

export function verifyDeviceSoundCapture(
  mode: DeviceSoundMode,
  track?: { mediaStreamTrack: { getSettings(): MediaTrackSettings } } | null
) {
  if (mode !== 'earpiece') return;
  if (!track) throw new Error('No microphone was available. Start the call again.');
  const echoCancellation = track.mediaStreamTrack.getSettings().echoCancellation;
  if (echoCancellation === false) return;
  throw new Error(
    echoCancellation === true
      ? 'This browser could not enable earpiece mode. Select Speaker, then start a new call.'
      : 'This browser cannot confirm earpiece mode. Select Speaker, then start a new call.'
  );
}
