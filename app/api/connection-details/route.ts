/* VIVENTIUM START
 * Purpose: Viventium agent-starter customization.
 * Details: docs/requirements_and_learnings/05_Open_Source_Modifications.md#agent-starter-react
 * VIVENTIUM END */
import { NextResponse } from 'next/server';
import { AccessToken, AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import { AgentDispatch, JobStatus, RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import {
  AuthoritativeCallSessionError,
  applyAuthoritativeCallSession,
  fetchAuthoritativeCallSession,
} from '@/lib/authoritative-call-session';
import {
  CALL_CAPABILITY_HEADER,
  readRequestCallBrowserCapability,
} from '@/lib/call-browser-capability';
import { parseCallIdentifier } from '@/lib/call-proxy';

const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL;
const NEXT_PUBLIC_LIVEKIT_URL = process.env.NEXT_PUBLIC_LIVEKIT_URL;
const VIVENTIUM_LIBRECHAT_ORIGIN = process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
const VIVENTIUM_CALL_SESSION_SECRET = process.env.VIVENTIUM_CALL_SESSION_SECRET;
/* VIVENTIUM START
 * Purpose: Preserve localhost playground behavior while still returning the public LiveKit
 * signal URL for requests that actually came through the public HTTPS playground origin.
 * VIVENTIUM END */
const VIVENTIUM_PUBLIC_PLAYGROUND_URL = process.env.VIVENTIUM_PUBLIC_PLAYGROUND_URL;
const VIVENTIUM_PUBLIC_LIVEKIT_URL = process.env.VIVENTIUM_PUBLIC_LIVEKIT_URL;
const VIVENTIUM_LIVEKIT_AGENT_DISPATCH_MODE = process.env.VIVENTIUM_LIVEKIT_AGENT_DISPATCH_MODE;
const ALLOW_DIRECT_AGENT_DISPATCH =
  process.env.VIVENTIUM_ALLOW_DIRECT_AGENT_DISPATCH === '1' ||
  process.env.VIVENTIUM_ALLOW_DIRECT_AGENT_DISPATCH === 'true';
const CALL_SESSION_RECONNECT_GRACE_SECONDS = 60;
const DISPATCH_ASSIGNMENT_TIMEOUT_MS = Math.min(
  Math.max(Number(process.env.VIVENTIUM_CALL_DISPATCH_ASSIGN_TIMEOUT_MS) || 2500, 250),
  5000
);
const DISPATCH_ASSIGNMENT_POLL_MS = 100;
const remainingDispatchTimeMs = (deadlineMs: number) =>
  Math.max(1, Math.floor(deadlineMs - Date.now()));
type TokenRequest = {
  room_name: string;
  participant_identity: string;
  participant_name?: string;
  participant_metadata?: string;
  participant_attributes?: Record<string, string>;
  room_config?: ReturnType<RoomConfiguration['toJson']>;

  roomName?: string;
  participantIdentity?: string;
  participantName?: string;
  participantMetadata?: string;
  participantAttributes?: Record<string, string>;
  roomConfig?: ReturnType<RoomConfiguration['toJson']>;

  agentName?: string;
  agentMetadata?: string;
  reclaimDispatch?: boolean;
  // VIVENTIUM START
  agent_name?: string;
  agent_metadata?: string;
  // VIVENTIUM END
};

type PendingDispatchConfirmation = {
  callSessionId: string;
  claimId: string;
};

// don't cache the results
export const revalidate = 0;

async function createToken(request: TokenRequest) {
  const at = new AccessToken(API_KEY, API_SECRET, {
    identity: request.participant_identity,
    ttl: '10m',
  });

  at.addGrant({
    roomJoin: true,
    room: request.room_name,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
    canUpdateOwnMetadata: true,
  });

  if (request.participant_name) {
    at.name = request.participant_name;
  }
  if (request.participant_identity) {
    at.identity = request.participant_identity;
  }
  if (request.participant_metadata) {
    at.metadata = request.participant_metadata;
  }
  if (request.participant_attributes) {
    at.attributes = request.participant_attributes;
  }
  if (request.room_config) {
    at.roomConfig = RoomConfiguration.fromJson(request.room_config);
  }

  return at.toJwt();
}

function toDispatchHost(url: string | undefined): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'ws:') {
      parsed.protocol = 'http:';
    } else if (parsed.protocol === 'wss:') {
      parsed.protocol = 'https:';
    }
    return parsed.origin;
  } catch {
    return url;
  }
}

function normalizeOptions(body: unknown): TokenRequest {
  const options = (body ?? {}) as Partial<TokenRequest>;
  const roomConfig = options.room_config ?? options.roomConfig;
  // VIVENTIUM START
  // RoomConfiguration.toJson returns a JsonValue union, so guard before accessing fields.
  let agentFromRoomConfig: string | undefined;
  let metadataFromRoomConfig: string | undefined;
  if (roomConfig && typeof roomConfig === 'object' && !Array.isArray(roomConfig)) {
    const config = roomConfig as {
      agents?: Array<{ agent_name?: string; agentName?: string; metadata?: string }>;
    };
    const firstAgent = Array.isArray(config.agents) ? config.agents[0] : undefined;
    agentFromRoomConfig = firstAgent?.agent_name ?? firstAgent?.agentName;
    metadataFromRoomConfig = firstAgent?.metadata;
  }
  // VIVENTIUM END

  return {
    room_name: options.room_name ?? options.roomName ?? '',
    participant_identity:
      options.participant_identity ?? options.participantIdentity ?? options.participantName ?? '',
    participant_name: options.participant_name ?? options.participantName,
    participant_metadata: options.participant_metadata ?? options.participantMetadata,
    participant_attributes: options.participant_attributes ?? options.participantAttributes,
    room_config: roomConfig,

    roomName: options.roomName,
    participantIdentity: options.participantIdentity,
    participantName: options.participantName,
    participantMetadata: options.participantMetadata,
    participantAttributes: options.participantAttributes,
    roomConfig: options.roomConfig,

    agentName: options.agentName ?? options.agent_name ?? agentFromRoomConfig,
    agentMetadata: options.agentMetadata ?? options.agent_metadata ?? metadataFromRoomConfig,
    reclaimDispatch: options.reclaimDispatch === true,
  };
}

function addAgentDispatchToRoomConfig(
  options: TokenRequest,
  agentName: string,
  agentMetadata: string | undefined
): void {
  const existingConfig = options.room_config ?? options.roomConfig;
  const roomConfig = existingConfig
    ? RoomConfiguration.fromJson(existingConfig)
    : new RoomConfiguration();
  const metadata =
    typeof agentMetadata === 'string' && agentMetadata.length > 0 ? agentMetadata : undefined;
  const existingAgent = roomConfig.agents.find((entry) => entry.agentName === agentName);

  if (existingAgent) {
    if (metadata !== undefined) {
      existingAgent.metadata = metadata;
    }
  } else {
    roomConfig.agents.push(new RoomAgentDispatch({ agentName, metadata }));
  }

  const nextConfig = roomConfig.toJson() as ReturnType<RoomConfiguration['toJson']>;
  options.room_config = nextConfig;
  options.roomConfig = nextConfig;
}

function applyCallSessionRoomRetention(options: TokenRequest): void {
  const existingConfig = options.room_config ?? options.roomConfig;
  const roomConfig = existingConfig
    ? RoomConfiguration.fromJson(existingConfig)
    : new RoomConfiguration();
  roomConfig.departureTimeout = Math.max(
    roomConfig.departureTimeout || 0,
    CALL_SESSION_RECONNECT_GRACE_SECONDS
  );
  const nextConfig = roomConfig.toJson() as ReturnType<RoomConfiguration['toJson']>;
  options.room_config = nextConfig;
  options.roomConfig = nextConfig;
}

function extractDeepLinkFallbacks(req: Request) {
  const referer = req.headers.get('referer') || req.headers.get('referrer') || '';
  if (!referer) {
    return {
      agentName: null,
      callSessionId: null,
    };
  }

  try {
    const url = new URL(referer);
    const agentName = (url.searchParams.get('agentName') || '').trim() || null;
    const callSessionId = (url.searchParams.get('callSessionId') || '').trim() || null;
    return {
      agentName,
      callSessionId,
    };
  } catch {
    return {
      agentName: null,
      callSessionId: null,
    };
  }
}

/* VIVENTIUM START
 * Purpose: Route localhost callers to local LiveKit while secure public-origin callers receive
 * the public WSS origin. This prevents public-edge enablement from breaking same-machine QA.
 * VIVENTIUM END */
function normalizeOrigin(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function requestOrigin(req: Request): string | null {
  const originHeader = normalizeOrigin(req.headers.get('origin') ?? undefined);
  if (originHeader) {
    return originHeader;
  }

  const referer = normalizeOrigin(
    req.headers.get('referer') ?? req.headers.get('referrer') ?? undefined
  );
  if (referer) {
    return referer;
  }

  const forwardedProto = (req.headers.get('x-forwarded-proto') || '').trim();
  const forwardedHost = (
    req.headers.get('x-forwarded-host') ||
    req.headers.get('host') ||
    ''
  ).trim();
  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  try {
    return new URL(req.url).origin;
  } catch {
    return null;
  }
}

function resolveBrowserLiveKitUrl(req: Request): string | undefined {
  const publicPlaygroundOrigin = normalizeOrigin(VIVENTIUM_PUBLIC_PLAYGROUND_URL);
  const publicLivekitUrl = VIVENTIUM_PUBLIC_LIVEKIT_URL;
  if (publicPlaygroundOrigin && publicLivekitUrl && requestOrigin(req) === publicPlaygroundOrigin) {
    return publicLivekitUrl;
  }
  return NEXT_PUBLIC_LIVEKIT_URL ?? LIVEKIT_URL;
}

function parseCallSessionIdFromAgentMetadata(agentMetadata: string | undefined): string | null {
  if (!agentMetadata || typeof agentMetadata !== 'string') {
    return null;
  }
  const trimmed = agentMetadata.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as { callSessionId?: unknown };
    const value = typeof parsed?.callSessionId === 'string' ? parsed.callSessionId.trim() : '';
    return value || null;
  } catch {
    return null;
  }
}

function dispatchRequiresCallSession(): boolean {
  return !ALLOW_DIRECT_AGENT_DISPATCH;
}

function callSessionUsesExplicitAgentDispatch(): boolean {
  const mode = (VIVENTIUM_LIVEKIT_AGENT_DISPATCH_MODE || '').trim().toLowerCase();
  return mode !== 'token_room_config' && mode !== 'room_config';
}

type ExplicitDispatchAttempt = {
  cancelled: boolean;
  createdDispatchId?: string;
};

function metadataForDispatchClaim(
  agentMetadata: string | undefined,
  dispatchClaimId: string | null
): string | undefined {
  if (!dispatchClaimId) return agentMetadata;
  try {
    const parsed = JSON.parse(agentMetadata || '{}') as Record<string, unknown>;
    return JSON.stringify({ ...parsed, dispatchClaimId });
  } catch {
    return JSON.stringify({ dispatchClaimId });
  }
}

async function deleteExplicitAgentDispatch(dispatchId: string, roomName: string): Promise<void> {
  const host =
    toDispatchHost(process.env.LIVEKIT_API_HOST) ??
    toDispatchHost(process.env.LIVEKIT_URL) ??
    toDispatchHost(process.env.NEXT_PUBLIC_LIVEKIT_URL);
  if (!host) return;
  const dispatch = new AgentDispatchClient(host, API_KEY, API_SECRET);
  await dispatch.deleteDispatch(dispatchId, roomName);
}

async function performExplicitAgentDispatch(
  roomName: string,
  agentName: string,
  agentMetadata: string | undefined,
  options: {
    forceCreate?: boolean;
    createIfMissing?: boolean;
    cleanupExistingDispatches?: boolean;
  } = {},
  deadlineMs = Date.now() + DISPATCH_ASSIGNMENT_TIMEOUT_MS,
  attempt?: ExplicitDispatchAttempt
): Promise<void> {
  const host =
    toDispatchHost(process.env.LIVEKIT_API_HOST) ??
    toDispatchHost(process.env.LIVEKIT_URL) ??
    toDispatchHost(process.env.NEXT_PUBLIC_LIVEKIT_URL);

  if (!host) {
    throw new Error('LIVEKIT_API_HOST/LIVEKIT_URL is not configured for dispatch');
  }

  const dispatch = new AgentDispatchClient(host, API_KEY, API_SECRET);
  const rooms = new RoomServiceClient(host, API_KEY, API_SECRET);
  await rooms.createRoom({
    name: roomName,
    emptyTimeout: CALL_SESSION_RECONNECT_GRACE_SECONDS,
    departureTimeout: CALL_SESSION_RECONNECT_GRACE_SECONDS,
  });
  if (attempt?.cancelled) {
    throw new Error('LiveKit dispatch attempt was superseded');
  }
  let selectedDispatch: AgentDispatch | undefined;
  if (options.forceCreate === true) {
    if (options.cleanupExistingDispatches === true) {
      try {
        const existing = (await dispatch.listDispatch(roomName)) ?? [];
        const existingExplicitDispatches = existing.filter(
          (entry) =>
            entry.agentName === agentName && typeof entry.id === 'string' && entry.id.length > 0
        );
        await Promise.allSettled(
          existingExplicitDispatches.map((entry) => dispatch.deleteDispatch(entry.id, roomName))
        );
      } catch {
        console.warn('Unable to list existing LiveKit dispatches before forced create');
      }
    }
    selectedDispatch = await dispatch.createDispatch(roomName, agentName, {
      metadata:
        typeof agentMetadata === 'string' && agentMetadata.length > 0 ? agentMetadata : undefined,
    });
    if (selectedDispatch?.id && attempt) {
      attempt.createdDispatchId = selectedDispatch.id;
    }
  } else {
    const existing = (await dispatch.listDispatch(roomName)) ?? [];
    // Token room-config entries can appear in ListDispatch without a real dispatch id. Only an
    // explicit dispatch id proves the worker assignment already exists.
    selectedDispatch = existing.find(
      (entry) =>
        entry.agentName === agentName && typeof entry.id === 'string' && entry.id.length > 0
    );
    if (!selectedDispatch) {
      if (options.createIfMissing === false) {
        throw new Error('The confirmed LiveKit dispatch is no longer available');
      }
      selectedDispatch = await dispatch.createDispatch(roomName, agentName, {
        metadata:
          typeof agentMetadata === 'string' && agentMetadata.length > 0 ? agentMetadata : undefined,
      });
      if (selectedDispatch?.id && attempt) {
        attempt.createdDispatchId = selectedDispatch.id;
      }
    }
  }

  const dispatchId = selectedDispatch?.id;
  if (!dispatchId) {
    throw new Error('LiveKit did not return an explicit dispatch identity');
  }
  if (attempt?.cancelled && attempt.createdDispatchId === dispatchId) {
    await dispatch.deleteDispatch(dispatchId, roomName).catch(() => undefined);
    throw new Error('LiveKit dispatch attempt was superseded');
  }
  // LiveKit assigns the room job before the owner token can join. A worker-bound pending job is
  // therefore sufficient to mint that exact owner's token; requiring JS_RUNNING creates a cold
  // start deadlock because the gateway is simultaneously waiting for the canonical participant.
  const dispatchHasAssignedWorker = (candidate: AgentDispatch | undefined) =>
    candidate?.state?.jobs?.some(
      (job) =>
        job.dispatchId === dispatchId &&
        (job.state?.status === JobStatus.JS_PENDING ||
          job.state?.status === JobStatus.JS_RUNNING) &&
        typeof job.state.workerId === 'string' &&
        job.state.workerId.trim().length > 0
    ) === true;
  let current: AgentDispatch | undefined = selectedDispatch;
  while (!dispatchHasAssignedWorker(current) && Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, DISPATCH_ASSIGNMENT_POLL_MS));
    current = await dispatch.getDispatch(dispatchId, roomName);
  }
  if (!dispatchHasAssignedWorker(current)) {
    throw new Error('No registered LiveKit voice worker accepted the dispatch');
  }
}

async function ensureExplicitAgentDispatch(
  roomName: string,
  agentName: string,
  agentMetadata: string | undefined,
  options: {
    forceCreate?: boolean;
    createIfMissing?: boolean;
    cleanupExistingDispatches?: boolean;
  } = {},
  deadlineMs = Date.now() + DISPATCH_ASSIGNMENT_TIMEOUT_MS
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const attempt: ExplicitDispatchAttempt = { cancelled: false };
  try {
    await Promise.race([
      performExplicitAgentDispatch(
        roomName,
        agentName,
        agentMetadata,
        options,
        deadlineMs,
        attempt
      ),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('LiveKit dispatch readiness timed out')),
          remainingDispatchTimeMs(deadlineMs)
        );
      }),
    ]);
  } catch (error) {
    attempt.cancelled = true;
    if (attempt.createdDispatchId) {
      await deleteExplicitAgentDispatch(attempt.createdDispatchId, roomName).catch(() => undefined);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function claimViventiumDispatch(
  callSessionId: string,
  browserCapability: string,
  roomName: string,
  agentName: string,
  options?: { reclaimConfirmed?: boolean },
  deadlineMs = Date.now() + DISPATCH_ASSIGNMENT_TIMEOUT_MS
): Promise<{ status?: string; claimId?: string | null } | null> {
  if (!VIVENTIUM_LIBRECHAT_ORIGIN || !VIVENTIUM_CALL_SESSION_SECRET) {
    return null;
  }
  const url = new URL(
    `/api/viventium/calls/${encodeURIComponent(callSessionId)}/dispatch/claim`,
    VIVENTIUM_LIBRECHAT_ORIGIN
  );
  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VIVENTIUM-CALL-SECRET': VIVENTIUM_CALL_SESSION_SECRET,
      [CALL_CAPABILITY_HEADER]: browserCapability,
    },
    body: JSON.stringify({
      roomName,
      agentName,
      reclaimConfirmed: options?.reclaimConfirmed === true,
    }),
    cache: 'no-store',
    signal: AbortSignal.timeout(remainingDispatchTimeMs(deadlineMs)),
  });
  if (!resp.ok) {
    throw new Error(`Dispatch claim failed (${resp.status})`);
  }
  return (await resp.json()) as { status?: string; claimId?: string | null };
}

async function awaitDispatchClaim(
  initialClaim: { status?: string; claimId?: string | null } | null,
  callSessionId: string,
  browserCapability: string,
  roomName: string,
  agentName: string,
  options?: { reclaimConfirmed?: boolean },
  deadlineMs = Date.now() + DISPATCH_ASSIGNMENT_TIMEOUT_MS
) {
  let claim = initialClaim;
  while (claim?.status === 'in_flight' && Date.now() < deadlineMs) {
    await new Promise((resolve) => setTimeout(resolve, DISPATCH_ASSIGNMENT_POLL_MS));
    claim = await claimViventiumDispatch(
      callSessionId,
      browserCapability,
      roomName,
      agentName,
      options,
      deadlineMs
    );
  }
  if (claim?.status === 'in_flight') {
    throw new Error('Another dispatch claim did not reach a ready worker');
  }
  return claim;
}

async function confirmViventiumDispatch(
  callSessionId: string,
  browserCapability: string,
  claimId: string,
  status: 'created' | 'failed',
  error?: unknown,
  deadlineMs = Date.now() + DISPATCH_ASSIGNMENT_TIMEOUT_MS
): Promise<void> {
  if (!VIVENTIUM_LIBRECHAT_ORIGIN || !VIVENTIUM_CALL_SESSION_SECRET) {
    return;
  }
  const url = new URL(
    `/api/viventium/calls/${encodeURIComponent(callSessionId)}/dispatch/confirm`,
    VIVENTIUM_LIBRECHAT_ORIGIN
  );
  const body: Record<string, unknown> = { claimId, status };
  if (status === 'failed') {
    body.error = error instanceof Error ? error.message : String(error ?? 'dispatch failed');
  }
  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-VIVENTIUM-CALL-SECRET': VIVENTIUM_CALL_SESSION_SECRET,
      [CALL_CAPABILITY_HEADER]: browserCapability,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(remainingDispatchTimeMs(deadlineMs)),
  });
  if (!resp.ok) {
    console.error('Dispatch confirm failed:', resp.status);
  }
}

export async function POST(req: Request) {
  try {
    if (Boolean(VIVENTIUM_LIBRECHAT_ORIGIN) !== Boolean(VIVENTIUM_CALL_SESSION_SECRET)) {
      return NextResponse.json(
        {
          code: 'gateway_down',
          message: 'The signed call-session runtime is only partially configured.',
          retryable: false,
        },
        { status: 503 }
      );
    }
    if (
      !VIVENTIUM_LIBRECHAT_ORIGIN &&
      !VIVENTIUM_CALL_SESSION_SECRET &&
      !ALLOW_DIRECT_AGENT_DISPATCH
    ) {
      return NextResponse.json(
        {
          code: 'gateway_down',
          message: 'Signed calling is not configured and unsigned development calling is disabled.',
          retryable: false,
        },
        { status: 503 }
      );
    }
    const browserLiveKitUrl = resolveBrowserLiveKitUrl(req);
    if (!LIVEKIT_URL && !NEXT_PUBLIC_LIVEKIT_URL && !browserLiveKitUrl) {
      throw new Error('LIVEKIT_URL is not defined');
    }
    if (API_KEY === undefined) {
      throw new Error('LIVEKIT_API_KEY is not defined');
    }
    if (API_SECRET === undefined) {
      throw new Error('LIVEKIT_API_SECRET is not defined');
    }

    const body = await req.json().catch(() => ({}));
    const options = normalizeOptions(body);
    const deepLinkFallbacks = extractDeepLinkFallbacks(req);
    const metadataCallSessionId = parseCallSessionIdFromAgentMetadata(options.agentMetadata);
    const participantMetadataCallSessionId = parseCallSessionIdFromAgentMetadata(
      options.participantMetadata ?? options.participant_metadata
    );
    const deepLinkCallSessionId = deepLinkFallbacks.callSessionId;
    if (
      (metadataCallSessionId && !parseCallIdentifier(metadataCallSessionId)) ||
      (participantMetadataCallSessionId &&
        !parseCallIdentifier(participantMetadataCallSessionId)) ||
      (deepLinkCallSessionId && !parseCallIdentifier(deepLinkCallSessionId)) ||
      (metadataCallSessionId &&
        deepLinkCallSessionId &&
        metadataCallSessionId !== deepLinkCallSessionId) ||
      (participantMetadataCallSessionId &&
        metadataCallSessionId &&
        participantMetadataCallSessionId !== metadataCallSessionId) ||
      (participantMetadataCallSessionId &&
        deepLinkCallSessionId &&
        participantMetadataCallSessionId !== deepLinkCallSessionId)
    ) {
      return NextResponse.json(
        {
          code: 'auth_expired',
          message: 'The signed call session does not match this launch request.',
          retryable: false,
        },
        { status: 409 }
      );
    }
    const currentCallSessionId = parseCallIdentifier(
      metadataCallSessionId ?? participantMetadataCallSessionId ?? deepLinkCallSessionId
    );
    if (!currentCallSessionId && dispatchRequiresCallSession()) {
      return NextResponse.json(
        {
          code: 'auth_expired',
          message: 'Start this call from Viventium to create a signed call session.',
          retryable: false,
        },
        { status: 401 }
      );
    }
    const browserCapability = readRequestCallBrowserCapability(req);
    if (currentCallSessionId) {
      if (!browserCapability) {
        return NextResponse.json(
          {
            code: 'auth_expired',
            message: 'The call capability is missing or invalid.',
            retryable: false,
          },
          { status: 401 }
        );
      }
      try {
        const canonical = await fetchAuthoritativeCallSession(
          currentCallSessionId,
          browserCapability
        );
        if (canonical.status === 'ended') {
          throw new AuthoritativeCallSessionError(
            'auth_expired',
            'This call has ended. Start a fresh call from Viventium.',
            410,
            false
          );
        }
        applyAuthoritativeCallSession(options, canonical);
        applyCallSessionRoomRetention(options);
      } catch (error) {
        if (error instanceof AuthoritativeCallSessionError) {
          return NextResponse.json(
            { code: error.code, message: error.message, retryable: error.retryable },
            { status: error.status }
          );
        }
        throw error;
      }
    }

    if (!currentCallSessionId && ALLOW_DIRECT_AGENT_DISPATCH) {
      // Explicit unsigned development mode is isolated from every caller-selected or signed-call
      // room. A fresh server-random room/identity prevents a guessed `lc-*` room from becoming an
      // eavesdropping capability.
      options.room_name = '';
      options.roomName = undefined;
      options.participant_identity = '';
      options.participantIdentity = undefined;
      options.participantName = undefined;
      options.participant_metadata = undefined;
      options.participantMetadata = undefined;
      options.participant_attributes = undefined;
      options.participantAttributes = undefined;
      options.agentName = undefined;
      options.agentMetadata = undefined;
      options.room_config = undefined;
      options.roomConfig = undefined;
    }

    const suffix = crypto.randomUUID().substring(0, 8);
    options.room_name = options.room_name || options.roomName || `room-${suffix}`;
    options.participant_identity =
      options.participant_identity ||
      options.participantIdentity ||
      options.participantName ||
      `user-${suffix}`;

    if (!options.participant_name) {
      options.participant_name = options.participantName ?? options.participant_identity;
    }

    if (
      !currentCallSessionId &&
      !VIVENTIUM_LIBRECHAT_ORIGIN &&
      !VIVENTIUM_CALL_SESSION_SECRET &&
      !ALLOW_DIRECT_AGENT_DISPATCH &&
      !options.agentName &&
      deepLinkFallbacks.agentName
    ) {
      options.agentName = deepLinkFallbacks.agentName;
    }

    const agentName = options.agentName;
    const agentMetadata = options.agentMetadata;
    const reclaimDispatch = options.reclaimDispatch === true;
    let pendingDispatchConfirmation: PendingDispatchConfirmation | null = null;
    const dispatchDeadlineMs = Date.now() + DISPATCH_ASSIGNMENT_TIMEOUT_MS;
    const dispatchCleanupReserveMs = Math.min(
      250,
      Math.max(1, Math.floor(DISPATCH_ASSIGNMENT_TIMEOUT_MS / 4))
    );
    const dispatchWorkDeadlineMs = dispatchDeadlineMs - dispatchCleanupReserveMs;
    if (agentName && agentName.trim().length > 0) {
      const callSessionId = currentCallSessionId;
      if (!callSessionId && dispatchRequiresCallSession()) {
        return NextResponse.json(
          {
            message:
              'Direct Viventium voice dispatch is disabled. Launch the modern playground from the Viventium call button so a call session is created first.',
          },
          { status: 400 }
        );
      }

      if (callSessionId) {
        try {
          const claim = await awaitDispatchClaim(
            await claimViventiumDispatch(
              callSessionId,
              browserCapability!,
              options.room_name,
              agentName,
              { reclaimConfirmed: reclaimDispatch },
              dispatchWorkDeadlineMs
            ),
            callSessionId,
            browserCapability!,
            options.room_name,
            agentName,
            { reclaimConfirmed: reclaimDispatch },
            dispatchWorkDeadlineMs
          );
          const claimStatus = claim?.status ?? '';
          if (claimStatus === 'expired') {
            return NextResponse.json(
              {
                message: 'This voice call session expired. Start a fresh call from Viventium.',
              },
              { status: 410 }
            );
          }
          // A watchdog reclaim must create a real side effect even when normal calls use token
          // room-config dispatch. Its response token is intentionally discarded by the caller.
          const useExplicitAgentDispatch =
            callSessionUsesExplicitAgentDispatch() || reclaimDispatch;
          const claimId = typeof claim?.claimId === 'string' ? claim.claimId : null;
          if (claimStatus === 'claimed' && claimId) {
            pendingDispatchConfirmation = { callSessionId, claimId };
          }
          if (!useExplicitAgentDispatch && claimStatus === 'claimed' && claimId) {
            addAgentDispatchToRoomConfig(
              options,
              agentName,
              metadataForDispatchClaim(agentMetadata, claimId)
            );
          } else if (useExplicitAgentDispatch && claimStatus === 'claimed' && claimId) {
            await ensureExplicitAgentDispatch(
              options.room_name,
              agentName,
              metadataForDispatchClaim(agentMetadata, claimId),
              { forceCreate: true, cleanupExistingDispatches: reclaimDispatch },
              dispatchWorkDeadlineMs
            );
          } else if (claimStatus === 'already') {
            // LiveKit applies token room configuration only when it creates a room. Reconnects
            // into an existing room must reuse a proven explicit dispatch or recover through a
            // fresh, server-claimed explicit dispatch; embedding another token agent is ignored.
            try {
              await ensureExplicitAgentDispatch(
                options.room_name,
                agentName,
                agentMetadata,
                { createIfMissing: false },
                dispatchWorkDeadlineMs
              );
            } catch {
              const replacement = await awaitDispatchClaim(
                await claimViventiumDispatch(
                  callSessionId,
                  browserCapability!,
                  options.room_name,
                  agentName,
                  { reclaimConfirmed: true },
                  dispatchWorkDeadlineMs
                ),
                callSessionId,
                browserCapability!,
                options.room_name,
                agentName,
                { reclaimConfirmed: true },
                dispatchWorkDeadlineMs
              );
              const replacementClaimId =
                replacement?.status === 'claimed' && typeof replacement.claimId === 'string'
                  ? replacement.claimId
                  : null;
              if (!replacementClaimId) {
                throw new Error('Confirmed dispatch could not be reclaimed');
              }
              pendingDispatchConfirmation = { callSessionId, claimId: replacementClaimId };
              await ensureExplicitAgentDispatch(
                options.room_name,
                agentName,
                metadataForDispatchClaim(agentMetadata, replacementClaimId),
                { forceCreate: true, cleanupExistingDispatches: true },
                dispatchWorkDeadlineMs
              );
            }
          } else {
            throw new Error('Dispatch claim did not authorize a worker assignment');
          }
        } catch (error) {
          console.error('Viventium dispatch was not accepted by a ready worker');
          if (pendingDispatchConfirmation) {
            await confirmViventiumDispatch(
              pendingDispatchConfirmation.callSessionId,
              browserCapability!,
              pendingDispatchConfirmation.claimId,
              'failed',
              error,
              dispatchDeadlineMs
            ).catch(() => {
              console.error('Failed Viventium dispatch claim could not be released');
            });
          }
          return NextResponse.json(
            {
              code: 'gateway_down',
              message: 'No ready voice worker accepted this call. Please try again.',
              retryable: true,
            },
            { status: 503 }
          );
        }
      } else {
        try {
          await ensureExplicitAgentDispatch(options.room_name, agentName, agentMetadata);
        } catch {
          console.error('Agent dispatch was not accepted by a ready worker');
          return NextResponse.json({ message: 'Agent dispatch failed' }, { status: 500 });
        }
      }
    }

    let participantToken: string;
    try {
      participantToken = await createToken(options);
      if (pendingDispatchConfirmation) {
        await confirmViventiumDispatch(
          pendingDispatchConfirmation.callSessionId,
          browserCapability!,
          pendingDispatchConfirmation.claimId,
          'created',
          undefined,
          dispatchDeadlineMs
        );
      }
    } catch (error) {
      if (pendingDispatchConfirmation) {
        await confirmViventiumDispatch(
          pendingDispatchConfirmation.callSessionId,
          browserCapability!,
          pendingDispatchConfirmation.claimId,
          'failed',
          error,
          Date.now() + Math.min(1_000, DISPATCH_ASSIGNMENT_TIMEOUT_MS)
        );
      }
      throw error;
    }
    const response = {
      serverUrl: browserLiveKitUrl,
      roomName: options.room_name,
      participantToken,
      participantName: options.participant_name ?? options.participant_identity,
      participantIdentity: options.participant_identity,
    };
    const headers = new Headers({
      'Cache-Control': 'no-store',
    });
    return NextResponse.json(response, { headers });
  } catch (error) {
    if (error instanceof Error) {
      console.error(error);
      return NextResponse.json({ message: error.message }, { status: 500 });
    }
    return NextResponse.json({ message: 'Unknown error' }, { status: 500 });
  }
}
