import { RoomEvent } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseSessionReturn } from '@livekit/components-react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useViventiumVoiceEvents } from '@/hooks/useViventiumVoiceEvents';
import {
  type SpeakerSegmentV1,
  VIVENTIUM_SPEAKER_TOPIC,
  VIVENTIUM_TASK_TOPIC,
  type VoiceTaskEventV1,
} from '@/lib/voice-events';

const packet = (payload: unknown) => new TextEncoder().encode(JSON.stringify(payload));
const agentParticipant = { isAgent: true, identity: 'agent-1' };
const guestParticipant = { isAgent: false, identity: 'guest-1' };
const expectedAgentIdentities = ['agent-1'];

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.startsWith('/api/call-speakers')
              ? { version: 1, segments: [] }
              : { version: 1, events: [] }
          ),
          { status: 200 }
        )
      )
    )
  );
});

function task(overrides: Partial<VoiceTaskEventV1> = {}): VoiceTaskEventV1 {
  return {
    version: 1,
    eventId: 'event-1',
    sequence: 1,
    emittedAt: '2026-08-09T12:00:00.000Z',
    callSessionId: 'call-1',
    taskId: 'task-1',
    type: 'state',
    state: 'running',
    cancellable: true,
    retryable: false,
    ...overrides,
  };
}

function segment(overrides: Partial<SpeakerSegmentV1> = {}): SpeakerSegmentV1 {
  return {
    version: 1,
    segmentId: 'segment-1',
    callSessionId: 'call-1',
    turnId: 'turn-1',
    sequence: 1,
    revision: 0,
    text: 'First pass',
    isFinal: false,
    speaker: {
      key: 'speaker-1',
      label: 'Speaker 1',
      source: 'provider_diarization',
      attribution: 'unverified',
      actorTrust: 'shared_mic_unverified',
    },
    ...overrides,
  };
}

function fakeSession() {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const room = {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) =>
      handlers.set(event, handler)
    ),
    off: vi.fn((event: string) => handlers.delete(event)),
  };
  return { room, handlers, session: { room } as unknown as UseSessionReturn };
}

describe('useViventiumVoiceEvents', () => {
  it('registers both versioned topics and applies task and speaker revisions', async () => {
    const { room, handlers, session } = fakeSession();
    const { result, unmount } = renderHook(() =>
      useViventiumVoiceEvents(session, 'call-1', expectedAgentIdentities)
    );

    expect(room.on).toHaveBeenCalledWith(RoomEvent.DataReceived, expect.any(Function));

    await act(async () => {
      handlers.get(RoomEvent.DataReceived)?.(
        packet(task()),
        agentParticipant,
        undefined,
        VIVENTIUM_TASK_TOPIC
      );
      handlers.get(RoomEvent.DataReceived)?.(
        packet(segment()),
        agentParticipant,
        undefined,
        VIVENTIUM_SPEAKER_TOPIC
      );
    });
    await waitFor(() => expect(result.current.tasks).toHaveLength(1));
    await waitFor(() => expect(result.current.speakerSegments[0]?.text).toBe('First pass'));

    await act(async () => {
      handlers.get(RoomEvent.DataReceived)?.(
        packet(task({ eventId: 'event-2', sequence: 2, state: 'completed' })),
        agentParticipant,
        undefined,
        VIVENTIUM_TASK_TOPIC
      );
      handlers.get(RoomEvent.DataReceived)?.(
        packet(segment({ revision: 1, text: 'Final words', isFinal: true })),
        agentParticipant,
        undefined,
        VIVENTIUM_SPEAKER_TOPIC
      );
    });
    await waitFor(() => expect(result.current.tasks[0]?.state).toBe('completed'));
    await waitFor(() => expect(result.current.speakerSegments[0]?.text).toBe('Final words'));

    unmount();
    expect(room.off).toHaveBeenCalledWith(RoomEvent.DataReceived, expect.any(Function));
  });

  it('applies an authoritative task-action response through the same bounded store', async () => {
    const { session } = fakeSession();
    const { result } = renderHook(() =>
      useViventiumVoiceEvents(session, 'call-1', expectedAgentIdentities)
    );
    await waitFor(() => expect(typeof result.current.applyAuthoritativeTaskEvent).toBe('function'));

    await act(async () => {
      result.current.applyAuthoritativeTaskEvent(
        task({
          eventId: 'cancel-recovering',
          sequence: 3,
          type: 'error',
          state: 'recovering',
          phase: 'cancel_barrier_recovering',
          label: 'Cancellation needs retry',
          cancellable: true,
          retryable: true,
          error: {
            code: 'cancel_barrier_unavailable',
            message: 'Cancellation could not be made durable.',
            retryable: true,
          },
        })
      );
    });

    await waitFor(() => expect(result.current.tasks[0]?.state).toBe('recovering'));
    expect(result.current.tasks[0]).toMatchObject({
      retryable: true,
      error: { code: 'cancel_barrier_unavailable', retryable: true },
    });
  });

  it('ignores malformed, duplicate, and out-of-order room data', async () => {
    const { handlers, session } = fakeSession();
    const { result } = renderHook(() =>
      useViventiumVoiceEvents(session, 'call-1', expectedAgentIdentities)
    );

    await act(async () => {
      const receive = handlers.get(RoomEvent.DataReceived);
      receive?.(packet(task()), agentParticipant, undefined, VIVENTIUM_TASK_TOPIC);
      receive?.(
        packet(task({ eventId: 'older', sequence: 0, state: 'queued' })),
        agentParticipant,
        undefined,
        VIVENTIUM_TASK_TOPIC
      );
      receive?.(packet({ version: 99 }), agentParticipant, undefined, VIVENTIUM_TASK_TOPIC);
      receive?.(
        packet(task({ eventId: 'wrong-topic' })),
        agentParticipant,
        undefined,
        'other.topic'
      );
    });

    await waitFor(() => expect(result.current.tasks[0]).toMatchObject(task()));
  });

  it('rejects valid-shaped packets forged by a guest or anonymous sender', async () => {
    const { handlers, session } = fakeSession();
    const { result } = renderHook(() =>
      useViventiumVoiceEvents(session, 'call-1', expectedAgentIdentities)
    );
    await act(async () => {
      const receive = handlers.get(RoomEvent.DataReceived);
      receive?.(packet(task()), guestParticipant, undefined, VIVENTIUM_TASK_TOPIC);
      receive?.(
        packet(task()),
        { isAgent: true, identity: 'unexpected-agent' },
        undefined,
        VIVENTIUM_TASK_TOPIC
      );
      receive?.(
        packet(task({ callSessionId: 'different-call' })),
        agentParticipant,
        undefined,
        VIVENTIUM_TASK_TOPIC
      );
      receive?.(packet(segment()), undefined, undefined, VIVENTIUM_SPEAKER_TOPIC);
    });
    expect(result.current.tasks).toEqual([]);
    expect(result.current.speakerSegments).toEqual([]);
  });

  it('strictly merges authoritative snapshots on mount and reconnect', async () => {
    let taskSnapshotRequest = 0;
    let speakerSnapshotRequest = 0;
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/api/call-speakers')) {
        speakerSnapshotRequest += 1;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              version: 1,
              segments: [
                segment({
                  revision: speakerSnapshotRequest === 1 ? 0 : 2,
                  text: speakerSnapshotRequest === 1 ? 'First pass' : 'Final revised pass',
                  isFinal: speakerSnapshotRequest > 1,
                }),
              ],
            }),
            { status: 200 }
          )
        );
      }
      taskSnapshotRequest += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: 1,
            events: [
              task({
                eventId: `snapshot-${taskSnapshotRequest}`,
                type: 'snapshot',
                sequence: taskSnapshotRequest === 1 ? 4 : 6,
                state: taskSnapshotRequest === 1 ? 'running' : 'completed',
              }),
            ],
          }),
          { status: 200 }
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { handlers, session } = fakeSession();
    const { result } = renderHook(() =>
      useViventiumVoiceEvents(session, 'call-1', expectedAgentIdentities)
    );
    await waitFor(() => expect(result.current.tasks[0]?.sequence).toBe(4));
    await waitFor(() => expect(result.current.speakerSegments[0]?.revision).toBe(0));

    await act(async () => {
      handlers.get(RoomEvent.DataReceived)?.(
        packet(task({ eventId: 'packet-5', sequence: 5 })),
        agentParticipant,
        undefined,
        VIVENTIUM_TASK_TOPIC
      );
      handlers.get(RoomEvent.DataReceived)?.(
        packet(segment({ revision: 1, text: 'Live revision' })),
        agentParticipant,
        undefined,
        VIVENTIUM_SPEAKER_TOPIC
      );
      handlers.get(RoomEvent.Reconnected)?.();
    });
    await waitFor(() => expect(result.current.tasks[0]?.sequence).toBe(6));
    await waitFor(() => expect(result.current.speakerSegments[0]?.revision).toBe(2));
    expect(result.current.speakerSegments).toHaveLength(1);
    expect(result.current.speakerSegments[0]?.text).toBe('Final revised pass');
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      '/api/call-tasks?callSessionId=call-1',
      expect.objectContaining({ cache: 'no-store' })
    );
  });

  it('stops reconnect recovery synchronously before an intentional call end', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ version: 1, events: [], segments: [] }), { status: 200 })
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    const { handlers, session } = fakeSession();
    const { result, rerender } = renderHook(
      ({ identities }) => useViventiumVoiceEvents(session, 'call-1', identities),
      { initialProps: { identities: expectedAgentIdentities } }
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fetchMock.mockClear();

    act(() => result.current.stopRecovery());
    rerender({ identities: ['agent-2'] });
    await act(async () => {
      handlers.get(RoomEvent.Reconnected)?.();
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects cross-session and oversized speaker snapshots without erasing live state', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) =>
      Promise.resolve(
        new Response(
          JSON.stringify(
            url.startsWith('/api/call-tasks')
              ? { version: 1, events: [] }
              : {
                  version: 1,
                  segments: [segment({ callSessionId: 'different-call', revision: 99 })],
                }
          ),
          { status: 200 }
        )
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const { handlers, session } = fakeSession();
    const { result } = renderHook(() =>
      useViventiumVoiceEvents(session, 'call-1', expectedAgentIdentities)
    );
    await act(async () => {
      handlers.get(RoomEvent.DataReceived)?.(
        packet(segment({ revision: 1, text: 'Trusted live segment' })),
        agentParticipant,
        undefined,
        VIVENTIUM_SPEAKER_TOPIC
      );
    });
    await waitFor(() => expect(result.current.speakerSegments).toHaveLength(1));
    expect(result.current.speakerSegments[0]?.text).toBe('Trusted live segment');
  });

  it('visibly degrades on a malformed task snapshot without erasing trusted live task state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) =>
        Promise.resolve(
          new Response(
            JSON.stringify(
              url.startsWith('/api/call-tasks')
                ? { version: 1, events: [{ malformed: true }] }
                : { version: 1, segments: [], hasMore: false }
            ),
            { status: 200 }
          )
        )
      )
    );
    const { handlers, session } = fakeSession();
    const { result } = renderHook(() =>
      useViventiumVoiceEvents(session, 'call-1', expectedAgentIdentities)
    );
    await act(async () => {
      handlers.get(RoomEvent.DataReceived)?.(
        packet(task({ eventId: 'trusted-live', sequence: 7 })),
        agentParticipant,
        undefined,
        VIVENTIUM_TASK_TOPIC
      );
    });

    await waitFor(() => expect(result.current.recoveryIssue).toMatchObject({ kind: 'unknown' }));
    expect(result.current.recoveryRetryable).toBe(true);
    expect(result.current.tasks).toEqual([
      expect.objectContaining({ taskId: 'task-1', eventId: 'trusted-live', sequence: 7 }),
    ]);
  });

  it('times out reconnect recovery instead of hanging the call UI', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      )
    );
    const { session } = fakeSession();
    const { result } = renderHook(() =>
      useViventiumVoiceEvents(session, 'call-1', expectedAgentIdentities)
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_001);
    });

    expect(result.current.recoveryIssue).toMatchObject({ kind: 'gateway_down' });
    expect(result.current.recoveryRetryable).toBe(true);
    vi.useRealTimers();
  });

  it('traverses paged speaker history while retaining a deduped bounded latest view', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/call-tasks')) {
        return Promise.resolve(
          new Response(JSON.stringify({ version: 1, events: [] }), { status: 200 })
        );
      }
      const isOlderPage =
        url.includes('beforeSequence=512') && url.includes('beforeSegmentId=segment-512');
      const start = isOlderPage ? 0 : 512;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: 1,
            segments: Array.from({ length: 512 }, (_, offset) =>
              segment({
                segmentId: `segment-${start + offset}`,
                sequence: start + offset,
                revision: 1,
                text: `Segment ${start + offset}`,
              })
            ),
            hasMore: !isOlderPage,
            ...(!isOlderPage
              ? { nextBeforeSequence: 512, nextBeforeSegmentId: 'segment-512' }
              : {}),
          }),
          { status: 200 }
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { session } = fakeSession();
    const { result } = renderHook(() =>
      useViventiumVoiceEvents(session, 'call-1', expectedAgentIdentities)
    );

    await waitFor(() => expect(result.current.hasOlderSpeakers).toBe(true));
    act(() => result.current.loadOlderSpeakers());

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(
          ([url]) =>
            String(url).includes('beforeSequence=512') &&
            String(url).includes('beforeSegmentId=segment-512')
        )
      ).toBe(true)
    );
    await waitFor(() => expect(result.current.speakerSegments).toHaveLength(1_024));
    expect(new Set(result.current.speakerSegments.map((item) => item.segmentId)).size).toBe(1_024);
    expect(result.current.speakerSegments[0]?.sequence).toBe(0);
    expect(result.current.speakerSegments.at(-1)?.sequence).toBe(1023);
  });

  it('naturally pages 4200 speakers oldest-to-newest without gaps and keeps live captions', async () => {
    const all = Array.from({ length: 4_200 }, (_, sequence) =>
      segment({
        segmentId: `long-${sequence.toString().padStart(4, '0')}`,
        sequence,
        revision: 1,
        text: `Long call segment ${sequence}`,
      })
    );
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/call-tasks')) {
        return Promise.resolve(new Response(JSON.stringify({ version: 1, events: [] })));
      }
      const parsed = new URL(String(url), 'https://playground.example.test');
      const beforeSequence = parsed.searchParams.get('beforeSequence');
      const beforeSegmentId = parsed.searchParams.get('beforeSegmentId');
      const afterSequence = parsed.searchParams.get('afterSequence');
      const afterSegmentId = parsed.searchParams.get('afterSegmentId');
      let eligible = all;
      let direction: 'before' | 'after' = 'before';
      if (beforeSequence !== null && beforeSegmentId) {
        const boundary = Number(beforeSequence);
        eligible = all.filter(
          (item) =>
            item.sequence < boundary ||
            (item.sequence === boundary && item.segmentId.localeCompare(beforeSegmentId) < 0)
        );
      } else if (afterSequence !== null && afterSegmentId) {
        direction = 'after';
        const boundary = Number(afterSequence);
        eligible = all.filter(
          (item) =>
            item.sequence > boundary ||
            (item.sequence === boundary && item.segmentId.localeCompare(afterSegmentId) > 0)
        );
      }
      const page = direction === 'after' ? eligible.slice(0, 512) : eligible.slice(-512);
      const hasMore = eligible.length > page.length;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            version: 1,
            segments: page,
            hasMore,
            ...(hasMore && direction === 'before'
              ? {
                  nextBeforeSequence: page[0]!.sequence,
                  nextBeforeSegmentId: page[0]!.segmentId,
                }
              : hasMore
                ? {
                    nextAfterSequence: page.at(-1)!.sequence,
                    nextAfterSegmentId: page.at(-1)!.segmentId,
                  }
                : {}),
          })
        )
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const { handlers, session } = fakeSession();
    const { result } = renderHook(() =>
      useViventiumVoiceEvents(session, 'call-1', expectedAgentIdentities)
    );
    const observed = new Set<string>();
    await waitFor(() => expect(result.current.speakerSegments).toHaveLength(512));
    result.current.speakerSegments.forEach((item) => observed.add(item.segmentId));

    for (let pageIndex = 0; pageIndex < 9 && result.current.hasOlderSpeakers; pageIndex += 1) {
      const previousFirst = result.current.speakerSegments[0]!.sequence;
      act(() => result.current.loadOlderSpeakers());
      await waitFor(() =>
        expect(result.current.speakerSegments[0]!.sequence).toBeLessThan(previousFirst)
      );
      result.current.speakerSegments.forEach((item) => observed.add(item.segmentId));
    }
    expect(result.current.hasOlderSpeakers).toBe(false);
    expect(observed.size).toBe(4_200);
    expect(result.current.speakerSegments.length).toBeLessThanOrEqual(4_096);
    expect(result.current.speakerSegments[0]?.sequence).toBe(0);
    expect(result.current.hasNewerSpeakers).toBe(true);

    await act(async () => {
      handlers.get(RoomEvent.DataReceived)?.(
        packet(
          segment({
            segmentId: 'long-live-4200',
            sequence: 4_200,
            revision: 1,
            text: 'Live while reading earlier speakers',
          })
        ),
        agentParticipant,
        undefined,
        VIVENTIUM_SPEAKER_TOPIC
      );
    });
    expect(result.current.latestSpeakerSegment?.sequence).toBe(4_200);

    for (let pageIndex = 0; pageIndex < 9 && result.current.hasNewerSpeakers; pageIndex += 1) {
      const previousLast = result.current.speakerSegments.at(-1)!.sequence;
      act(() => result.current.loadNewerSpeakers());
      await waitFor(() =>
        expect(result.current.speakerSegments.at(-1)!.sequence).toBeGreaterThan(previousLast)
      );
      result.current.speakerSegments.forEach((item) => observed.add(item.segmentId));
    }
    expect(result.current.hasNewerSpeakers).toBe(false);
    expect(result.current.speakerSegments.at(-1)?.sequence).toBe(4_200);
    expect(new Set(result.current.speakerSegments.map((item) => item.segmentId)).size).toBe(
      result.current.speakerSegments.length
    );
    expect(observed.size).toBe(4_201);
  });
});
