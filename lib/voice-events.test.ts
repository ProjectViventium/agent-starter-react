import { describe, expect, it } from 'vitest';
import {
  MAX_RETAINED_SPEAKER_SEGMENTS,
  MAX_RETAINED_TASK_VIEWS,
  MAX_SPEAKER_REVISION_HISTORY,
  MAX_TASK_TERMINAL_TOMBSTONES,
  type SpeakerSegmentV1,
  type VoiceTaskEventV1,
  type VoiceTaskView,
  applySpeakerSegment,
  applySpeakerSegmentToStore,
  applyTaskEvent,
  applyTaskEventToStore,
  createBoundedVoiceEventStore,
  parseSpeakerSegment,
  parseTaskEvent,
} from '@/lib/voice-events';

const task = (overrides: Partial<VoiceTaskEventV1> = {}): VoiceTaskEventV1 => ({
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
});

const segment = (overrides: Partial<SpeakerSegmentV1> = {}): SpeakerSegmentV1 => ({
  version: 1,
  segmentId: 'segment-1',
  callSessionId: 'call-1',
  turnId: 'turn-1',
  sequence: 1,
  revision: 0,
  text: 'Hello there',
  isFinal: false,
  speaker: {
    key: 'speaker-1',
    label: 'Speaker 1',
    source: 'provider_diarization',
    attribution: 'unverified',
    actorTrust: 'shared_mic_unverified',
  },
  ...overrides,
});

describe('voice event boundary', () => {
  it('accepts the frozen task contract and rejects unversioned events', () => {
    expect(parseTaskEvent(JSON.stringify(task()))).toEqual(task());
    expect(parseTaskEvent(JSON.stringify({ ...task(), version: 2 }))).toBeNull();
  });

  it('accepts Unknown speaker abstention and rejects invalid attribution', () => {
    const unknown = segment({
      speaker: {
        key: 'unknown',
        label: 'Unknown',
        source: 'unknown',
        attribution: 'unknown',
        actorTrust: 'unknown',
      },
      uncertain: true,
    });
    expect(parseSpeakerSegment(JSON.stringify(unknown))).toEqual(unknown);
    expect(
      parseSpeakerSegment(
        JSON.stringify({ ...unknown, speaker: { ...unknown.speaker, attribution: 'owner' } })
      )
    ).toBeNull();
  });

  it('rejects hostile or malformed nested task and speaker payloads', () => {
    expect(
      parseTaskEvent(
        JSON.stringify({ ...task(), owner: 'not-an-owner', source: { title: ['nested'] } })
      )
    ).toBeNull();
    expect(parseTaskEvent(JSON.stringify({ ...task(), detail: 'x'.repeat(300_000) }))).toBeNull();
    expect(
      parseSpeakerSegment(
        JSON.stringify({ ...segment(), speaker: { ...segment().speaker, source: 'biometric' } })
      )
    ).toBeNull();
    expect(
      parseSpeakerSegment(
        JSON.stringify({ ...segment(), speaker: { ...segment().speaker, actorTrust: 'owner' } })
      )
    ).toBeNull();
  });

  it('accepts bounded accumulated sources only on snapshots', () => {
    const snapshot = task({
      type: 'snapshot',
      sources: [
        { id: 'one', title: 'One', url: 'https://one.example' },
        { id: 'one', title: 'Duplicate', url: 'https://duplicate.example' },
      ],
    });
    expect(parseTaskEvent(snapshot)?.sources).toEqual([snapshot.sources?.[0]]);
    expect(parseTaskEvent({ ...snapshot, type: 'state' })).toBeNull();
    expect(
      parseTaskEvent({
        ...snapshot,
        sources: Array.from({ length: 33 }, (_, index) => ({ id: String(index) })),
      })
    ).toBeNull();
    expect(
      parseTaskEvent({ ...snapshot, sources: [{ title: 'Unsafe', url: 'javascript:alert(1)' }] })
    ).toBeNull();
  });
});

describe('monotonic voice event stores', () => {
  it('deduplicates task event IDs and ignores out-of-order task sequences', () => {
    const first = applyTaskEvent([], task());
    expect(applyTaskEvent(first, task())).toBe(first);
    expect(applyTaskEvent(first, task({ eventId: 'old', sequence: 0, state: 'queued' }))).toBe(
      first
    );
    expect(
      applyTaskEvent(first, task({ eventId: 'done', sequence: 2, state: 'completed' }))[0]
    ).toMatchObject(task({ eventId: 'done', sequence: 2, state: 'completed' }));
  });

  it('preserves task creation order when unrelated task sequences are not comparable', () => {
    const first = applyTaskEvent([], task({ taskId: 'task-a', sequence: 80 }));
    const second = applyTaskEvent(
      first,
      task({ taskId: 'task-b', eventId: 'event-b', sequence: 1 })
    );
    const updated = applyTaskEvent(
      second,
      task({ taskId: 'task-a', eventId: 'event-a2', sequence: 81, state: 'completed' })
    );
    expect(updated.map((event) => event.taskId)).toEqual(['task-a', 'task-b']);
  });

  it('aggregates multiple sources across progress and result events', () => {
    let views: VoiceTaskView[] = [];
    views = applyTaskEvent(
      views,
      task({ source: { id: 'source-1', title: 'First source', url: 'https://one.example' } })
    );
    views = applyTaskEvent(
      views,
      task({
        eventId: 'event-2',
        sequence: 2,
        source: { id: 'source-2', title: 'Second source', url: 'https://two.example' },
      })
    );
    views = applyTaskEvent(
      views,
      task({ eventId: 'event-3', sequence: 3, type: 'result', state: 'completed' })
    );
    expect(views[0]?.sources.map((source) => source.id)).toEqual(['source-1', 'source-2']);
    expect(views[0]?.state).toBe('completed');
  });

  it('hydrates a full snapshot, applies the next live event, and ignores stale replay', () => {
    const snapshot = task({
      eventId: 'snapshot-5',
      sequence: 5,
      type: 'snapshot',
      phase: 'Searching',
      progress: { current: 1, total: 2 },
      sources: [{ id: 'source-1', url: 'https://one.example' }],
    });
    let views = applyTaskEvent([], snapshot);
    views = applyTaskEvent(
      views,
      task({
        eventId: 'live-6',
        sequence: 6,
        type: 'source',
        source: { id: 'source-2', url: 'https://two.example' },
      })
    );
    const afterLive = views;
    views = applyTaskEvent(
      views,
      task({ eventId: 'snapshot-duplicate', sequence: 5, type: 'snapshot', sources: [] })
    );
    expect(views).toBe(afterLive);
    expect(views[0]?.sources.map((source) => source.id)).toEqual(['source-1', 'source-2']);
    expect(views[0]?.phase).toBe('Searching');
    expect(views[0]?.progress).toEqual({ current: 1, total: 2 });
  });

  it('merges an equal-sequence snapshot without admitting equal live or lower snapshot replay', () => {
    const current = applyTaskEvent(
      [],
      task({ eventId: 'live-5', sequence: 5, phase: 'Working without source packet' })
    );
    const hydrated = applyTaskEvent(
      current,
      task({
        eventId: 'snapshot-5',
        sequence: 5,
        type: 'snapshot',
        phase: 'Working with authoritative snapshot',
        sources: [{ id: 'missed-source', url: 'https://source.example' }],
      })
    );
    expect(hydrated[0]?.sources.map((source) => source.id)).toEqual(['missed-source']);
    expect(hydrated[0]?.phase).toBe('Working with authoritative snapshot');

    const equalLive = applyTaskEvent(
      hydrated,
      task({ eventId: 'equal-live', sequence: 5, phase: 'Replay regression' })
    );
    const lowerSnapshot = applyTaskEvent(
      hydrated,
      task({ eventId: 'snapshot-4', sequence: 4, type: 'snapshot', sources: [] })
    );
    expect(equalLive).toBe(hydrated);
    expect(lowerSnapshot).toBe(hydrated);
  });

  it('never regresses a terminal task to an active state at a higher sequence', () => {
    const completed = applyTaskEvent(
      [],
      task({ eventId: 'completed-5', sequence: 5, type: 'result', state: 'completed' })
    );
    expect(
      applyTaskEvent(
        completed,
        task({ eventId: 'late-running-6', sequence: 6, type: 'state', state: 'running' })
      )
    ).toBe(completed);
    const sameTerminal = applyTaskEvent(
      completed,
      task({
        eventId: 'completed-source-6',
        sequence: 6,
        type: 'source',
        state: 'completed',
        source: { id: 'late-source', url: 'https://late.example' },
      })
    );
    expect(sameTerminal[0]?.state).toBe('completed');
    expect(sameTerminal[0]?.sources.map((source) => source.id)).toEqual(['late-source']);
  });

  it('accepts only the monotonic late cancellation-proof terminal correction', () => {
    const unenforceable = applyTaskEvent(
      [],
      task({
        eventId: 'unenforceable-5',
        sequence: 5,
        type: 'state',
        state: 'cancelled_unenforceable',
      })
    );
    const confirmed = applyTaskEvent(
      unenforceable,
      task({
        eventId: 'confirmed-6',
        sequence: 6,
        type: 'state',
        state: 'cancelled_confirmed',
      })
    );
    expect(confirmed[0]?.state).toBe('cancelled_confirmed');
    expect(
      applyTaskEvent(
        confirmed,
        task({ eventId: 'failed-7', sequence: 7, type: 'error', state: 'failed' })
      )
    ).toBe(confirmed);
  });

  it('applies only newer speaker sequence/revision pairs and supports revisions', () => {
    const first = applySpeakerSegment([], segment());
    expect(applySpeakerSegment(first, segment())).toBe(first);
    expect(applySpeakerSegment(first, segment({ sequence: 0, revision: 4, text: 'stale' }))).toBe(
      first
    );
    expect(
      applySpeakerSegment(
        first,
        segment({ revision: 1, text: 'Hello there, revised', isFinal: true })
      )
    ).toEqual([segment({ revision: 1, text: 'Hello there, revised', isFinal: true })]);
  });

  it('keeps same-sequence multi-track segments deterministic across revisions and replay order', () => {
    const store = createBoundedVoiceEventStore();
    applySpeakerSegmentToStore(
      store,
      segment({ segmentId: 'segment-b', sequence: 8, revision: 1, text: 'Second track' })
    );
    applySpeakerSegmentToStore(
      store,
      segment({ segmentId: 'segment-a', sequence: 8, revision: 1, text: 'First track' })
    );
    expect(store.speakerSegments.map((item) => item.segmentId)).toEqual(['segment-a', 'segment-b']);

    applySpeakerSegmentToStore(
      store,
      segment({ segmentId: 'segment-b', sequence: 8, revision: 2, text: 'Revised second track' })
    );
    applySpeakerSegmentToStore(
      store,
      segment({ segmentId: 'segment-b', sequence: 8, revision: 1, text: 'Stale replay' })
    );
    expect(store.speakerSegments.map((item) => item.segmentId)).toEqual(['segment-a', 'segment-b']);
    expect(store.speakerSegments[1]).toMatchObject({
      revision: 2,
      text: 'Revised second track',
    });
  });

  it('bounds a 120-minute task stream while retaining active work and terminal tombstones', () => {
    const store = createBoundedVoiceEventStore();
    for (let index = 0; index < MAX_TASK_TERMINAL_TOMBSTONES + 300; index += 1) {
      applyTaskEventToStore(
        store,
        task({
          taskId: `task-${index}`,
          eventId: `terminal-${index}`,
          emittedAt: new Date(Date.UTC(2026, 7, 9, 12, 0, index)).toISOString(),
          sequence: 2,
          type: 'result',
          state: 'completed',
        })
      );
    }
    for (let index = 0; index < 12; index += 1) {
      applyTaskEventToStore(
        store,
        task({
          taskId: `active-${index}`,
          eventId: `active-event-${index}`,
          sequence: 1,
          state: 'running',
        })
      );
    }

    expect(store.taskViews.length).toBeLessThanOrEqual(MAX_RETAINED_TASK_VIEWS);
    expect(store.taskViews.filter((item) => item.state === 'running')).toHaveLength(12);
    expect(store.terminalTaskTombstones.size).toBe(MAX_TASK_TERMINAL_TOMBSTONES);

    const retainedTerminal = store.taskViews.find((item) => item.state === 'completed');
    expect(retainedTerminal).toBeDefined();
    const beforeReplay = store.taskViews;
    expect(
      applyTaskEventToStore(
        store,
        task({
          taskId: retainedTerminal!.taskId,
          eventId: 'stale-after-terminal',
          sequence: 3,
          state: 'running',
        })
      )
    ).toBe(beforeReplay);
  });

  it('bounds speaker history and keeps the latest revision for every retained segment', () => {
    const store = createBoundedVoiceEventStore();
    for (let index = 0; index < MAX_SPEAKER_REVISION_HISTORY + 300; index += 1) {
      applySpeakerSegmentToStore(
        store,
        segment({
          segmentId: `segment-${index}`,
          sequence: index,
          revision: 1,
          text: `Synthetic segment ${index}`,
        })
      );
    }
    const latestId = `segment-${MAX_SPEAKER_REVISION_HISTORY + 299}`;
    applySpeakerSegmentToStore(
      store,
      segment({
        segmentId: latestId,
        sequence: MAX_SPEAKER_REVISION_HISTORY + 299,
        revision: 7,
        text: 'Latest deterministic revision',
        isFinal: true,
      })
    );

    expect(store.speakerRevisionHistory.size).toBe(MAX_SPEAKER_REVISION_HISTORY);
    expect(store.speakerSegments).toHaveLength(MAX_RETAINED_SPEAKER_SEGMENTS);
    expect(store.speakerSegments.at(-1)).toMatchObject({
      segmentId: latestId,
      revision: 7,
      text: 'Latest deterministic revision',
    });
  });
});
