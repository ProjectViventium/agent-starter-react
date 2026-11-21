import { Track } from 'livekit-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useCallInputControls } from '@/hooks/useCallInputControls';
import { readCallMicrophoneEnabled } from '@/lib/microphone-start';

const state = vi.hoisted(() => ({ enabled: true, toggle: vi.fn(), save: vi.fn() }));
vi.mock('@livekit/components-react', () => ({
  useSessionContext: () => ({ local: { microphoneTrack: undefined } }),
  useLocalParticipantPermissions: () => undefined,
  useTrackToggle: ({ source }: { source: Track.Source }) => ({
    enabled: source === 'microphone' && state.enabled,
    toggle: state.toggle,
  }),
  usePersistentUserChoices: () => ({
    saveAudioInputEnabled: state.save,
    saveVideoInputEnabled: vi.fn(),
    saveAudioInputDeviceId: vi.fn(),
    saveVideoInputDeviceId: vi.fn(),
  }),
}));

afterEach(() => {
  window.sessionStorage.clear();
  state.enabled = true;
  state.toggle.mockReset();
  state.save.mockReset();
});

// The per-call microphone memory (CP-CMP-038, seam S2): written by the control-bar toggle,
// read back by `useCallStart`.
describe('scoped explicit microphone choice', () => {
  it('remembers a mute for this call after the microphone really changed', async () => {
    state.toggle.mockResolvedValue(undefined);
    const { result } = renderHook(() => useCallInputControls({ callSessionId: 'call-current' }));
    await act(async () => {
      await result.current.microphoneToggle.toggle(false);
    });
    expect(state.toggle).toHaveBeenCalledWith(false);
    expect(readCallMicrophoneEnabled('call-current')).toBe(false);
    expect(readCallMicrophoneEnabled('call-other')).toBeNull();
  });

  it('does not save a failed microphone toggle', async () => {
    state.toggle.mockRejectedValue(new Error('Synthetic toggle failure'));
    const { result } = renderHook(() => useCallInputControls({ callSessionId: 'call-current' }));
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
    const { result } = renderHook(() => useCallInputControls({ callSessionId: 'call-current' }));
    await act(async () => {
      await result.current.microphoneToggle.toggle(true);
    });
    expect(readCallMicrophoneEnabled('call-current')).toBe(true);
  });

  it('saves the opposite of the current state for a plain toggle', async () => {
    state.toggle.mockResolvedValue(undefined);
    const { result } = renderHook(() => useCallInputControls({ callSessionId: 'call-current' }));
    await act(async () => {
      await result.current.microphoneToggle.toggle();
    });
    expect(readCallMicrophoneEnabled('call-current')).toBe(false);
  });

  it('respects disabled choice persistence', async () => {
    state.toggle.mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useCallInputControls({ callSessionId: 'call-current', saveUserChoices: false })
    );
    await act(async () => {
      await result.current.microphoneToggle.toggle(false);
    });
    expect(readCallMicrophoneEnabled('call-current')).toBeNull();
  });
});
