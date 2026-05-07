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
  from?: {
    identity?: string;
  };
  attributes?: Record<string, string> | undefined;
  streamInfo?: {
    attributes?: Record<string, string> | undefined;
  };
};

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

export function dedupeMessagesById<T extends MessageLike>(messages: T[]): T[] {
  const byId = new Map<string, number>();
  const byTranscriptSegment = new Map<string, number>();
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

    deduped.push(message);
  }

  return deduped;
}
