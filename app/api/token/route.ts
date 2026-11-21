/*
 * Token route: the authentication layer upstream says a production token route must have.
 *
 * `POST /api/token` gives the browser a LiveKit URL and a short-lived room token only for a call
 * Core knows (CP-APP-011). The call session id comes from the request body (agent or participant
 * metadata `{"callSessionId": …}`), the per-call browser capability from its header. Room name,
 * participant identity, agent and dispatch metadata always come from Core, never from the browser.
 * (The participant display name may come from the browser; it defaults to the identity.)
 * Before the token is minted exactly one voice worker is attached to the room (CP-APP-012,
 * `./dispatch.ts`), and the room is kept for a short grace period so a refresh or a network blip
 * rejoins the same call (CP-APP-013).
 *
 * Without a call session there is no token, except in the explicit unsigned development mode
 * (`VIVENTIUM_ALLOW_DIRECT_AGENT_DISPATCH=1`), which ignores everything the caller sent and mints
 * a token for a fresh random room (CP-APP-015).
 *
 * Request body: `TokenSourceRequest` in snake_case or camelCase, plus optional `agentMetadata`,
 * `participantMetadata`, `reclaimDispatch`.
 * Response: `{ serverUrl, roomName, participantToken, participantName, participantIdentity }`.
 * Errors: `{ code, message, retryable }` with a `CallIssueKind` code.
 */
import { NextResponse } from 'next/server';
import { AccessToken, RoomConfiguration } from 'livekit-server-sdk';
import { coreConfigurationState } from '@/app/api/call-tasks/proxy';
import {
  CALL_SESSION_RECONNECT_GRACE_SECONDS,
  confirmDispatch,
  dispatchBudgetMs,
  prepareCallDispatch,
} from '@/app/api/token/dispatch';
import {
  AuthoritativeCallSessionError,
  type AuthoritativeTokenRequest,
  applyAuthoritativeCallSession,
  fetchAuthoritativeCallSession,
} from '@/lib/authoritative-call-session';
import { readRequestCallBrowserCapability } from '@/lib/call-browser-capability';
import { parseCallIdentifier } from '@/lib/call-proxy';
import type { CallIssueKind } from '@/lib/call-start';
import { requestOrigin, resolveLiveKitUrl } from '@/lib/viventium/livekit-url';

// don't cache the results
export const revalidate = 0;

const TOKEN_TTL = '10m';

type ConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantToken: string;
  participantName: string;
  participantIdentity: string;
};

function failure(
  code: CallIssueKind | 'network_not_ready',
  message: string,
  retryable: boolean,
  status: number
) {
  return NextResponse.json({ code, message, retryable }, { status });
}

function allowsUnsignedDevelopmentCalls(): boolean {
  const value = process.env.VIVENTIUM_ALLOW_DIRECT_AGENT_DISPATCH;
  return value === '1' || value === 'true';
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `callSessionId` from a `{"callSessionId": …}` metadata string; `null` when there is none. */
function callSessionIdFromMetadata(metadata: string | undefined): string | null {
  const trimmed = metadata?.trim();
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

/** The parts of the browser's request the route reads; everything else comes from Core. */
function readTokenRequest(body: unknown) {
  const options = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const roomConfig = options.room_config ?? options.roomConfig;
  let roomConfigAgentMetadata: string | undefined;
  if (roomConfig && typeof roomConfig === 'object' && !Array.isArray(roomConfig)) {
    const agents = (roomConfig as { agents?: unknown }).agents;
    const firstAgent = Array.isArray(agents) ? (agents[0] as { metadata?: unknown }) : undefined;
    roomConfigAgentMetadata = text(firstAgent?.metadata);
  }
  return {
    roomNameSnake: text(options.room_name),
    roomNameCamel: text(options.roomName),
    participantName: text(options.participant_name) ?? text(options.participantName),
    agentMetadata:
      text(options.agentMetadata) ?? text(options.agent_metadata) ?? roomConfigAgentMetadata,
    participantMetadata: text(options.participantMetadata) ?? text(options.participant_metadata),
    reclaimDispatch: options.reclaimDispatch === true,
  };
}

async function mintToken(input: {
  roomName: string;
  identity: string;
  name: string;
  metadata?: string;
  roomConfig?: RoomConfiguration;
}): Promise<string> {
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, {
    identity: input.identity,
    ttl: TOKEN_TTL,
  });
  at.addGrant({
    roomJoin: true,
    room: input.roomName,
    canPublish: true,
    canPublishData: true,
    canSubscribe: true,
    canUpdateOwnMetadata: true,
  });
  at.name = input.name;
  at.identity = input.identity;
  if (input.metadata) {
    at.metadata = input.metadata;
  }
  if (input.roomConfig) {
    at.roomConfig = input.roomConfig;
  }
  return at.toJwt();
}

function connectionDetailsResponse(details: ConnectionDetails) {
  return NextResponse.json(details, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: Request) {
  try {
    const coreState = coreConfigurationState();
    if (coreState === 'partial') {
      return failure(
        'gateway_down',
        'The signed call-session runtime is only partially configured.',
        false,
        503
      );
    }
    if (coreState === 'absent' && !allowsUnsignedDevelopmentCalls()) {
      return failure(
        'gateway_down',
        'Signed calling is not configured and unsigned development calling is disabled.',
        false,
        503
      );
    }
    const liveKitUrl = resolveLiveKitUrl(requestOrigin(req));
    if (!liveKitUrl.ready) {
      return failure(
        'network_not_ready',
        'Calling is reconnecting to the current network. Please try again.',
        true,
        503
      );
    }
    if (!liveKitUrl.url) {
      return failure('gateway_down', 'The LiveKit signaling URL is not configured.', false, 503);
    }
    if (process.env.LIVEKIT_API_KEY === undefined) {
      throw new Error('LIVEKIT_API_KEY is not defined');
    }
    if (process.env.LIVEKIT_API_SECRET === undefined) {
      throw new Error('LIVEKIT_API_SECRET is not defined');
    }

    const request = readTokenRequest(await req.json().catch(() => ({})));
    const agentSessionId = callSessionIdFromMetadata(request.agentMetadata);
    const participantSessionId = callSessionIdFromMetadata(request.participantMetadata);
    if (
      (agentSessionId && !parseCallIdentifier(agentSessionId)) ||
      (participantSessionId && !parseCallIdentifier(participantSessionId)) ||
      (agentSessionId && participantSessionId && agentSessionId !== participantSessionId)
    ) {
      return failure(
        'auth_expired',
        'The signed call session does not match this launch request.',
        false,
        409
      );
    }
    const callSessionId = parseCallIdentifier(agentSessionId ?? participantSessionId);

    if (!callSessionId) {
      if (!allowsUnsignedDevelopmentCalls()) {
        return failure(
          'auth_expired',
          'Start this call from Viventium to create a signed call session.',
          false,
          401
        );
      }
      // Unsigned development mode is isolated from every caller-selected or signed-call room:
      // a fresh server-random room and identity, no agent, nothing taken from the request.
      const suffix = crypto.randomUUID().substring(0, 8);
      const roomName = `room-${suffix}`;
      const identity = `user-${suffix}`;
      return connectionDetailsResponse({
        serverUrl: liveKitUrl.url,
        roomName,
        participantToken: await mintToken({ roomName, identity, name: identity }),
        participantName: identity,
        participantIdentity: identity,
      });
    }

    const browserCapability = readRequestCallBrowserCapability(req);
    if (!browserCapability) {
      return failure('auth_expired', 'The call capability is missing or invalid.', false, 401);
    }

    // Core's record replaces whatever the browser asked for.
    const authoritative: AuthoritativeTokenRequest = {
      room_name: request.roomNameSnake ?? request.roomNameCamel ?? '',
      roomName: request.roomNameCamel,
      participant_identity: '',
    };
    try {
      const canonical = await fetchAuthoritativeCallSession(callSessionId, browserCapability);
      if (canonical.status === 'ended') {
        throw new AuthoritativeCallSessionError(
          'auth_expired',
          'This call has ended. Start a fresh call from Viventium.',
          410,
          false
        );
      }
      applyAuthoritativeCallSession(authoritative, canonical);
    } catch (error) {
      if (error instanceof AuthoritativeCallSessionError) {
        return failure(error.code, error.message, error.retryable, error.status);
      }
      throw error;
    }
    const roomName = authoritative.room_name;
    const identity = authoritative.participant_identity;
    // The display name is the one field a signed call still takes from the browser (as today).
    const participantName = request.participantName || identity;
    const agentName = authoritative.agentName!;
    const call = { callSessionId, browserCapability };

    const roomConfig = new RoomConfiguration({
      departureTimeout: CALL_SESSION_RECONNECT_GRACE_SECONDS,
    });

    const dispatchDeadlineMs = Date.now() + dispatchBudgetMs();
    const dispatch = await prepareCallDispatch({
      call,
      roomName,
      agentName,
      agentMetadata: authoritative.agentMetadata,
      reclaimDispatch: request.reclaimDispatch,
      deadlineMs: dispatchDeadlineMs,
    });
    if (dispatch.kind === 'expired') {
      return failure(
        'auth_expired',
        'This voice call session expired. Start a fresh call from Viventium.',
        false,
        410
      );
    }
    if (dispatch.kind === 'no_worker') {
      return failure(
        'gateway_down',
        'No ready voice worker accepted this call. Please try again.',
        true,
        503
      );
    }
    if (dispatch.tokenAgent) {
      roomConfig.agents.push(dispatch.tokenAgent);
    }

    let participantToken: string;
    try {
      participantToken = await mintToken({
        roomName,
        identity,
        name: participantName,
        metadata: authoritative.participant_metadata,
        roomConfig,
      });
      if (dispatch.pendingClaimId) {
        await confirmDispatch(call, dispatch.pendingClaimId, 'created', dispatchDeadlineMs);
      }
    } catch (error) {
      if (dispatch.pendingClaimId) {
        await confirmDispatch(
          call,
          dispatch.pendingClaimId,
          'failed',
          Date.now() + Math.min(1_000, dispatchBudgetMs()),
          error
        );
      }
      throw error;
    }

    return connectionDetailsResponse({
      serverUrl: liveKitUrl.url,
      roomName,
      participantToken,
      participantName,
      participantIdentity: identity,
    });
  } catch (error) {
    console.error(error);
    return failure(
      'gateway_down',
      error instanceof Error ? error.message : 'Unknown error',
      false,
      500
    );
  }
}
