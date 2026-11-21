import { StrictMode } from 'react';
import { ConnectionState, RoomEvent } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseSessionReturn } from '@livekit/components-react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type UseCallStartOptions, useCallStart } from '@/hooks/useCallStart';
import type { CallTokenSource } from '@/lib/call-token-source';
import { saveCallMicrophoneEnabled } from '@/lib/microphone-start';

const CALL = 'call-start';

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Every step of a start, in the order it happened. */
let steps: string[];

function microphoneTrack(echoCancellation: boolean | undefined = true) {
  return {
    stop: vi.fn(() => steps.push('capture stopped')),
    mediaStreamTrack: { getSettings: () => ({ echoCancellation }) },
  };
}

function fakeCall() {
  const listeners = new Map<string, Set<() => void>>();
  const captured = microphoneTrack();
  const room = {
    options: {} as { audioCaptureDefaults?: Record<string, unknown> },
    on: vi.fn((event: string, listener: () => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(listener);
    }),
    off: vi.fn((event: string, listener: () => void) => listeners.get(event)?.delete(listener)),
    emit: (event: string) => listeners.get(event)?.forEach((listener) => listener()),
    startAudio: vi.fn(async () => {
      steps.push('sound started');
    }),
    localParticipant: {
      createTracks: vi.fn(async () => {
        steps.push('microphone captured');
        return [captured];
      }),
      setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
        steps.push(enabled ? 'microphone published' : 'microphone off');
        return enabled ? { track: microphoneTrack() } : undefined;
      }),
    },
  };
  const session = {
    room,
    isConnected: false,
    connectionState: ConnectionState.Disconnected,
    start: vi.fn(async () => {
      steps.push('room connected');
    }),
    end: vi.fn(async () => {
      steps.push('room left');
    }),
  };
  let ending = false;
  const tokens = {
    tokenSource: {},
    callSessionId: CALL,
    fetchForStart: vi.fn(async (retry: boolean) => {
      steps.push(retry ? 'call requested again' : 'call requested');
      return {};
    }),
    markEnding: () => {
      ending = true;
    },
    isEnding: () => ending,
  };
  const options = (changed: Partial<UseCallStartOptions> = {}): UseCallStartOptions => ({
    session: session as unknown as UseSessionReturn,
    tokens: tokens as unknown as CallTokenSource,
    callSessionId: CALL,
    soundMode: 'standard',
    ended: false,
    autoStart: false,
    ...changed,
  });
  return { room, session, tokens, captured, options };
}

beforeEach(() => {
  steps = [];
  window.sessionStorage.setItem(`viventium.call.capability.v1:${CALL}`, 'c'.repeat(43));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe('start order', () => {
  it('asks for the microphone, then the call, connects muted, publishes, then starts sound', async () => {
    const call = fakeCall();
    const { result } = renderHook(() => useCallStart(call.options()));
    let started = false;
    await act(async () => {
      started = await result.current.startCall();
    });
    expect(started).toBe(true);
    expect(steps).toEqual([
      'microphone captured',
      'call requested',
      'room connected',
      'capture stopped',
      'microphone published',
      'sound started',
    ]);
    expect(call.session.start).toHaveBeenCalledWith(
      expect.objectContaining({ tracks: { microphone: { enabled: false } } })
    );
    expect(result.current.isStarting).toBe(false);
    expect(result.current.startError).toBeNull();
  });

  it('reports a refused microphone before the server is asked for the call', async () => {
    const call = fakeCall();
    call.room.localParticipant.createTracks.mockRejectedValue(
      Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' })
    );
    const { result } = renderHook(() => useCallStart(call.options()));
    await act(async () => {
      expect(await result.current.startCall()).toBe(false);
    });
    expect(result.current.startError).toMatchObject({ kind: 'mic_denied' });
    expect(call.tokens.fetchForStart).not.toHaveBeenCalled();
    expect(call.session.start).not.toHaveBeenCalled();
  });

  it('does not ask the server while the browser permission prompt is still open', async () => {
    const call = fakeCall();
    const prompt = deferred<ReturnType<typeof microphoneTrack>[]>();
    call.room.localParticipant.createTracks.mockReturnValue(prompt.promise);
    const { result } = renderHook(() => useCallStart(call.options()));
    act(() => void result.current.startCall());
    await waitFor(() => expect(result.current.isMicrophoneStarting).toBe(true));
    expect(result.current.isStarting).toBe(true);
    expect(call.tokens.fetchForStart).not.toHaveBeenCalled();
    await act(async () => prompt.resolve([call.captured]));
    await waitFor(() => expect(result.current.isStarting).toBe(false));
    expect(call.tokens.fetchForStart).toHaveBeenCalledOnce();
  });

  it('keeps the failure and leaves the room when the microphone cannot be published', async () => {
    const call = fakeCall();
    call.room.localParticipant.setMicrophoneEnabled.mockImplementation(async (enabled: boolean) => {
      if (enabled) throw new Error('Synthetic publish failure');
      return undefined;
    });
    const { result } = renderHook(() => useCallStart(call.options()));
    await act(async () => {
      expect(await result.current.startCall()).toBe(false);
    });
    expect(call.session.end).toHaveBeenCalledOnce();
    expect(result.current.startError?.message).toBe('Synthetic publish failure');
  });
});

describe('microphone memory of this call', () => {
  it('starts a call the user muted without touching the microphone', async () => {
    saveCallMicrophoneEnabled(CALL, false);
    const call = fakeCall();
    const { result } = renderHook(() => useCallStart(call.options()));
    await act(async () => {
      await result.current.startCall();
    });
    expect(steps).toEqual(['call requested', 'room connected', 'sound started']);
    expect(call.room.localParticipant.createTracks).not.toHaveBeenCalled();
    expect(call.room.localParticipant.setMicrophoneEnabled).not.toHaveBeenCalled();
  });

  it('starts another call unmuted', async () => {
    saveCallMicrophoneEnabled('call-earlier', false);
    const call = fakeCall();
    const { result } = renderHook(() => useCallStart(call.options()));
    await act(async () => {
      await result.current.startCall();
    });
    expect(steps).toContain('microphone published');
  });
});

describe('one attempt at a time', () => {
  it('shares an in-flight start with a concurrent caller', async () => {
    const call = fakeCall();
    const connecting = deferred();
    call.session.start.mockReturnValue(connecting.promise);
    const { result } = renderHook(() => useCallStart(call.options()));
    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.startCall();
      second = result.current.startCall();
    });
    expect(second).toBe(first);
    await act(async () => {
      connecting.resolve();
      await first;
    });
    expect(call.room.localParticipant.createTracks).toHaveBeenCalledOnce();
    expect(call.tokens.fetchForStart).toHaveBeenCalledOnce();
  });

  it('asks the server again on a later Start (Retry)', async () => {
    const call = fakeCall();
    const { result } = renderHook(() => useCallStart(call.options()));
    await act(async () => {
      await result.current.startCall();
    });
    await act(async () => {
      await result.current.startCall();
    });
    expect(call.tokens.fetchForStart.mock.calls).toEqual([[false], [true]]);
  });
});

describe('a call that is over', () => {
  it('refuses to start an ended call', async () => {
    const call = fakeCall();
    const { result } = renderHook(() => useCallStart(call.options({ ended: true })));
    await act(async () => {
      expect(await result.current.startCall()).toBe(false);
    });
    expect(result.current.startError).toEqual({
      kind: 'auth_expired',
      message: 'This call has ended. Start a fresh call from Viventium.',
    });
    expect(steps).toEqual([]);
  });

  it('refuses to restart a call the user is ending', async () => {
    const call = fakeCall();
    call.tokens.markEnding();
    const { result } = renderHook(() => useCallStart(call.options()));
    await act(async () => {
      expect(await result.current.startCall()).toBe(false);
    });
    expect(result.current.startError?.kind).toBe('auth_expired');
    expect(call.session.start).not.toHaveBeenCalled();
  });
});

describe('losing the room while starting', () => {
  it('gives up the microphone request and stops a microphone that arrives late', async () => {
    const call = fakeCall();
    const prompt = deferred<ReturnType<typeof microphoneTrack>[]>();
    call.room.localParticipant.createTracks.mockImplementation(async () => {
      const tracks = await prompt.promise;
      steps.push('microphone captured');
      return tracks;
    });
    const { result } = renderHook(() => useCallStart(call.options()));
    let attempt!: Promise<boolean>;
    act(() => {
      attempt = result.current.startCall();
    });
    await waitFor(() => expect(result.current.isMicrophoneStarting).toBe(true));
    await act(async () => {
      call.room.emit(RoomEvent.Disconnected);
      expect(await attempt).toBe(false);
    });
    expect(result.current.startError).toMatchObject({ kind: 'gateway_down', retryable: true });
    expect(call.tokens.fetchForStart).not.toHaveBeenCalled();

    await act(async () => prompt.resolve([call.captured]));
    expect(call.captured.stop).toHaveBeenCalled();
    expect(call.session.start).not.toHaveBeenCalled();
  });

  it('cancels a pending microphone request when the page really goes away', async () => {
    const call = fakeCall();
    const prompt = deferred<ReturnType<typeof microphoneTrack>[]>();
    call.room.localParticipant.createTracks.mockReturnValue(prompt.promise);
    const { result, unmount } = renderHook(() => useCallStart(call.options()));
    let attempt!: Promise<boolean>;
    act(() => {
      attempt = result.current.startCall();
    });
    await waitFor(() => expect(call.room.localParticipant.createTracks).toHaveBeenCalled());
    unmount();
    expect(await attempt).toBe(false);
    expect(call.tokens.fetchForStart).not.toHaveBeenCalled();
  });
});

describe('start from the link', () => {
  it('starts once without a click, also when React replays effects (Strict Mode)', async () => {
    const call = fakeCall();
    const { result } = renderHook(() => useCallStart(call.options({ autoStart: true })), {
      wrapper: StrictMode,
    });
    expect(result.current.isStarting).toBe(true);
    await waitFor(() => expect(steps).toContain('sound started'));
    await waitFor(() => expect(result.current.isStarting).toBe(false));
    expect(call.session.start).toHaveBeenCalledOnce();
    expect(call.tokens.fetchForStart).toHaveBeenCalledOnce();
  });

  it('waits until starting is allowed, then starts', async () => {
    const call = fakeCall();
    const { result, rerender } = renderHook(
      ({ autoStart }: { autoStart: boolean }) => useCallStart(call.options({ autoStart })),
      { initialProps: { autoStart: false } }
    );
    expect(result.current.isStarting).toBe(false);
    expect(call.session.start).not.toHaveBeenCalled();
    rerender({ autoStart: true });
    await waitFor(() => expect(call.session.start).toHaveBeenCalledOnce());
  });

  it('never starts a call that is already known to be ended', async () => {
    const call = fakeCall();
    const { result } = renderHook(() =>
      useCallStart(call.options({ autoStart: true, ended: true }))
    );
    await waitFor(() => expect(result.current.isStarting).toBe(false));
    expect(steps).toEqual([]);
  });
});

describe('sound on this device', () => {
  it('turns echo cancellation off for both captures in Earpiece mode and keeps the mode for the call', async () => {
    const call = fakeCall();
    call.room.localParticipant.createTracks.mockResolvedValue([microphoneTrack(false)]);
    call.room.localParticipant.setMicrophoneEnabled.mockResolvedValue({
      track: microphoneTrack(false),
    });
    const { result, rerender } = renderHook(
      ({ soundMode }: { soundMode: 'standard' | 'earpiece' }) =>
        useCallStart(call.options({ soundMode })),
      { initialProps: { soundMode: 'earpiece' } }
    );
    await act(async () => {
      expect(await result.current.startCall()).toBe(true);
    });
    expect(call.room.options.audioCaptureDefaults).toMatchObject({ echoCancellation: false });
    expect(result.current.activeSoundMode).toBe('earpiece');

    // A later change of the preference does not touch this call.
    rerender({ soundMode: 'standard' });
    await act(async () => {
      await result.current.startCall();
    });
    expect(result.current.activeSoundMode).toBe('earpiece');
  });

  it('does not start the call when the browser cannot honour Earpiece', async () => {
    const call = fakeCall();
    call.room.localParticipant.createTracks.mockResolvedValue([microphoneTrack(true)]);
    const { result } = renderHook(() => useCallStart(call.options({ soundMode: 'earpiece' })));
    await act(async () => {
      expect(await result.current.startCall()).toBe(false);
    });
    expect(result.current.startError?.message).toContain('Select Speaker');
    expect(call.tokens.fetchForStart).not.toHaveBeenCalled();
    expect(call.session.start).not.toHaveBeenCalled();
  });

  it('leaves the room and turns the microphone off when the published track is not in Earpiece mode', async () => {
    const call = fakeCall();
    call.room.localParticipant.createTracks.mockResolvedValue([microphoneTrack(false)]);
    call.room.localParticipant.setMicrophoneEnabled.mockImplementation(async (enabled: boolean) => {
      steps.push(enabled ? 'microphone published' : 'microphone off');
      return enabled ? { track: microphoneTrack(true) } : undefined;
    });
    const { result } = renderHook(() => useCallStart(call.options({ soundMode: 'earpiece' })));
    await act(async () => {
      expect(await result.current.startCall()).toBe(false);
    });
    expect(steps).toContain('microphone off');
    expect(call.session.end).toHaveBeenCalledOnce();
  });
});

describe('call authority changes during startup', () => {
  it('rejects expired authority without acquiring a device or requesting a token', async () => {
    const call = fakeCall();
    const { result } = renderHook(() =>
      useCallStart(
        call.options({
          authorityIssue: { kind: 'auth_expired', message: 'Synthetic expired call.' },
        })
      )
    );
    await act(async () => expect(await result.current.startCall()).toBe(false));
    expect(result.current.startError?.kind).toBe('auth_expired');
    expect(call.room.localParticipant.createTracks).not.toHaveBeenCalled();
    expect(call.tokens.fetchForStart).not.toHaveBeenCalled();
    expect(call.session.start).not.toHaveBeenCalled();
  });

  it.each(['expiry', 'end'] as const)(
    'settles a pending permission on %s and disposes a late device without dispatch',
    async (change) => {
      const call = fakeCall();
      const prompt = deferred<ReturnType<typeof microphoneTrack>[]>();
      call.room.localParticipant.createTracks.mockReturnValue(prompt.promise);
      const { result, rerender } = renderHook(
        ({ blocked }: { blocked: boolean }) =>
          useCallStart(
            call.options({
              ended: blocked && change === 'end',
              authorityIssue:
                blocked && change === 'expiry'
                  ? { kind: 'auth_expired', message: 'Synthetic expired call.' }
                  : null,
            })
          ),
        { initialProps: { blocked: false } }
      );
      let attempt!: Promise<boolean>;
      act(() => {
        attempt = result.current.startCall();
      });
      await waitFor(() => expect(result.current.isMicrophoneStarting).toBe(true));
      rerender({ blocked: true });
      await act(async () => expect(await attempt).toBe(false));
      expect(result.current.isStarting).toBe(false);
      expect(result.current.isMicrophoneStarting).toBe(false);
      expect(result.current.startError?.kind).toBe('auth_expired');
      await act(async () => prompt.resolve([call.captured]));
      expect(call.captured.stop).toHaveBeenCalled();
      expect(call.tokens.fetchForStart).not.toHaveBeenCalled();
      expect(call.session.start).not.toHaveBeenCalled();
    }
  );
});
