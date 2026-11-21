import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCallMicrophoneEnabled, saveCallMicrophoneEnabled } from '@/lib/microphone-start';

afterEach(() => {
  window.sessionStorage.clear();
});

describe('scoped explicit microphone choice', () => {
  it('uses exact call scope and ignores malformed stored values and IDs', () => {
    saveCallMicrophoneEnabled('call-current', false);
    expect(readCallMicrophoneEnabled('call-current')).toBe(false);
    expect(readCallMicrophoneEnabled('call-other')).toBeNull();
    saveCallMicrophoneEnabled('invalid/call', false);
    expect(readCallMicrophoneEnabled('invalid/call')).toBeNull();
    window.sessionStorage.setItem(
      'viventium.call.microphone-enabled.v1:call-current',
      '{"enabled":false}'
    );
    expect(readCallMicrophoneEnabled('call-current')).toBeNull();
    expect(readCallMicrophoneEnabled(null)).toBeNull();
  });
  it('does not block controls when session storage is denied', async () => {
    const getItem = vi.fn(() => {
      throw new Error('Storage blocked');
    });
    const setItem = vi.fn(() => {
      throw new Error('Storage blocked');
    });
    expect(readCallMicrophoneEnabled('call-current', { getItem })).toBeNull();
    expect(() => saveCallMicrophoneEnabled('call-current', false, { setItem })).not.toThrow();
  });

  // The writer of this choice is the control-bar microphone toggle (`useCallInputControls`);
  // its tests are in `hooks/useCallInputControls.test.tsx`.
});
