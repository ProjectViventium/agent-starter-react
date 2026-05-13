/* VIVENTIUM START
 * Purpose: Viventium modern-playground transcript stability helpers.
 *
 * Why:
 * - LiveKit can surface the same stream id more than once across chat/transcript channels.
 * - User transcription segments may update from partial to final text under the same segment id.
 * - Identical human phrases from different streams must remain distinct messages.
 * VIVENTIUM END */

type MessageLike = {
  id?: string;
  type?: string;
  timestamp?: number;
  message?: string;
  from?: {
    identity?: string;
    isLocal?: boolean;
  };
  attributes?: Record<string, string> | undefined;
  streamInfo?: {
    attributes?: Record<string, string> | undefined;
  };
};

type DedupeOptions = {
  firstSeenMsById?: Map<string, number>;
  transcriptDuplicateWindowMs?: number;
};

const DEFAULT_TRANSCRIPT_DUPLICATE_WINDOW_MS = 1500;

function getSegmentId(message: MessageLike): string | null {
  const attributes = message.streamInfo?.attributes ?? message.attributes;
  const segmentId = attributes?.['lk.segment_id']?.trim();
  return segmentId || null;
}

function getSpeakerIdentity(message: MessageLike): string {
  return message.from?.identity?.trim() || '';
}

function getTranscriptSegmentKey(message: MessageLike): string | null {
  if (message.type !== 'userTranscript') {
    return null;
  }
  const segmentId = getSegmentId(message);
  if (!segmentId) {
    return null;
  }
  return `${getSpeakerIdentity(message)}\0${segmentId}`;
}

function normalizeTranscriptText(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase()
    : '';
}

function getMessageSeenMs(message: MessageLike, firstSeenMsById?: Map<string, number>): number {
  const id = message.id?.trim();
  if (id && firstSeenMsById?.has(id)) {
    return firstSeenMsById.get(id) ?? 0;
  }
  return Number.isFinite(message.timestamp) ? Number(message.timestamp) : 0;
}

function getTranscriptDuplicateTextKey(message: MessageLike): string | null {
  const hasSegmentId = Boolean(getSegmentId(message));
  if (hasSegmentId) {
    return null;
  }
  const isTranscriptLike =
    message.type === 'userTranscript' ||
    (message.type === 'chatMessage' && message.from?.isLocal === true);
  if (!isTranscriptLike) {
    return null;
  }
  const speaker = getSpeakerIdentity(message);
  const text = normalizeTranscriptText(message.message);
  if (!speaker || !text) {
    return null;
  }
  return `${speaker}\0${text}`;
}

function shouldReplaceTranscriptDuplicate(current: MessageLike, incoming: MessageLike) {
  const currentTextLength = normalizeTranscriptText(current.message).length;
  const incomingTextLength = normalizeTranscriptText(incoming.message).length;
  if (incomingTextLength !== currentTextLength) {
    return incomingTextLength > currentTextLength;
  }
  const currentTimestamp = Number.isFinite(current.timestamp) ? Number(current.timestamp) : 0;
  const incomingTimestamp = Number.isFinite(incoming.timestamp) ? Number(incoming.timestamp) : 0;
  return incomingTimestamp >= currentTimestamp;
}

export function dedupeMessagesById<T extends MessageLike>(
  messages: T[],
  options: DedupeOptions = {}
): T[] {
  const byId = new Map<string, number>();
  const byTranscriptSegment = new Map<string, number>();
  const byTranscriptText = new Map<string, number[]>();
  const transcriptDuplicateWindowMs =
    options.transcriptDuplicateWindowMs ?? DEFAULT_TRANSCRIPT_DUPLICATE_WINDOW_MS;
  const deduped: T[] = [];

  for (const message of messages) {
    const id = message.id?.trim();
    if (id) {
      if (byId.has(id)) {
        continue;
      }
      byId.set(id, deduped.length);
    }

    const segmentKey = getTranscriptSegmentKey(message);
    if (segmentKey) {
      const existingIndex = byTranscriptSegment.get(segmentKey);
      if (existingIndex !== undefined) {
        deduped[existingIndex] = message;
        if (id) {
          byId.set(id, existingIndex);
        }
        continue;
      }
      byTranscriptSegment.set(segmentKey, deduped.length);
    }

    const transcriptTextKey = getTranscriptDuplicateTextKey(message);
    if (transcriptTextKey && transcriptDuplicateWindowMs > 0) {
      const candidateIndexes = byTranscriptText.get(transcriptTextKey) ?? [];
      const currentSeenMs = getMessageSeenMs(message, options.firstSeenMsById);
      const existingIndex = [...candidateIndexes].reverse().find((candidateIndex) => {
        const existingMessage = deduped[candidateIndex];
        if (!existingMessage) {
          return false;
        }
        if (existingMessage.type === 'chatMessage' && message.type === 'chatMessage') {
          return false;
        }
        const existingSeenMs = getMessageSeenMs(existingMessage, options.firstSeenMsById);
        return Math.abs(currentSeenMs - existingSeenMs) <= transcriptDuplicateWindowMs;
      });

      if (existingIndex !== undefined) {
        if (shouldReplaceTranscriptDuplicate(deduped[existingIndex], message)) {
          deduped[existingIndex] = message;
        }
        if (id) {
          byId.set(id, existingIndex);
        }
        continue;
      }

      candidateIndexes.push(deduped.length);
      byTranscriptText.set(transcriptTextKey, candidateIndexes);
    }

    deduped.push(message);
  }

  return deduped;
}
