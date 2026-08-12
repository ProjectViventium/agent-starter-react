/**
 * VIVENTIUM START
 * Purpose: Validate and monotonically apply the versioned call task/speaker wire contracts.
 * The boundary is deliberately strict so untrusted room data cannot become call UI state.
 * VIVENTIUM END
 */

export const VIVENTIUM_TASK_TOPIC = 'viventium.task.v1';
export const VIVENTIUM_SPEAKER_TOPIC = 'viventium.speaker.v1';

export const VOICE_TASK_TYPES = [
  'snapshot',
  'state',
  'progress',
  'source',
  'needs_input',
  'result',
  'error',
] as const;

export const VOICE_TASK_STATES = [
  'queued',
  'running',
  'needs_input',
  'recovering',
  'cancelling',
  'completed',
  'failed',
  'cancelled_confirmed',
  'cancelled_unenforceable',
] as const;

export type VoiceTaskType = (typeof VOICE_TASK_TYPES)[number];
export type VoiceTaskState = (typeof VOICE_TASK_STATES)[number];

const TERMINAL_TASK_STATES = new Set<VoiceTaskState>([
  'completed',
  'failed',
  'cancelled_confirmed',
  'cancelled_unenforceable',
]);

// Long calls can produce thousands of immutable events. Keep the useful live view small while
// retaining a bounded terminal barrier and per-segment revision ledger for replay protection.
export const MAX_RETAINED_TASK_VIEWS = 128;
export const MAX_TASK_TERMINAL_TOMBSTONES = 4_096;
// Keep the latest normalized revision for a full extended call in memory. Rendering is windowed
// separately so retaining reconnect history never creates thousands of DOM nodes.
export const MAX_RETAINED_SPEAKER_SEGMENTS = 4_096;
export const MAX_SPEAKER_REVISION_HISTORY = 4_096;

export type VoiceTaskProgress = {
  current: number;
  total: number;
  unit?: string;
};

export type VoiceTaskSource = {
  id?: string;
  title?: string;
  url?: string;
  provider?: string;
};

export const SPEAKER_SOURCES = [
  'participant_track',
  'provider_diarization',
  'hybrid',
  'local_diarization',
  'unknown',
] as const;

export const SPEAKER_ACTOR_TRUST = [
  'owner_participant',
  'authenticated_participant',
  'shared_mic_unverified',
  'unknown',
] as const;

export type SpeakerSource = (typeof SPEAKER_SOURCES)[number];
export type SpeakerActorTrust = (typeof SPEAKER_ACTOR_TRUST)[number];

export type VoiceTaskEventV1 = {
  version: 1;
  eventId: string;
  sequence: number;
  emittedAt: string;
  callSessionId: string;
  conversationId?: string;
  turnId?: string;
  streamId?: string;
  taskId: string;
  parentTaskId?: string;
  type: VoiceTaskType;
  state: VoiceTaskState;
  phase?: string;
  label?: string;
  detail?: string;
  progress?: VoiceTaskProgress;
  cancellable: boolean;
  retryable: boolean;
  source?: VoiceTaskSource;
  /** Full accumulated sources are allowed only on authoritative reconnect snapshots. */
  sources?: VoiceTaskSource[];
  needsInput?: { prompt: string; inputType: 'text' | 'choice' | 'confirm' };
  resultMessageId?: string;
  owner?: { kind?: string; id?: string };
  error?: { code?: string; message?: string; retryable?: boolean };
};

export type VoiceTaskView = VoiceTaskEventV1 & {
  firstEmittedAt: string;
  sources: VoiceTaskSource[];
};

export type SpeakerAttribution = 'verified' | 'unverified' | 'unknown';

export type SpeakerSegmentV1 = {
  version: 1;
  segmentId: string;
  callSessionId: string;
  turnId: string;
  sequence: number;
  revision: number;
  startTimeMs?: number;
  endTimeMs?: number;
  text: string;
  isFinal: boolean;
  speaker: {
    key: string;
    label: string;
    source: SpeakerSource;
    attribution: SpeakerAttribution;
    actorTrust: SpeakerActorTrust;
    participantIdentity?: string;
    participantName?: string;
    trackSid?: string;
    providerSpeakerId?: string;
  };
  overlap?: boolean;
  uncertain?: boolean;
};

type TerminalTaskTombstone = {
  sequence: number;
  state: VoiceTaskState;
};

export type BoundedVoiceEventStore = {
  taskViews: VoiceTaskView[];
  terminalTaskTombstones: Map<string, TerminalTaskTombstone>;
  speakerSegments: SpeakerSegmentV1[];
  speakerRevisionHistory: Map<string, SpeakerSegmentV1>;
};

export function createBoundedVoiceEventStore(): BoundedVoiceEventStore {
  return {
    taskViews: [],
    terminalTaskTombstones: new Map(),
    speakerSegments: [],
    speakerRevisionHistory: new Map(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

const MAX_EVENT_BYTES = 256_000;

function isBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseJson(value: string | unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  if (value.length > MAX_EVENT_BYTES) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function optionalString(value: unknown, maxLength = 8_000): value is string | undefined {
  return value === undefined || isBoundedString(value, maxLength);
}

function normalizeSource(value: unknown): VoiceTaskSource | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    return null;
  }
  if (
    !optionalString(value.id, 200) ||
    !optionalString(value.title, 1_000) ||
    !optionalString(value.url, 4_000) ||
    !optionalString(value.provider, 200)
  ) {
    return null;
  }
  if (typeof value.url === 'string') {
    try {
      const url = new URL(value.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return null;
      }
    } catch {
      return null;
    }
  }
  return {
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
    ...(typeof value.title === 'string' ? { title: value.title } : {}),
    ...(typeof value.url === 'string' ? { url: value.url } : {}),
    ...(typeof value.provider === 'string' ? { provider: value.provider } : {}),
  };
}

function normalizeOwner(value: unknown): VoiceTaskEventV1['owner'] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !optionalString(value.kind, 100) || !optionalString(value.id, 200)) {
    return null;
  }
  return {
    ...(typeof value.kind === 'string' ? { kind: value.kind } : {}),
    ...(typeof value.id === 'string' ? { id: value.id } : {}),
  };
}

function normalizeNeedsInput(value: unknown): VoiceTaskEventV1['needsInput'] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !isBoundedString(value.prompt, 2_000) ||
    (value.inputType !== 'text' && value.inputType !== 'choice' && value.inputType !== 'confirm')
  ) {
    return null;
  }
  return { prompt: value.prompt, inputType: value.inputType };
}

function normalizeError(value: unknown): VoiceTaskEventV1['error'] | undefined | null {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !optionalString(value.code, 200) ||
    !optionalString(value.message, 4_000) ||
    (value.retryable !== undefined && typeof value.retryable !== 'boolean')
  ) {
    return null;
  }
  return {
    ...(typeof value.code === 'string' ? { code: value.code } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(typeof value.retryable === 'boolean' ? { retryable: value.retryable } : {}),
  };
}

export function parseTaskEvent(input: string | unknown): VoiceTaskEventV1 | null {
  const value = parseJson(input);
  if (!isRecord(value)) {
    return null;
  }
  if (
    value.version !== 1 ||
    !isBoundedString(value.eventId, 200) ||
    !isNonNegativeInteger(value.sequence) ||
    !isBoundedString(value.emittedAt, 100) ||
    !Number.isFinite(Date.parse(value.emittedAt)) ||
    !isBoundedString(value.callSessionId, 160) ||
    !isBoundedString(value.taskId, 160) ||
    !VOICE_TASK_TYPES.includes(value.type as VoiceTaskType) ||
    !VOICE_TASK_STATES.includes(value.state as VoiceTaskState) ||
    typeof value.cancellable !== 'boolean' ||
    typeof value.retryable !== 'boolean' ||
    !optionalString(value.conversationId, 160) ||
    !optionalString(value.turnId, 160) ||
    !optionalString(value.streamId, 160) ||
    !optionalString(value.parentTaskId, 160) ||
    !optionalString(value.phase, 500) ||
    !optionalString(value.label, 500) ||
    !optionalString(value.detail, 8_000) ||
    !optionalString(value.resultMessageId, 160)
  ) {
    return null;
  }

  if (value.progress !== undefined) {
    if (!isRecord(value.progress)) {
      return null;
    }
    const { current, total, unit } = value.progress;
    if (
      typeof current !== 'number' ||
      !Number.isFinite(current) ||
      current < 0 ||
      typeof total !== 'number' ||
      !Number.isFinite(total) ||
      total <= 0 ||
      current > total ||
      !optionalString(unit)
    ) {
      return null;
    }
  }

  const source = normalizeSource(value.source);
  let snapshotSources: VoiceTaskSource[] | undefined;
  if (value.sources !== undefined) {
    if (value.type !== 'snapshot' || !Array.isArray(value.sources) || value.sources.length > 32) {
      return null;
    }
    snapshotSources = [];
    const sourceKeys = new Set<string>();
    for (const candidate of value.sources) {
      const parsed = normalizeSource(candidate);
      if (!parsed) {
        return null;
      }
      const key = parsed.id || parsed.url || `${parsed.provider ?? ''}\0${parsed.title ?? ''}`;
      if (!sourceKeys.has(key)) {
        sourceKeys.add(key);
        snapshotSources.push(parsed);
      }
    }
  }
  const owner = normalizeOwner(value.owner);
  const needsInput = normalizeNeedsInput(value.needsInput);
  const error = normalizeError(value.error);
  if (source === null || owner === null || needsInput === null || error === null) {
    return null;
  }

  return {
    version: 1,
    eventId: value.eventId,
    sequence: value.sequence,
    emittedAt: value.emittedAt,
    callSessionId: value.callSessionId,
    taskId: value.taskId,
    type: value.type as VoiceTaskType,
    state: value.state as VoiceTaskState,
    cancellable: value.cancellable,
    retryable: value.retryable,
    ...(typeof value.conversationId === 'string' ? { conversationId: value.conversationId } : {}),
    ...(typeof value.turnId === 'string' ? { turnId: value.turnId } : {}),
    ...(typeof value.streamId === 'string' ? { streamId: value.streamId } : {}),
    ...(typeof value.parentTaskId === 'string' ? { parentTaskId: value.parentTaskId } : {}),
    ...(typeof value.phase === 'string' ? { phase: value.phase } : {}),
    ...(typeof value.label === 'string' ? { label: value.label } : {}),
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    ...(isRecord(value.progress) ? { progress: value.progress as VoiceTaskProgress } : {}),
    ...(source ? { source } : {}),
    ...(snapshotSources ? { sources: snapshotSources } : {}),
    ...(needsInput ? { needsInput } : {}),
    ...(typeof value.resultMessageId === 'string'
      ? { resultMessageId: value.resultMessageId }
      : {}),
    ...(owner ? { owner } : {}),
    ...(error ? { error } : {}),
  };
}

export function parseSpeakerSegment(input: string | unknown): SpeakerSegmentV1 | null {
  const value = parseJson(input);
  if (!isRecord(value) || !isRecord(value.speaker)) {
    return null;
  }
  const attribution = value.speaker.attribution;
  if (
    value.version !== 1 ||
    !isBoundedString(value.segmentId, 200) ||
    !isBoundedString(value.callSessionId, 160) ||
    !isBoundedString(value.turnId, 160) ||
    !isNonNegativeInteger(value.sequence) ||
    !isNonNegativeInteger(value.revision) ||
    typeof value.text !== 'string' ||
    value.text.length > 32_000 ||
    typeof value.isFinal !== 'boolean' ||
    !isNonEmptyString(value.speaker.key) ||
    !isNonEmptyString(value.speaker.label) ||
    !SPEAKER_SOURCES.includes(value.speaker.source as SpeakerSource) ||
    !(['verified', 'unverified', 'unknown'] as const).includes(attribution as SpeakerAttribution) ||
    !SPEAKER_ACTOR_TRUST.includes(value.speaker.actorTrust as SpeakerActorTrust) ||
    !optionalString(value.speaker.participantIdentity, 200) ||
    !optionalString(value.speaker.participantName, 500) ||
    !optionalString(value.speaker.trackSid, 200) ||
    !optionalString(value.speaker.providerSpeakerId, 200)
  ) {
    return null;
  }
  if (
    (value.startTimeMs !== undefined && !isNonNegativeInteger(value.startTimeMs)) ||
    (value.endTimeMs !== undefined && !isNonNegativeInteger(value.endTimeMs)) ||
    (value.overlap !== undefined && typeof value.overlap !== 'boolean') ||
    (value.uncertain !== undefined && typeof value.uncertain !== 'boolean')
  ) {
    return null;
  }
  return value as SpeakerSegmentV1;
}

export function applyTaskEvent(current: VoiceTaskView[], next: VoiceTaskEventV1): VoiceTaskView[] {
  if (current.some((event) => event.eventId === next.eventId)) {
    return current;
  }
  const existing = current.find((event) => event.taskId === next.taskId);
  if (existing) {
    const isLateCancellationProof =
      existing.state === 'cancelled_unenforceable' && next.state === 'cancelled_confirmed';
    if (
      TERMINAL_TASK_STATES.has(existing.state) &&
      next.state !== existing.state &&
      !isLateCancellationProof
    ) {
      return current;
    }
    if (
      next.sequence < existing.sequence ||
      (next.sequence === existing.sequence && next.type !== 'snapshot')
    ) {
      return current;
    }
  }
  if (!existing) {
    const sources = [...(next.sources ?? []), ...(next.source ? [next.source] : [])];
    return [
      ...current,
      {
        ...next,
        firstEmittedAt: next.emittedAt,
        sources,
      },
    ];
  }
  const sourceKey = (source: VoiceTaskSource) =>
    source.id || source.url || `${source.provider ?? ''}\0${source.title ?? ''}`;
  const sources = [...existing.sources];
  for (const candidate of [...(next.sources ?? []), ...(next.source ? [next.source] : [])]) {
    if (!sources.some((source) => sourceKey(source) === sourceKey(candidate))) {
      sources.push(candidate);
    }
  }
  return current.map((event) =>
    event.taskId === next.taskId
      ? {
          ...existing,
          ...next,
          firstEmittedAt: existing.firstEmittedAt,
          sources,
          needsInput:
            next.state === 'needs_input' ? (next.needsInput ?? existing.needsInput) : undefined,
          error: next.error ?? (next.state === 'failed' ? existing.error : undefined),
        }
      : event
  );
}

export function applySpeakerSegment(
  current: SpeakerSegmentV1[],
  next: SpeakerSegmentV1
): SpeakerSegmentV1[] {
  const existing = current.find((segment) => segment.segmentId === next.segmentId);
  if (
    existing &&
    (next.sequence < existing.sequence ||
      (next.sequence === existing.sequence && next.revision <= existing.revision))
  ) {
    return current;
  }
  return [...current.filter((segment) => segment.segmentId !== next.segmentId), next].sort(
    (left, right) => left.sequence - right.sequence || left.revision - right.revision
  );
}

function trimOldestMapEntries<Key, Value>(map: Map<Key, Value>, maximum: number) {
  while (map.size > maximum) {
    const oldest = map.keys().next();
    if (oldest.done) {
      return;
    }
    map.delete(oldest.value);
  }
}

/**
 * Applies a task event to the bounded long-call store.
 *
 * Active work is never evicted. Completed cards are retained newest-first only up to the compact
 * UI limit, while terminal tombstones prevent a late higher-sequence active replay from reviving
 * completed work after its card has disappeared.
 */
export function applyTaskEventToStore(
  store: BoundedVoiceEventStore,
  next: VoiceTaskEventV1
): VoiceTaskView[] {
  const tombstone = store.terminalTaskTombstones.get(next.taskId);
  const existing = store.taskViews.find((task) => task.taskId === next.taskId);
  if (tombstone) {
    const isLateCancellationProof =
      tombstone.state === 'cancelled_unenforceable' && next.state === 'cancelled_confirmed';
    if (
      (next.state !== tombstone.state && !isLateCancellationProof) ||
      next.sequence < tombstone.sequence
    ) {
      return store.taskViews;
    }
    if (!existing) {
      if (next.sequence > tombstone.sequence) {
        store.terminalTaskTombstones.delete(next.taskId);
        store.terminalTaskTombstones.set(next.taskId, {
          sequence: next.sequence,
          state: next.state,
        });
      }
      return store.taskViews;
    }
  }

  const applied = applyTaskEvent(store.taskViews, next);
  if (applied === store.taskViews) {
    return store.taskViews;
  }

  if (TERMINAL_TASK_STATES.has(next.state)) {
    store.terminalTaskTombstones.delete(next.taskId);
    store.terminalTaskTombstones.set(next.taskId, {
      sequence: next.sequence,
      state: next.state,
    });
    trimOldestMapEntries(store.terminalTaskTombstones, MAX_TASK_TERMINAL_TOMBSTONES);
  }

  const active = applied.filter((task) => !TERMINAL_TASK_STATES.has(task.state));
  const terminalBudget = Math.max(0, MAX_RETAINED_TASK_VIEWS - active.length);
  const terminal =
    terminalBudget === 0
      ? []
      : applied.filter((task) => TERMINAL_TASK_STATES.has(task.state)).slice(-terminalBudget);
  const retainedIds = new Set([...active, ...terminal].map((task) => task.taskId));
  store.taskViews = applied.filter((task) => retainedIds.has(task.taskId));
  return store.taskViews;
}

/** Keeps only the latest revision per segment, with bounded visible and replay-protection views. */
export function applySpeakerSegmentToStore(
  store: BoundedVoiceEventStore,
  next: SpeakerSegmentV1
): SpeakerSegmentV1[] {
  const previous = store.speakerRevisionHistory.get(next.segmentId);
  if (
    previous &&
    (next.sequence < previous.sequence ||
      (next.sequence === previous.sequence && next.revision <= previous.revision))
  ) {
    return store.speakerSegments;
  }

  store.speakerRevisionHistory.delete(next.segmentId);
  store.speakerRevisionHistory.set(next.segmentId, next);
  const chronological = Array.from(store.speakerRevisionHistory.values()).sort(
    (left, right) => left.sequence - right.sequence || left.segmentId.localeCompare(right.segmentId)
  );
  if (chronological.length > MAX_SPEAKER_REVISION_HISTORY) {
    for (const segment of chronological.slice(
      0,
      chronological.length - MAX_SPEAKER_REVISION_HISTORY
    )) {
      store.speakerRevisionHistory.delete(segment.segmentId);
    }
  }
  store.speakerSegments = chronological.slice(-MAX_RETAINED_SPEAKER_SEGMENTS);
  return store.speakerSegments;
}
