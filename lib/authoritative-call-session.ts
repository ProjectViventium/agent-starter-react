import { CALL_CAPABILITY_HEADER } from '@/lib/call-browser-capability';
import { normalizeProxyFailure, parseCallIdentifier } from '@/lib/call-proxy';
import type { CallIssueKind } from '@/lib/call-start';

type AuthoritativeVoiceRoute = {
  stt: { provider: string; variant: string | null };
  tts: { provider: string; variant: string | null };
};

export type AuthoritativeCallStatus =
  | 'created'
  | 'connecting'
  | 'listening'
  | 'speaking'
  | 'working'
  | 'needs_input'
  | 'degraded'
  | 'failed'
  | 'ended';

const AUTHORITATIVE_CALL_STATUSES = new Set<AuthoritativeCallStatus>([
  'created',
  'connecting',
  'listening',
  'speaking',
  'working',
  'needs_input',
  'degraded',
  'failed',
  'ended',
]);

export type AuthoritativeCallSession = {
  callSessionId: string;
  roomName: string;
  gatewayAgentName: string;
  ownerParticipantIdentity: string;
  status: AuthoritativeCallStatus;
  requestedVoiceRoute: AuthoritativeVoiceRoute;
};

export type AuthoritativeTokenRequest = {
  room_name: string;
  participant_identity: string;
  roomName?: string;
  participantIdentity?: string;
  participant_metadata?: string;
  participantMetadata?: string;
  participant_attributes?: Record<string, string>;
  participantAttributes?: Record<string, string>;
  room_config?: unknown;
  roomConfig?: unknown;
  agentName?: string;
  agentMetadata?: string;
};

export class AuthoritativeCallSessionError extends Error {
  constructor(
    readonly code: CallIssueKind,
    message: string,
    readonly status: number,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'AuthoritativeCallSessionError';
  }
}

function boundedCanonicalString(value: unknown, maximum = 200): string | null {
  return typeof value === 'string' && value.trim() && value.length <= maximum ? value.trim() : null;
}

function normalizeAuthoritativeCallStatus(value: unknown): AuthoritativeCallStatus | null {
  return typeof value === 'string' &&
    AUTHORITATIVE_CALL_STATUSES.has(value as AuthoritativeCallStatus)
    ? (value as AuthoritativeCallStatus)
    : null;
}

function normalizeAuthoritativeVoiceRoute(value: unknown): AuthoritativeVoiceRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const route = value as Record<string, unknown>;
  const selection = (candidate: unknown) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const record = candidate as Record<string, unknown>;
    const provider = boundedCanonicalString(record.provider, 100);
    const variant =
      record.variant === null || record.variant === undefined
        ? null
        : boundedCanonicalString(record.variant, 500);
    return provider && (record.variant === null || record.variant === undefined || variant)
      ? { provider, variant }
      : null;
  };
  const stt = selection(route.stt);
  const tts = selection(route.tts);
  return stt && tts ? { stt, tts } : null;
}

function normalizeAuthoritativeCallSession(
  payload: unknown,
  expectedCallSessionId: string
): AuthoritativeCallSession | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  const callSessionId = parseCallIdentifier(value.callSessionId);
  const roomName = boundedCanonicalString(value.roomName);
  const gatewayAgentName = boundedCanonicalString(value.gatewayAgentName);
  const ownerParticipantIdentity = boundedCanonicalString(value.ownerParticipantIdentity);
  const status = normalizeAuthoritativeCallStatus(value.status);
  const requestedVoiceRoute = normalizeAuthoritativeVoiceRoute(value.requestedVoiceRoute);
  return callSessionId === expectedCallSessionId &&
    roomName &&
    gatewayAgentName &&
    ownerParticipantIdentity &&
    status &&
    requestedVoiceRoute
    ? {
        callSessionId,
        roomName,
        gatewayAgentName,
        ownerParticipantIdentity,
        status,
        requestedVoiceRoute,
      }
    : null;
}

function canonicalRequestTimeoutMs() {
  const configured = Number(process.env.VIVENTIUM_CALL_SESSION_VOICE_SETTINGS_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 1 && configured <= 60_000
    ? configured
    : 5_000;
}

export async function fetchAuthoritativeCallSession(
  callSessionId: string,
  browserCapability: string
): Promise<AuthoritativeCallSession> {
  const validCallSessionId = parseCallIdentifier(callSessionId);
  const origin = process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  const secret = process.env.VIVENTIUM_CALL_SESSION_SECRET;
  if (!validCallSessionId || !origin || !secret) {
    throw new AuthoritativeCallSessionError(
      'gateway_down',
      'The signed call-session runtime is not configured.',
      503,
      false
    );
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, canonicalRequestTimeoutMs());
  let response: Response;
  try {
    response = await fetch(
      new URL(
        `/api/viventium/calls/${encodeURIComponent(validCallSessionId)}/state`,
        origin
      ).toString(),
      {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-SECRET': secret,
          'X-VIVENTIUM-CALL-SESSION': validCallSessionId,
          [CALL_CAPABILITY_HEADER]: browserCapability,
        },
        cache: 'no-store',
        signal: controller.signal,
      }
    );
  } catch {
    throw new AuthoritativeCallSessionError(
      'gateway_down',
      timedOut
        ? 'The signed call session did not respond in time.'
        : 'Viventium could not reach the signed call-session runtime.',
      timedOut ? 504 : 503,
      true
    );
  } finally {
    clearTimeout(timeoutId);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = normalizeProxyFailure(response.status, payload);
    throw new AuthoritativeCallSessionError(
      failure.code,
      failure.message,
      response.status,
      failure.retryable
    );
  }
  const payloadRecord =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  if (!payloadRecord || !normalizeAuthoritativeCallStatus(payloadRecord.status)) {
    throw new AuthoritativeCallSessionError(
      'gateway_down',
      'The signed call-session runtime returned an invalid call status.',
      502,
      true
    );
  }
  const canonical = normalizeAuthoritativeCallSession(payload, validCallSessionId);
  if (!canonical) {
    throw new AuthoritativeCallSessionError(
      'no_route',
      'The signed call session has no valid canonical voice route.',
      409,
      false
    );
  }
  return canonical;
}

export function applyAuthoritativeCallSession(
  options: AuthoritativeTokenRequest,
  canonical: AuthoritativeCallSession
): void {
  const browserRooms = [options.room_name, options.roomName].filter(
    (value): value is string => typeof value === 'string' && Boolean(value.trim())
  );
  if (browserRooms.some((roomName) => roomName !== canonical.roomName)) {
    throw new AuthoritativeCallSessionError(
      'auth_expired',
      'The signed call session does not match the requested room.',
      409,
      false
    );
  }
  options.room_name = canonical.roomName;
  options.roomName = canonical.roomName;
  options.participant_identity = canonical.ownerParticipantIdentity;
  options.participantIdentity = canonical.ownerParticipantIdentity;
  options.participant_metadata = JSON.stringify({ callSessionId: canonical.callSessionId });
  options.participantMetadata = options.participant_metadata;
  options.participant_attributes = undefined;
  options.participantAttributes = undefined;
  options.room_config = undefined;
  options.roomConfig = undefined;
  options.agentName = canonical.gatewayAgentName;
  options.agentMetadata = JSON.stringify({
    callSessionId: canonical.callSessionId,
    participantIdentity: canonical.ownerParticipantIdentity,
    requestedVoiceRoute: canonical.requestedVoiceRoute,
  });
}
