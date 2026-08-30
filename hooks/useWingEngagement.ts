'use client';

import * as React from 'react';
import type { UseSessionReturn } from '@livekit/components-react';
import type { VoiceCallMode } from '@/hooks/useCallSessionState';
import {
  CALL_CAPABILITY_HEADER,
  callBrowserCapabilityHeaders,
} from '@/lib/call-browser-capability';
import { parseCallIdentifier } from '@/lib/call-proxy';
import { type SpeakerSegmentV1, parseSpeakerSegment } from '@/lib/voice-events';

export const VIVENTIUM_VOICE_ENGAGEMENT_TOPIC = 'viventium.voice.engagement.v1';

const MAX_CLASSIFICATION_DURATION_MS = 9_000;
const MAX_ATTESTATION_LIFETIME_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 5_000;
const MAX_TRACKED_TURNS = 256;
const MAX_SEGMENT_IDS = 32;
const MAX_PUBLICATION_ATTEMPTS = 3;
const PUBLICATION_RETRY_DELAY_MS = 75;
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;
const VERDICT_FIELDS = new Set([
  'version',
  'callSessionId',
  'turnId',
  'participantIdentity',
  'segmentIds',
  'directlyAddressed',
  'source',
  'revision',
  'issuedAtMs',
  'expiresAtMs',
  'attestation',
]);

type WingEngagementOptions = {
  session: UseSessionReturn;
  callSessionId: string | null;
  mode: VoiceCallMode;
  modePending?: boolean;
  speakerSegment: SpeakerSegmentV1 | null | undefined;
};

type VoiceEngagementVerdictV1 = {
  version: 1;
  callSessionId: string;
  turnId: string;
  participantIdentity: string;
  segmentIds: string[];
  directlyAddressed: boolean;
  source: 'semantic_model';
  revision: number;
  issuedAtMs: number;
  expiresAtMs: number;
  attestation: string;
};

type PendingSignedPublication = {
  verdict: VoiceEngagementVerdictV1;
  participantIdentity: string;
  gatewayIdentity: string;
  room: UseSessionReturn['room'];
  segmentId: string;
  segmentText: string;
  segmentRevision: number;
  requestStartedAtMs: number;
  attempts: number;
  publishing: boolean;
};

function resolveGatewayParticipantIdentity(
  room: UseSessionReturn['room'],
  ownerIdentity: string
): string | null {
  const participants = room.remoteParticipants;
  if (!participants || typeof participants.entries !== 'function') {
    return null;
  }

  let gatewayIdentity: string | null = null;
  for (const [roomIdentity, participant] of participants.entries()) {
    if (participant?.isAgent !== true) {
      continue;
    }

    const participantIdentity = participant.identity;
    if (
      gatewayIdentity !== null ||
      parseCallIdentifier(participantIdentity) !== participantIdentity ||
      participantIdentity !== roomIdentity ||
      participantIdentity === ownerIdentity
    ) {
      return null;
    }
    gatewayIdentity = participantIdentity;
  }

  return gatewayIdentity;
}

function finalOwnerSegment(
  segment: SpeakerSegmentV1 | null | undefined,
  callSessionId: string,
  participantIdentity: string
): segment is SpeakerSegmentV1 {
  const parsed = parseSpeakerSegment(segment);
  return Boolean(
    parsed &&
      parsed.callSessionId === callSessionId &&
      parseCallIdentifier(parsed.turnId) === parsed.turnId &&
      parseCallIdentifier(parsed.segmentId) === parsed.segmentId &&
      parsed.isFinal === true &&
      parsed.revision > 0 &&
      parsed.overlap !== true &&
      parsed.uncertain !== true &&
      parsed.speaker.attribution === 'verified' &&
      parsed.speaker.actorTrust === 'owner_participant' &&
      participantIdentity.length > 0 &&
      parsed.speaker.participantIdentity === participantIdentity
  );
}

function parseSignedVerdict(
  candidate: unknown,
  segment: SpeakerSegmentV1,
  participantIdentity: string,
  requestStartedAtMs: number
): VoiceEngagementVerdictV1 | null {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }
  const value = candidate as Record<string, unknown>;
  const keys = Object.keys(value);
  const nowMs = Date.now();
  if (
    keys.length !== VERDICT_FIELDS.size ||
    keys.some((field) => !VERDICT_FIELDS.has(field)) ||
    value.version !== 1 ||
    value.callSessionId !== segment.callSessionId ||
    value.turnId !== segment.turnId ||
    value.participantIdentity !== participantIdentity ||
    !Array.isArray(value.segmentIds) ||
    value.segmentIds.length === 0 ||
    value.segmentIds.length > MAX_SEGMENT_IDS ||
    value.segmentIds.some((segmentId) => parseCallIdentifier(segmentId) !== segmentId) ||
    new Set(value.segmentIds).size !== value.segmentIds.length ||
    !value.segmentIds.includes(segment.segmentId) ||
    typeof value.directlyAddressed !== 'boolean' ||
    value.source !== 'semantic_model' ||
    typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < segment.revision ||
    (value.segmentIds.length === 1 && value.revision !== segment.revision) ||
    typeof value.issuedAtMs !== 'number' ||
    !Number.isSafeInteger(value.issuedAtMs) ||
    typeof value.expiresAtMs !== 'number' ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    value.expiresAtMs <= value.issuedAtMs ||
    value.expiresAtMs - value.issuedAtMs > MAX_ATTESTATION_LIFETIME_MS ||
    nowMs < value.issuedAtMs - MAX_CLOCK_SKEW_MS ||
    nowMs >= value.expiresAtMs ||
    value.issuedAtMs < requestStartedAtMs - MAX_CLOCK_SKEW_MS ||
    typeof value.attestation !== 'string' ||
    !BASE64URL_SHA256.test(value.attestation)
  ) {
    return null;
  }

  return value as VoiceEngagementVerdictV1;
}

function rememberRevision(history: Map<string, number>, turnKey: string, revision: number) {
  history.set(turnKey, revision);
  while (history.size > MAX_TRACKED_TURNS) {
    const oldestTurn = history.keys().next().value;
    if (oldestTurn === undefined) break;
    history.delete(oldestTurn);
  }
}

function currentPublicationAuthority(
  pending: PendingSignedPublication,
  active: WingEngagementOptions,
  requireConnected = true
): boolean {
  const segment = active.speakerSegment;
  return Boolean(
    Date.now() < pending.requestStartedAtMs + MAX_CLASSIFICATION_DURATION_MS &&
      active.mode === 'wing' &&
      !active.modePending &&
      active.callSessionId === pending.verdict.callSessionId &&
      active.session.room === pending.room &&
      active.session.room.localParticipant.identity === pending.participantIdentity &&
      segment &&
      segment.turnId === pending.verdict.turnId &&
      segment.segmentId === pending.segmentId &&
      segment.text === pending.segmentText &&
      segment.revision === pending.segmentRevision &&
      finalOwnerSegment(segment, pending.verdict.callSessionId, pending.participantIdentity) &&
      parseSignedVerdict(
        pending.verdict,
        segment,
        pending.participantIdentity,
        pending.requestStartedAtMs
      ) &&
      (!requireConnected ||
        (active.session.isConnected &&
          resolveGatewayParticipantIdentity(active.session.room, pending.participantIdentity) ===
            pending.gatewayIdentity))
  );
}

/** Relays only Core-signed model decisions for the current trusted Wing owner turn. */
export function useWingEngagement({
  session,
  callSessionId,
  mode,
  modePending = false,
  speakerSegment,
}: WingEngagementOptions): void {
  const observedInactiveTurns = React.useRef(new Map<string, number>());
  const attemptedTurnRevisions = React.useRef(new Map<string, number>());
  const pendingPublication = React.useRef<PendingSignedPublication | null>(null);
  const retryTimeout = React.useRef<number | null>(null);
  const mounted = React.useRef(false);
  const [retryGeneration, retryPublication] = React.useReducer((generation: number) => {
    return generation + 1;
  }, 0);
  const current = React.useRef<WingEngagementOptions>({
    session,
    callSessionId,
    mode,
    modePending,
    speakerSegment,
  });
  current.current = { session, callSessionId, mode, modePending, speakerSegment };
  const room = session.room;
  const connected = session.isConnected;
  const participantIdentity = room.localParticipant.identity;
  const gatewayIdentity = resolveGatewayParticipantIdentity(room, participantIdentity);
  // Segment identity is deliberately absent: Core signs the entire finalized turn, so another
  // equally trusted segment at the same turn/revision must not abort or duplicate classification.
  const speakerFingerprint = speakerSegment
    ? [
        speakerSegment.version,
        speakerSegment.callSessionId,
        speakerSegment.turnId,
        speakerSegment.revision,
        speakerSegment.isFinal,
        speakerSegment.overlap === true,
        speakerSegment.uncertain === true,
        speakerSegment.speaker?.attribution,
        speakerSegment.speaker?.actorTrust,
        speakerSegment.speaker?.participantIdentity,
      ].join('\u0000')
    : '';

  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pendingPublication.current = null;
      if (retryTimeout.current !== null) {
        window.clearTimeout(retryTimeout.current);
        retryTimeout.current = null;
      }
    };
  }, []);

  React.useEffect(() => {
    if (retryTimeout.current !== null) {
      window.clearTimeout(retryTimeout.current);
      retryTimeout.current = null;
    }
    const speakerSegment = current.current.speakerSegment;
    if (!callSessionId || !speakerFingerprint || !speakerSegment) {
      pendingPublication.current = null;
      return;
    }
    const turnKey = `${callSessionId}\u0000${speakerSegment.turnId}`;
    const attemptedRevisions = attemptedTurnRevisions.current;
    let pending = pendingPublication.current;
    if (pending && !currentPublicationAuthority(pending, current.current, false)) {
      pendingPublication.current = null;
      pending = null;
    }
    if (mode !== 'wing' || modePending || !connected) {
      if (speakerSegment.callSessionId === callSessionId && !(pending && !connected)) {
        rememberRevision(observedInactiveTurns.current, turnKey, speakerSegment.revision);
      }
      return;
    }

    const participant = room.localParticipant;
    if (
      typeof participantIdentity !== 'string' ||
      typeof participant.publishData !== 'function' ||
      !gatewayIdentity ||
      resolveGatewayParticipantIdentity(room, participantIdentity) !== gatewayIdentity ||
      !finalOwnerSegment(speakerSegment, callSessionId, participantIdentity) ||
      (observedInactiveTurns.current.get(turnKey) ?? -1) >= speakerSegment.revision ||
      (!pending && (attemptedRevisions.get(turnKey) ?? -1) >= speakerSegment.revision) ||
      (pending &&
        (!currentPublicationAuthority(pending, current.current) ||
          pending.gatewayIdentity !== gatewayIdentity))
    ) {
      if (pending) {
        pendingPublication.current = null;
      }
      return;
    }

    const browserCapabilityHeaders = pending ? null : callBrowserCapabilityHeaders(callSessionId);
    if (!pending && !browserCapabilityHeaders?.[CALL_CAPABILITY_HEADER]) {
      return;
    }
    if (!pending) {
      rememberRevision(attemptedRevisions, turnKey, speakerSegment.revision);
    }
    if (pending?.publishing) {
      return;
    }

    const controller = new AbortController();
    const requestStartedAtMs = pending?.requestStartedAtMs ?? Date.now();
    const remainingDurationMs = requestStartedAtMs + MAX_CLASSIFICATION_DURATION_MS - Date.now();
    if (remainingDurationMs <= 0) {
      pendingPublication.current = null;
      return;
    }
    const timeoutId = window.setTimeout(() => {
      controller.abort();
      const activePending = pendingPublication.current;
      if (
        activePending?.requestStartedAtMs === requestStartedAtMs &&
        activePending.verdict.turnId === speakerSegment.turnId
      ) {
        pendingPublication.current = null;
      }
    }, remainingDurationMs);
    let disposed = false;
    let settled = false;

    const publishSignedVerdict = async (publication: PendingSignedPublication) => {
      if (
        !mounted.current ||
        pendingPublication.current !== publication ||
        publication.publishing ||
        publication.attempts >= MAX_PUBLICATION_ATTEMPTS ||
        !currentPublicationAuthority(publication, current.current)
      ) {
        return;
      }

      publication.attempts += 1;
      publication.publishing = true;
      try {
        await current.current.session.room.localParticipant.publishData(
          new TextEncoder().encode(JSON.stringify(publication.verdict)),
          {
            reliable: true,
            topic: VIVENTIUM_VOICE_ENGAGEMENT_TOPIC,
            destinationIdentities: [publication.gatewayIdentity],
          }
        );
        publication.publishing = false;
        if (pendingPublication.current === publication) {
          pendingPublication.current = null;
        }
      } catch {
        publication.publishing = false;
        if (!mounted.current || pendingPublication.current !== publication) {
          return;
        }
        const active = current.current;
        const retryDeadlineMs = Math.min(
          publication.verdict.expiresAtMs,
          publication.requestStartedAtMs + MAX_CLASSIFICATION_DURATION_MS
        );
        if (
          publication.attempts >= MAX_PUBLICATION_ATTEMPTS ||
          Date.now() + PUBLICATION_RETRY_DELAY_MS >= retryDeadlineMs ||
          !currentPublicationAuthority(publication, active, false)
        ) {
          pendingPublication.current = null;
          return;
        }
        if (!active.session.isConnected) {
          return;
        }
        if (!currentPublicationAuthority(publication, active)) {
          const participants = active.session.room.remoteParticipants;
          const gatewayAbsent =
            !participants.has(publication.gatewayIdentity) &&
            Array.from(participants.values()).every((remote) => remote.isAgent !== true);
          if (gatewayAbsent) {
            return;
          }
          pendingPublication.current = null;
          return;
        }
        retryTimeout.current = window.setTimeout(() => {
          retryTimeout.current = null;
          if (
            mounted.current &&
            pendingPublication.current === publication &&
            currentPublicationAuthority(publication, current.current)
          ) {
            retryPublication();
          }
        }, PUBLICATION_RETRY_DELAY_MS);
      }
    };

    void (async () => {
      try {
        if (pending) {
          await publishSignedVerdict(pending);
          return;
        }
        const response = await fetch('/api/call-engagement', {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            ...browserCapabilityHeaders,
          },
          body: JSON.stringify({
            version: 1,
            callSessionId,
            turnId: speakerSegment.turnId,
          }),
          signal: controller.signal,
        });
        if (!response.ok || disposed || controller.signal.aborted) {
          return;
        }
        const payload: unknown = await response.json().catch(() => null);
        const active = current.current;
        const activeSegment = active.speakerSegment;
        if (
          disposed ||
          controller.signal.aborted ||
          active.mode !== 'wing' ||
          active.modePending ||
          !active.session.isConnected ||
          active.callSessionId !== callSessionId ||
          active.session.room !== room ||
          !activeSegment ||
          activeSegment.turnId !== speakerSegment.turnId ||
          activeSegment.revision !== speakerSegment.revision ||
          !finalOwnerSegment(activeSegment, callSessionId, participantIdentity)
        ) {
          return;
        }

        const verdict = parseSignedVerdict(
          payload,
          activeSegment,
          participantIdentity,
          requestStartedAtMs
        );
        if (
          !verdict ||
          disposed ||
          controller.signal.aborted ||
          resolveGatewayParticipantIdentity(active.session.room, participantIdentity) !==
            gatewayIdentity
        ) {
          return;
        }

        rememberRevision(attemptedRevisions, turnKey, verdict.revision);
        pending = {
          verdict,
          participantIdentity,
          gatewayIdentity,
          room,
          segmentId: activeSegment.segmentId,
          segmentText: activeSegment.text,
          segmentRevision: activeSegment.revision,
          requestStartedAtMs,
          attempts: 0,
          publishing: false,
        };
        pendingPublication.current = pending;
        await publishSignedVerdict(pending);
      } catch {
        // Missing, unavailable, aborted, or malformed authority is always silent non-engagement.
      } finally {
        settled = true;
        window.clearTimeout(timeoutId);
      }
    })();

    return () => {
      const active = current.current;
      const activeSegment = active.speakerSegment;
      disposed = true;
      controller.abort();
      window.clearTimeout(timeoutId);
      if (
        !settled &&
        active.mode === 'wing' &&
        !active.modePending &&
        active.session.isConnected &&
        active.callSessionId === callSessionId &&
        active.session.room === room &&
        activeSegment &&
        activeSegment.turnId === speakerSegment.turnId &&
        activeSegment.revision === speakerSegment.revision &&
        finalOwnerSegment(activeSegment, callSessionId, participantIdentity) &&
        resolveGatewayParticipantIdentity(active.session.room, participantIdentity) ===
          gatewayIdentity &&
        attemptedRevisions.get(turnKey) === speakerSegment.revision
      ) {
        // React Strict Mode immediately remounts the same trusted effect after aborting it.
        // Preserve replay barriers on real mode, participant, room, turn, or revision changes.
        attemptedRevisions.delete(turnKey);
      }
    };
  }, [
    callSessionId,
    connected,
    gatewayIdentity,
    mode,
    modePending,
    participantIdentity,
    room,
    retryGeneration,
    speakerFingerprint,
  ]);
}
