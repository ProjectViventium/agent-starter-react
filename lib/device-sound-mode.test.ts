import { describe, expect, it } from 'vitest';
import { deviceSoundCaptureOptions, verifyDeviceSoundCapture } from './device-sound-mode';

describe('device sound capture', () => {
  it('changes only echo control and retains the selected microphone and other processing', () => {
    const defaults = {
      deviceId: { exact: 'synthetic-mic' },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: true,
    };
    const quieter = deviceSoundCaptureOptions(defaults, 'earpiece');
    expect(quieter).toEqual({ ...defaults, echoCancellation: false });
    expect(defaults.echoCancellation).toBe(true);
    expect(deviceSoundCaptureOptions(quieter, 'standard')).toEqual(defaults);
  });
  it('keeps a device constraint so SDK reacquisition does not discard echo control', () => {
    expect(deviceSoundCaptureOptions({}, 'earpiece')).toEqual({
      deviceId: { ideal: 'default' },
      echoCancellation: false,
    });
  });
  it.each([true, undefined])(
    'does not claim earpiece mode when effective echo control is %s',
    (echoCancellation) => {
      expect(() =>
        verifyDeviceSoundCapture('earpiece', {
          mediaStreamTrack: { getSettings: () => ({ echoCancellation }) },
        })
      ).toThrow(echoCancellation === true ? 'could not enable' : 'cannot confirm');
    }
  );
  it('accepts confirmed echo-off and does not gate standard capture on optional browser readback', () => {
    expect(() =>
      verifyDeviceSoundCapture('earpiece', {
        mediaStreamTrack: { getSettings: () => ({ echoCancellation: false }) },
      })
    ).not.toThrow();
    expect(() => verifyDeviceSoundCapture('standard')).not.toThrow();
  });
});
