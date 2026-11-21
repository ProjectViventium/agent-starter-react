import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UseSessionReturn } from '@livekit/components-react';
import { act, renderHook } from '@testing-library/react';
import { useCallStatePublish } from '@/hooks/useCallStatePublish';
import { VIVENTIUM_CALL_STATE_TOPIC, type VoiceCallStateV1 } from '@/lib/call-state';

function transition(revision: number, changed: Partial<VoiceCallStateV1> = {}): VoiceCallStateV1 {
  return {
    version: 1,
    callSessionId: 'call-1',
    mode: 'wing',
    status: 'listening',
    revision,
    updatedAt: '2026-11-10T00:00:00.000Z',
    ...changed,
  };
}

function fakeSession(isConnected: boolean, publishData = vi.fn(async () => undefined)) {
  return {
    session: {
      isConnected,
      room: { localParticipant: { publishData } },
    } as unknown as UseSessionReturn,
    publishData,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('telling the voice agent the call mode', () => {
  it('sends each confirmed change once, on the call-state topic', async () => {
    const { session, publishData } = fakeSession(true);
    const first = transition(1);
    const { rerender } = renderHook(
      ({ state }: { state: VoiceCallStateV1 | null }) =>
        useCallStatePublish(session, 'call-1', state),
      { initialProps: { state: first } }
    );
    await vi.waitFor(() => expect(publishData).toHaveBeenCalledTimes(1));
    const [payload, options] = publishData.mock.calls[0] as unknown as [
      Uint8Array,
      { topic: string },
    ];
    expect(options).toEqual({ topic: VIVENTIUM_CALL_STATE_TOPIC });
    expect(JSON.parse(new TextDecoder().decode(payload))).toEqual(first);

    // Once delivered, the same revision (even as a new object) is not sent again.
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ state: transition(1) });
    await act(async () => {
      await Promise.resolve();
    });
    expect(publishData).toHaveBeenCalledTimes(1);

    rerender({ state: transition(2, { mode: 'listen_only' }) });
    await vi.waitFor(() => expect(publishData).toHaveBeenCalledTimes(2));
  });

  it('waits until the call is connected', async () => {
    const publishData = vi.fn(async () => undefined);
    const { rerender } = renderHook(
      ({ connected }: { connected: boolean }) =>
        useCallStatePublish(fakeSession(connected, publishData).session, 'call-1', transition(3)),
      { initialProps: { connected: false } }
    );
    await Promise.resolve();
    expect(publishData).not.toHaveBeenCalled();
    rerender({ connected: true });
    await vi.waitFor(() => expect(publishData).toHaveBeenCalledTimes(1));
  });

  it('ignores a change that belongs to another call', async () => {
    const { session, publishData } = fakeSession(true);
    renderHook(() =>
      useCallStatePublish(session, 'call-1', transition(1, { callSessionId: 'call-2' }))
    );
    await Promise.resolve();
    expect(publishData).not.toHaveBeenCalled();
  });

  it('tries three times, 250 ms and 500 ms apart, then gives up with a warning', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const publishData = vi.fn(async () => {
      throw new Error('Synthetic data channel failure');
    });
    const { session } = fakeSession(true, publishData);
    const state = transition(1);
    renderHook(() => useCallStatePublish(session, 'call-1', state));
    await vi.advanceTimersByTimeAsync(0);
    expect(publishData).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(publishData).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(publishData).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(publishData).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledOnce();
  });
});
