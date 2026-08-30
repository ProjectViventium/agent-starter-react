'use client';

import * as React from 'react';
import { RoomEvent } from 'livekit-client';
import type { UseSessionReturn } from '@livekit/components-react';
import { callBrowserCapabilityHeaders } from '@/lib/call-browser-capability';
import { type CallIssue, callIssueFromResponse } from '@/lib/call-start';
import {
  MAX_RETAINED_SPEAKER_SEGMENTS,
  MAX_TASK_TERMINAL_TOMBSTONES,
  type SpeakerSegmentV1,
  VIVENTIUM_SPEAKER_TOPIC,
  VIVENTIUM_TASK_TOPIC,
  type VoiceTaskEventV1,
  type VoiceTaskView,
  applySpeakerSegmentToStore,
  applyTaskEventToStore,
  createBoundedVoiceEventStore,
  parseSpeakerSegment,
  parseTaskEvent,
} from '@/lib/voice-events';

const MAX_EVENT_PACKET_BYTES = 256_000;
const MAX_SNAPSHOT_PAGE_ITEMS = 512;
const SNAPSHOT_RECOVERY_TIMEOUT_MS = 5_000;

export function mergeSpeakerHistoryWindow(
  current: SpeakerSegmentV1[],
  incoming: SpeakerSegmentV1[],
  direction: 'newer' | 'older'
): SpeakerSegmentV1[] {
  const latest = new Map(current.map((segment) => [segment.segmentId, segment]));
  for (const segment of incoming) {
    const previous = latest.get(segment.segmentId);
    if (
      !previous ||
      segment.sequence > previous.sequence ||
      (segment.sequence === previous.sequence && segment.revision > previous.revision)
    ) {
      latest.set(segment.segmentId, segment);
    }
  }
  const ordered = [...latest.values()].sort(
    (left, right) => left.sequence - right.sequence || left.segmentId.localeCompare(right.segmentId)
  );
  return direction === 'older'
    ? ordered.slice(0, MAX_RETAINED_SPEAKER_SEGMENTS)
    : ordered.slice(-MAX_RETAINED_SPEAKER_SEGMENTS);
}

function isAgentParticipant(
  participant: unknown,
  expectedAgentIdentities: readonly string[]
): boolean {
  return Boolean(
    participant &&
      typeof participant === 'object' &&
      'isAgent' in participant &&
      participant.isAgent === true &&
      'identity' in participant &&
      typeof participant.identity === 'string' &&
      expectedAgentIdentities.includes(participant.identity)
  );
}

function parseSnapshotPayload(
  payload: unknown,
  callSessionId: string
): {
  tasks: VoiceTaskView[];
  hasMore: boolean;
  nextBeforeCreatedAt: string | null;
  nextBeforeTaskId: string | null;
} | null {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !('version' in payload) ||
    payload.version !== 1 ||
    !('events' in payload) ||
    !Array.isArray(payload.events) ||
    payload.events.length > MAX_TASK_TERMINAL_TOMBSTONES
  ) {
    return null;
  }
  const hasMore = 'hasMore' in payload ? payload.hasMore : false;
  const nextBeforeCreatedAt =
    'nextBeforeCreatedAt' in payload ? payload.nextBeforeCreatedAt : undefined;
  const nextBeforeTaskId = 'nextBeforeTaskId' in payload ? payload.nextBeforeTaskId : undefined;
  if (
    typeof hasMore !== 'boolean' ||
    (hasMore &&
      (typeof nextBeforeCreatedAt !== 'string' ||
        !Number.isFinite(new Date(nextBeforeCreatedAt).getTime()) ||
        typeof nextBeforeTaskId !== 'string' ||
        !nextBeforeTaskId.trim())) ||
    (!hasMore && (nextBeforeCreatedAt !== undefined || nextBeforeTaskId !== undefined))
  ) {
    return null;
  }
  const store = createBoundedVoiceEventStore();
  for (const candidate of payload.events) {
    const event = parseTaskEvent(candidate);
    if (!event || event.type !== 'snapshot' || event.callSessionId !== callSessionId) {
      return null;
    }
    applyTaskEventToStore(store, event);
  }
  return {
    tasks: store.taskViews,
    hasMore,
    nextBeforeCreatedAt: typeof nextBeforeCreatedAt === 'string' ? nextBeforeCreatedAt : null,
    nextBeforeTaskId: typeof nextBeforeTaskId === 'string' ? nextBeforeTaskId : null,
  };
}

function parseSpeakerSnapshotPayload(
  payload: unknown,
  callSessionId: string
): {
  segments: SpeakerSegmentV1[];
  hasMore: boolean;
  nextBeforeSequence: number | null;
  nextBeforeSegmentId: string | null;
  nextAfterSequence: number | null;
  nextAfterSegmentId: string | null;
} | null {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    !('version' in payload) ||
    payload.version !== 1 ||
    !('segments' in payload) ||
    !Array.isArray(payload.segments) ||
    payload.segments.length > MAX_SNAPSHOT_PAGE_ITEMS
  ) {
    return null;
  }
  const hasMore = 'hasMore' in payload ? payload.hasMore : false;
  const nextBeforeSequence =
    'nextBeforeSequence' in payload ? payload.nextBeforeSequence : undefined;
  const nextBeforeSegmentId =
    'nextBeforeSegmentId' in payload ? payload.nextBeforeSegmentId : undefined;
  const nextAfterSequence = 'nextAfterSequence' in payload ? payload.nextAfterSequence : undefined;
  const nextAfterSegmentId =
    'nextAfterSegmentId' in payload ? payload.nextAfterSegmentId : undefined;
  const hasBeforeCursor = nextBeforeSequence !== undefined || nextBeforeSegmentId !== undefined;
  const hasAfterCursor = nextAfterSequence !== undefined || nextAfterSegmentId !== undefined;
  if (
    typeof hasMore !== 'boolean' ||
    (nextBeforeSequence !== undefined &&
      (typeof nextBeforeSequence !== 'number' ||
        !Number.isSafeInteger(nextBeforeSequence) ||
        nextBeforeSequence < 0)) ||
    (nextBeforeSegmentId !== undefined &&
      (typeof nextBeforeSegmentId !== 'string' ||
        !nextBeforeSegmentId.trim() ||
        nextBeforeSegmentId.length > 200)) ||
    (hasMore && !hasBeforeCursor && !hasAfterCursor) ||
    (hasBeforeCursor && hasAfterCursor) ||
    (nextBeforeSequence === undefined) !== (nextBeforeSegmentId === undefined) ||
    (nextAfterSequence !== undefined &&
      (typeof nextAfterSequence !== 'number' ||
        !Number.isSafeInteger(nextAfterSequence) ||
        nextAfterSequence < 0)) ||
    (nextAfterSegmentId !== undefined &&
      (typeof nextAfterSegmentId !== 'string' ||
        !nextAfterSegmentId.trim() ||
        nextAfterSegmentId.length > 200)) ||
    (nextAfterSequence === undefined) !== (nextAfterSegmentId === undefined)
  ) {
    return null;
  }
  const segments: SpeakerSegmentV1[] = [];
  for (const candidate of payload.segments) {
    const segment = parseSpeakerSegment(candidate);
    if (!segment || segment.callSessionId !== callSessionId) {
      return null;
    }
    segments.push(segment);
  }
  return {
    segments,
    hasMore,
    nextBeforeSequence: typeof nextBeforeSequence === 'number' ? nextBeforeSequence : null,
    nextBeforeSegmentId: typeof nextBeforeSegmentId === 'string' ? nextBeforeSegmentId : null,
    nextAfterSequence: typeof nextAfterSequence === 'number' ? nextAfterSequence : null,
    nextAfterSegmentId: typeof nextAfterSegmentId === 'string' ? nextAfterSegmentId : null,
  };
}

class SnapshotRecoveryError extends Error {
  constructor(
    readonly issue: CallIssue,
    readonly retryable: boolean
  ) {
    super(issue.message);
    this.name = 'SnapshotRecoveryError';
  }
}

async function requireSnapshotResponse(response: Response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const issue = callIssueFromResponse(response.status, payload);
    const retryable =
      Boolean(payload) &&
      typeof payload === 'object' &&
      'retryable' in payload &&
      payload.retryable === true;
    throw new SnapshotRecoveryError(issue, retryable || response.status >= 500);
  }
  return payload;
}

/** Consumes strict room data packets and authoritative reconnect snapshots. */
export function useViventiumVoiceEvents(
  session: UseSessionReturn,
  callSessionId: string | null = null,
  expectedAgentIdentities: readonly string[] = []
) {
  const { room } = session;
  const [tasks, setTasks] = React.useState<VoiceTaskView[]>([]);
  const [speakerSegments, setSpeakerSegments] = React.useState<SpeakerSegmentV1[]>([]);
  const [latestSpeakerSegment, setLatestSpeakerSegment] = React.useState<SpeakerSegmentV1 | null>(
    null
  );
  const [recoveryIssue, setRecoveryIssue] = React.useState<CallIssue | null>(null);
  const [recoveryRetryable, setRecoveryRetryable] = React.useState(false);
  const [hasOlderSpeakers, setHasOlderSpeakers] = React.useState(false);
  const [loadingOlderSpeakers, setLoadingOlderSpeakers] = React.useState(false);
  const [hasNewerSpeakers, setHasNewerSpeakers] = React.useState(false);
  const [loadingNewerSpeakers, setLoadingNewerSpeakers] = React.useState(false);
  const loadSnapshotRef = React.useRef<(() => void) | null>(null);
  const applyTaskEventRef = React.useRef<((event: VoiceTaskEventV1) => void) | null>(null);
  const loadOlderSpeakersRef = React.useRef<(() => void) | null>(null);
  const loadNewerSpeakersRef = React.useRef<(() => void) | null>(null);
  const stopRecoveryRef = React.useRef<(() => void) | null>(null);
  const stoppedCallSessionIdRef = React.useRef<string | null>(null);
  const browsingOlderRef = React.useRef(false);
  const pendingNewerSegmentsRef = React.useRef(new Map<string, SpeakerSegmentV1>());

  React.useEffect(() => {
    if (!callSessionId || stoppedCallSessionIdRef.current === callSessionId) {
      stopRecoveryRef.current = null;
      return;
    }
    const store = createBoundedVoiceEventStore();
    const decoder = new TextDecoder();
    const handleDataReceived = (
      payload: Uint8Array,
      participant: unknown,
      _kind: unknown,
      topic?: string
    ) => {
      if (!isAgentParticipant(participant, expectedAgentIdentities)) {
        return;
      }
      if (payload.byteLength > MAX_EVENT_PACKET_BYTES) {
        console.warn('[Viventium] Ignored oversized call event packet');
        return;
      }
      if (topic === VIVENTIUM_TASK_TOPIC) {
        const event = parseTaskEvent(decoder.decode(payload));
        if (event && callSessionId && event.callSessionId === callSessionId) {
          const previous = store.taskViews;
          const applied = applyTaskEventToStore(store, event);
          if (applied !== previous) {
            setTasks(applied);
          }
        }
      } else if (topic === VIVENTIUM_SPEAKER_TOPIC) {
        const segment = parseSpeakerSegment(decoder.decode(payload));
        if (segment && callSessionId && segment.callSessionId === callSessionId) {
          applySpeakerSegmentToStore(store, segment);
          setLatestSpeakerSegment(segment);
          if (browsingOlderRef.current) {
            const previous = pendingNewerSegmentsRef.current.get(segment.segmentId);
            if (!previous || segment.revision > previous.revision) {
              pendingNewerSegmentsRef.current.set(segment.segmentId, segment);
            }
            setHasNewerSpeakers(true);
          } else {
            setSpeakerSegments((current) => mergeSpeakerHistoryWindow(current, [segment], 'newer'));
          }
        }
      }
    };

    let disposed = false;
    let snapshotController: AbortController | null = null;
    let olderController: AbortController | null = null;
    let olderCursor: { beforeSequence: number; beforeSegmentId: string } | null = null;
    let newerCursor: { afterSequence: number; afterSegmentId: string } | null = null;
    let speakerRequestRunning = false;
    const pendingNewerSegments = pendingNewerSegmentsRef.current;

    const loadOlderSpeakers = async () => {
      if (!callSessionId || !olderCursor || speakerRequestRunning || disposed) return;
      speakerRequestRunning = true;
      setLoadingOlderSpeakers(true);
      olderController?.abort();
      olderController = new AbortController();
      const timeoutId = window.setTimeout(
        () => olderController?.abort(),
        SNAPSHOT_RECOVERY_TIMEOUT_MS
      );
      try {
        const cursor = `&beforeSequence=${encodeURIComponent(olderCursor.beforeSequence)}&beforeSegmentId=${encodeURIComponent(olderCursor.beforeSegmentId)}`;
        const response = await fetch(
          `/api/call-speakers?callSessionId=${encodeURIComponent(callSessionId)}${cursor}`,
          {
            cache: 'no-store',
            signal: olderController.signal,
            headers: callBrowserCapabilityHeaders(callSessionId),
          }
        );
        const snapshot = parseSpeakerSnapshotPayload(
          await requireSnapshotResponse(response),
          callSessionId
        );
        if (!snapshot) {
          throw new SnapshotRecoveryError(
            { kind: 'unknown', message: 'Earlier speaker history returned invalid data.' },
            true
          );
        }
        if (!disposed) {
          setSpeakerSegments((current) => {
            const merged = mergeSpeakerHistoryWindow(current, snapshot.segments, 'older');
            const previousNewest = current.at(-1);
            const retainedNewest = merged.at(-1);
            if (
              previousNewest &&
              retainedNewest &&
              (previousNewest.sequence > retainedNewest.sequence ||
                (previousNewest.sequence === retainedNewest.sequence &&
                  previousNewest.segmentId.localeCompare(retainedNewest.segmentId) > 0))
            ) {
              newerCursor = {
                afterSequence: retainedNewest.sequence,
                afterSegmentId: retainedNewest.segmentId,
              };
              browsingOlderRef.current = true;
              setHasNewerSpeakers(true);
            }
            return merged;
          });
          olderCursor =
            snapshot.hasMore &&
            snapshot.nextBeforeSequence !== null &&
            snapshot.nextBeforeSegmentId !== null
              ? {
                  beforeSequence: snapshot.nextBeforeSequence,
                  beforeSegmentId: snapshot.nextBeforeSegmentId,
                }
              : null;
          setHasOlderSpeakers(Boolean(olderCursor));
          setRecoveryIssue(null);
          setRecoveryRetryable(false);
        }
      } catch (error) {
        if (!disposed && !(error instanceof Error && error.name === 'AbortError')) {
          const issue =
            error instanceof SnapshotRecoveryError
              ? error.issue
              : {
                  kind: 'gateway_down' as const,
                  message: 'Earlier speaker history could not be loaded.',
                };
          setRecoveryIssue(issue);
          setRecoveryRetryable(true);
        }
      } finally {
        window.clearTimeout(timeoutId);
        speakerRequestRunning = false;
        if (!disposed) setLoadingOlderSpeakers(false);
      }
    };

    const loadNewerSpeakers = async () => {
      if (!callSessionId || !newerCursor || speakerRequestRunning || disposed) return;
      speakerRequestRunning = true;
      setLoadingNewerSpeakers(true);
      olderController?.abort();
      olderController = new AbortController();
      const timeoutId = window.setTimeout(
        () => olderController?.abort(),
        SNAPSHOT_RECOVERY_TIMEOUT_MS
      );
      try {
        const cursor = `&afterSequence=${encodeURIComponent(newerCursor.afterSequence)}&afterSegmentId=${encodeURIComponent(newerCursor.afterSegmentId)}`;
        const response = await fetch(
          `/api/call-speakers?callSessionId=${encodeURIComponent(callSessionId)}${cursor}`,
          {
            cache: 'no-store',
            signal: olderController.signal,
            headers: callBrowserCapabilityHeaders(callSessionId),
          }
        );
        const snapshot = parseSpeakerSnapshotPayload(
          await requireSnapshotResponse(response),
          callSessionId
        );
        if (!snapshot) {
          throw new SnapshotRecoveryError(
            { kind: 'unknown', message: 'Newer speaker history returned invalid data.' },
            true
          );
        }
        if (!disposed) {
          const finalPage = !snapshot.hasMore;
          const pendingLive = finalPage ? [...pendingNewerSegmentsRef.current.values()] : [];
          setSpeakerSegments((current) =>
            mergeSpeakerHistoryWindow(current, [...snapshot.segments, ...pendingLive], 'newer')
          );
          const last = snapshot.segments.at(-1);
          newerCursor =
            snapshot.hasMore && last
              ? {
                  afterSequence: snapshot.nextAfterSequence ?? last.sequence,
                  afterSegmentId: snapshot.nextAfterSegmentId ?? last.segmentId,
                }
              : null;
          browsingOlderRef.current = Boolean(newerCursor);
          setHasNewerSpeakers(Boolean(newerCursor));
          if (!newerCursor) pendingNewerSegmentsRef.current.clear();
          setRecoveryIssue(null);
          setRecoveryRetryable(false);
        }
      } catch (error) {
        if (!disposed && !(error instanceof Error && error.name === 'AbortError')) {
          setRecoveryIssue({
            kind: 'gateway_down',
            message: 'Newer speaker history could not be loaded.',
          });
          setRecoveryRetryable(true);
        }
      } finally {
        window.clearTimeout(timeoutId);
        speakerRequestRunning = false;
        if (!disposed) setLoadingNewerSpeakers(false);
      }
    };
    const loadSnapshot = async () => {
      if (!callSessionId || disposed) {
        return;
      }
      snapshotController?.abort();
      snapshotController = new AbortController();
      const signal = snapshotController.signal;
      let timedOut = false;
      const timeoutId = window.setTimeout(() => {
        timedOut = true;
        snapshotController?.abort();
      }, SNAPSHOT_RECOVERY_TIMEOUT_MS);
      const results = await Promise.allSettled([
        (async () => {
          let cursor = '';
          const seenCursors = new Set<string>();
          for (let pageIndex = 0; pageIndex < 64; pageIndex += 1) {
            const response = await fetch(
              `/api/call-tasks?callSessionId=${encodeURIComponent(callSessionId)}${cursor}`,
              { cache: 'no-store', signal, headers: callBrowserCapabilityHeaders(callSessionId) }
            );
            const snapshot = parseSnapshotPayload(
              await requireSnapshotResponse(response),
              callSessionId
            );
            if (!snapshot) {
              throw new SnapshotRecoveryError(
                { kind: 'unknown', message: 'Call task recovery returned invalid data.' },
                true
              );
            }
            if (!disposed) {
              snapshot.tasks.forEach((event) => applyTaskEventToStore(store, event));
              setTasks(store.taskViews);
            }
            if (!snapshot.hasMore || !snapshot.nextBeforeCreatedAt || !snapshot.nextBeforeTaskId) {
              break;
            }
            const nextCursor = `&beforeCreatedAt=${encodeURIComponent(snapshot.nextBeforeCreatedAt)}&beforeTaskId=${encodeURIComponent(snapshot.nextBeforeTaskId)}`;
            if (seenCursors.has(nextCursor)) {
              throw new SnapshotRecoveryError(
                { kind: 'unknown', message: 'Call task recovery returned a repeated cursor.' },
                true
              );
            }
            seenCursors.add(nextCursor);
            cursor = nextCursor;
          }
        })(),
        (async () => {
          const response = await fetch(
            `/api/call-speakers?callSessionId=${encodeURIComponent(callSessionId)}`,
            { cache: 'no-store', signal, headers: callBrowserCapabilityHeaders(callSessionId) }
          );
          const snapshot = parseSpeakerSnapshotPayload(
            await requireSnapshotResponse(response),
            callSessionId
          );
          if (!snapshot) {
            throw new SnapshotRecoveryError(
              { kind: 'unknown', message: 'Call speaker recovery returned invalid data.' },
              true
            );
          }
          if (!disposed) {
            snapshot.segments.forEach((segment) => applySpeakerSegmentToStore(store, segment));
            setSpeakerSegments((current) =>
              mergeSpeakerHistoryWindow(current, snapshot.segments, 'newer')
            );
            setLatestSpeakerSegment(snapshot.segments.at(-1) ?? null);
            newerCursor = null;
            browsingOlderRef.current = false;
            pendingNewerSegmentsRef.current.clear();
            setHasNewerSpeakers(false);
            olderCursor =
              snapshot.hasMore &&
              snapshot.nextBeforeSequence !== null &&
              snapshot.nextBeforeSegmentId !== null
                ? {
                    beforeSequence: snapshot.nextBeforeSequence,
                    beforeSegmentId: snapshot.nextBeforeSegmentId,
                  }
                : null;
            setHasOlderSpeakers(Boolean(olderCursor));
          }
        })(),
      ]);
      window.clearTimeout(timeoutId);
      if (disposed || (signal.aborted && !timedOut)) {
        return;
      }
      const rejected = results.find((result) => result.status === 'rejected');
      if (timedOut) {
        setRecoveryIssue({
          kind: 'gateway_down',
          message:
            'Call activity recovery timed out. Live conversation can continue while you retry.',
        });
        setRecoveryRetryable(true);
        return;
      }
      if (rejected?.status === 'rejected') {
        const reason = rejected.reason;
        if (reason instanceof SnapshotRecoveryError) {
          setRecoveryIssue(reason.issue);
          setRecoveryRetryable(reason.retryable);
        } else if (!(reason instanceof Error && reason.name === 'AbortError')) {
          setRecoveryIssue({
            kind: reason instanceof TypeError ? 'gateway_down' : 'unknown',
            message: 'Call activity recovery failed. Live conversation can continue.',
          });
          setRecoveryRetryable(reason instanceof TypeError);
        }
        console.warn('[Viventium] Call reconnect snapshot recovery failed');
        return;
      }
      setRecoveryIssue(null);
      setRecoveryRetryable(false);
    };
    const handleReconnected = () => {
      void loadSnapshot();
    };
    const stopRecovery = () => {
      if (disposed) return;
      disposed = true;
      snapshotController?.abort();
      olderController?.abort();
      loadSnapshotRef.current = null;
      applyTaskEventRef.current = null;
      loadOlderSpeakersRef.current = null;
      loadNewerSpeakersRef.current = null;
      room.off(RoomEvent.DataReceived, handleDataReceived);
      room.off(RoomEvent.Reconnected, handleReconnected);
    };
    stopRecoveryRef.current = stopRecovery;
    loadSnapshotRef.current = () => void loadSnapshot();
    applyTaskEventRef.current = (event) => {
      if (event.callSessionId !== callSessionId) return;
      const previous = store.taskViews;
      const applied = applyTaskEventToStore(store, event);
      if (applied !== previous) setTasks(applied);
    };
    loadOlderSpeakersRef.current = () => void loadOlderSpeakers();
    loadNewerSpeakersRef.current = () => void loadNewerSpeakers();

    room.on(RoomEvent.DataReceived, handleDataReceived);
    room.on(RoomEvent.Reconnected, handleReconnected);
    void loadSnapshot();

    return () => {
      stopRecovery();
      if (stopRecoveryRef.current === stopRecovery) stopRecoveryRef.current = null;
      setTasks([]);
      setSpeakerSegments([]);
      setLatestSpeakerSegment(null);
      setRecoveryIssue(null);
      setRecoveryRetryable(false);
      setHasOlderSpeakers(false);
      setLoadingOlderSpeakers(false);
      setHasNewerSpeakers(false);
      setLoadingNewerSpeakers(false);
      browsingOlderRef.current = false;
      pendingNewerSegments.clear();
    };
  }, [callSessionId, expectedAgentIdentities, room]);

  const retryRecovery = React.useCallback(() => loadSnapshotRef.current?.(), []);
  const applyAuthoritativeTaskEvent = React.useCallback(
    (event: VoiceTaskEventV1) => applyTaskEventRef.current?.(event),
    []
  );
  const loadOlderSpeakers = React.useCallback(() => loadOlderSpeakersRef.current?.(), []);
  const loadNewerSpeakers = React.useCallback(() => loadNewerSpeakersRef.current?.(), []);
  const stopRecovery = React.useCallback(() => {
    stoppedCallSessionIdRef.current = callSessionId;
    stopRecoveryRef.current?.();
  }, [callSessionId]);

  return React.useMemo(
    () => ({
      tasks,
      speakerSegments,
      latestSpeakerSegment,
      recoveryIssue,
      recoveryRetryable,
      retryRecovery,
      applyAuthoritativeTaskEvent,
      hasOlderSpeakers,
      loadingOlderSpeakers,
      loadOlderSpeakers,
      hasNewerSpeakers,
      loadingNewerSpeakers,
      loadNewerSpeakers,
      stopRecovery,
    }),
    [
      hasOlderSpeakers,
      hasNewerSpeakers,
      latestSpeakerSegment,
      loadOlderSpeakers,
      loadNewerSpeakers,
      stopRecovery,
      loadingOlderSpeakers,
      loadingNewerSpeakers,
      recoveryIssue,
      recoveryRetryable,
      retryRecovery,
      applyAuthoritativeTaskEvent,
      speakerSegments,
      tasks,
    ]
  );
}
