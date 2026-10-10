import { Track } from 'livekit-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useInputControls } from '@/components/livekit/agent-control-bar/hooks/use-input-controls';
import { readCallMicrophoneEnabled, saveCallMicrophoneEnabled } from '@/lib/microphone-start';

const state = vi.hoisted(() => ({ enabled: true, toggle: vi.fn(), save: vi.fn() }));
vi.mock('@livekit/components-react', () => ({
  useLocalParticipant: () => ({ localParticipant: {} }),
  useTrackToggle: ({ source }: { source: Track.Source }) => ({
    enabled: source === 'microphone' && state.enabled,
    toggle: state.toggle,
  }),
  usePersistentUserChoices: () => ({ saveAudioInputEnabled: state.save }),
}));
afterEach(() => {
  window.sessionStorage.clear();
  state.enabled = true;
  state.toggle.mockReset();
  state.save.mockReset();
});

describe('scoped explicit microphone choice', () => {
  it('does not save a failed microphone toggle', async () => {
    state.toggle.mockRejectedValue(new Error('Synthetic toggle failure'));
    const { result } = renderHook(() => useInputControls({ callSessionId: 'call-current' }));
    await act(async () => {
      await expect(result.current.microphoneToggle.toggle(false)).rejects.toThrow(
        'Synthetic toggle failure'
      );
    });
    expect(readCallMicrophoneEnabled('call-current')).toBeNull();
    expect(state.save).not.toHaveBeenCalled();
  });
  it('keeps an explicit requested enabled value when the mic is already enabled', async () => {
    state.toggle.mockResolvedValue(undefined);
    const { result } = renderHook(() => useInputControls({ callSessionId: 'call-current' }));
    await act(async () => {
      await result.current.microphoneToggle.toggle(true);
    });
    expect(readCallMicrophoneEnabled('call-current')).toBe(true);
    expect(state.save).toHaveBeenCalledWith(true);
  });
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
  it('respects disabled choice persistence', async () => {
    state.toggle.mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useInputControls({ callSessionId: 'call-current', saveUserChoices: false })
    );
    await act(async () => {
      await result.current.microphoneToggle.toggle(false);
    });
    expect(readCallMicrophoneEnabled('call-current')).toBeNull();
  });
});
