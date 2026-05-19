/* VIVENTIUM START
 * Purpose: Viventium agent-starter customization.
 * Details: docs/requirements_and_learnings/05_Open_Source_Modifications.md#agent-starter-react
 * VIVENTIUM END */
import { NextResponse } from 'next/server';
import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';

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
const CALL_SESSION_VOICE_SETTINGS_TIMEOUT_MS = 5000;

function getCallSessionVoiceSettingsTimeoutMs() {
  const parsed = Number(process.env.VIVENTIUM_CALL_SESSION_VOICE_SETTINGS_TIMEOUT_MS || '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CALL_SESSION_VOICE_SETTINGS_TIMEOUT_MS;
}

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
  // VIVENTIUM START
  agent_name?: string;
  agent_metadata?: string;
  // VIVENTIUM END
};

type CallSessionVoiceSettingsResponse = {
  requestedVoiceRoute?: unknown;
  savedVoiceRoute?: unknown;
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

function parseAgentMetadata(agentMetadata: string | undefined): Record<string, unknown> | null {
  if (!agentMetadata || typeof agentMetadata !== 'string') {
    return null;
  }
  const trimmed = agentMetadata.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function hasRequestedVoiceSelection(route: unknown): boolean {
  if (!route || typeof route !== 'object' || Array.isArray(route)) {
    return false;
  }
  const state = route as {
    stt?: { provider?: unknown; variant?: unknown };
    tts?: { provider?: unknown; variant?: unknown };
  };
  const selections = [state.stt, state.tts];
  return selections.some((selection) => {
    if (!selection || typeof selection !== 'object') {
      return false;
    }
    return (
      (typeof selection.provider === 'string' && selection.provider.trim().length > 0) ||
      (typeof selection.variant === 'string' && selection.variant.trim().length > 0)
    );
  });
}

async function fetchCallSessionVoiceSettings(
  callSessionId: string
): Promise<CallSessionVoiceSettingsResponse | null> {
  if (!VIVENTIUM_LIBRECHAT_ORIGIN || !VIVENTIUM_CALL_SESSION_SECRET) {
    return null;
  }
  const url = new URL(
    `/api/viventium/calls/${encodeURIComponent(callSessionId)}/voice-settings`,
    VIVENTIUM_LIBRECHAT_ORIGIN
  );
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, getCallSessionVoiceSettingsTimeoutMs());
  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-VIVENTIUM-CALL-SECRET': VIVENTIUM_CALL_SESSION_SECRET,
      },
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return null;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
  if (!resp.ok) {
    return null;
  }
  const payload = (await resp.json().catch(() => null)) as CallSessionVoiceSettingsResponse | null;
  return payload && typeof payload === 'object' ? payload : null;
}

async function hydrateAgentMetadataWithVoiceSettings(
  callSessionId: string | null,
  agentMetadata: string | undefined
): Promise<string | undefined> {
  if (!callSessionId) {
    return agentMetadata;
  }

  const parsedMetadata = parseAgentMetadata(agentMetadata) ?? { callSessionId };
  const existingRequestedVoiceRoute = parsedMetadata.requestedVoiceRoute;
  if (hasRequestedVoiceSelection(existingRequestedVoiceRoute)) {
    return JSON.stringify(parsedMetadata);
  }

  try {
    const voiceSettings = await fetchCallSessionVoiceSettings(callSessionId);
    const authoritativeRequestedVoiceRoute =
      voiceSettings?.requestedVoiceRoute ?? voiceSettings?.savedVoiceRoute;
    if (!hasRequestedVoiceSelection(authoritativeRequestedVoiceRoute)) {
      return JSON.stringify(parsedMetadata);
    }

    console.info(
      'Hydrated Viventium requestedVoiceRoute from authoritative call-session settings',
      {
        callSessionId,
      }
    );
    return JSON.stringify({
      ...parsedMetadata,
      callSessionId,
      requestedVoiceRoute: authoritativeRequestedVoiceRoute,
    });
  } catch (error) {
    console.error('Error hydrating Viventium voice route metadata:', error);
    return JSON.stringify(parsedMetadata);
  }
}

function dispatchRequiresCallSession(): boolean {
  return (
    !ALLOW_DIRECT_AGENT_DISPATCH &&
    Boolean(VIVENTIUM_LIBRECHAT_ORIGIN) &&
    Boolean(VIVENTIUM_CALL_SESSION_SECRET)
  );
}

function callSessionUsesExplicitAgentDispatch(): boolean {
  const mode = (VIVENTIUM_LIVEKIT_AGENT_DISPATCH_MODE || '').trim().toLowerCase();
  return mode !== 'token_room_config' && mode !== 'room_config';
}

async function ensureExplicitAgentDispatch(
  roomName: string,
  agentName: string,
  agentMetadata: string | undefined,
  options: { forceCreate?: boolean } = {}
): Promise<void> {
  const host =
    toDispatchHost(process.env.LIVEKIT_API_HOST) ??
    toDispatchHost(process.env.LIVEKIT_URL) ??
    toDispatchHost(process.env.NEXT_PUBLIC_LIVEKIT_URL);

  if (!host) {
    throw new Error('LIVEKIT_API_HOST/LIVEKIT_URL is not configured for dispatch');
  }

  const dispatch = new AgentDispatchClient(host, API_KEY, API_SECRET);
  let already = false;
  if (options.forceCreate !== true) {
    const existing = await dispatch.listDispatch(roomName);
    // Token room-config entries can appear in ListDispatch without a real dispatch id. Only an
    // explicit dispatch id proves the worker assignment already exists.
    already = existing.some(
      (entry) =>
        entry.agentName === agentName && typeof entry.id === 'string' && entry.id.length > 0
    );
  }
  if (options.forceCreate === true || !already) {
    await dispatch.createDispatch(roomName, agentName, {
      metadata:
        typeof agentMetadata === 'string' && agentMetadata.length > 0 ? agentMetadata : undefined,
    });
  }
}

async function claimViventiumDispatch(
  callSessionId: string,
  roomName: string,
  agentName: string,
  options?: { reclaimConfirmed?: boolean }
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
    },
    body: JSON.stringify({
      roomName,
      agentName,
      reclaimConfirmed: options?.reclaimConfirmed === true,
    }),
    cache: 'no-store',
  });
  if (!resp.ok) {
    throw new Error(`Dispatch claim failed (${resp.status})`);
  }
  return (await resp.json()) as { status?: string; claimId?: string | null };
}

async function confirmViventiumDispatch(
  callSessionId: string,
  claimId: string,
  status: 'created' | 'failed',
  error?: unknown
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
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!resp.ok) {
    console.error('Dispatch confirm failed:', resp.status, await resp.text());
  }
}

export async function POST(req: Request) {
  try {
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

    if (!options.agentName && deepLinkFallbacks.agentName) {
      options.agentName = deepLinkFallbacks.agentName;
    }

    let currentCallSessionId = parseCallSessionIdFromAgentMetadata(options.agentMetadata);
    if (!currentCallSessionId && deepLinkFallbacks.callSessionId) {
      currentCallSessionId = deepLinkFallbacks.callSessionId;
      const metadata = JSON.stringify({ callSessionId: deepLinkFallbacks.callSessionId });
      if (!options.agentMetadata) {
        options.agentMetadata = metadata;
      }
      if (!options.participant_metadata && !options.participantMetadata) {
        options.participant_metadata = metadata;
        options.participantMetadata = metadata;
      }
    }

    const hydratedAgentMetadata = await hydrateAgentMetadataWithVoiceSettings(
      currentCallSessionId,
      options.agentMetadata
    );
    if (hydratedAgentMetadata) {
      options.agentMetadata = hydratedAgentMetadata;
    }

    const agentName = options.agentName;
    const agentMetadata = options.agentMetadata;
    let pendingDispatchConfirmation: PendingDispatchConfirmation | null = null;
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
          const claim = await claimViventiumDispatch(callSessionId, options.room_name, agentName);
          const claimStatus = claim?.status ?? '';
          if (claimStatus === 'expired') {
            return NextResponse.json(
              {
                message: 'This voice call session expired. Start a fresh call from Viventium.',
              },
              { status: 410 }
            );
          }
          const useExplicitAgentDispatch = callSessionUsesExplicitAgentDispatch();
          if (!useExplicitAgentDispatch) {
            addAgentDispatchToRoomConfig(options, agentName, agentMetadata);
          }
          const claimId = typeof claim?.claimId === 'string' ? claim.claimId : null;
          if (claimStatus === 'claimed' && claimId) {
            pendingDispatchConfirmation = { callSessionId, claimId };
          }
          if (
            useExplicitAgentDispatch &&
            (claimStatus === 'claimed' || claimStatus === 'already')
          ) {
            await ensureExplicitAgentDispatch(options.room_name, agentName, agentMetadata, {
              forceCreate: claimStatus === 'claimed',
            });
          }
        } catch (error) {
          console.error('Error claiming Viventium dispatch lease:', error);
          if (pendingDispatchConfirmation) {
            await confirmViventiumDispatch(
              pendingDispatchConfirmation.callSessionId,
              pendingDispatchConfirmation.claimId,
              'failed',
              error
            ).catch((confirmError) => {
              console.error('Error releasing failed Viventium dispatch claim:', confirmError);
            });
          }
          return NextResponse.json(
            {
              message:
                'Viventium could not prepare this voice call session. Please try starting the call again.',
            },
            { status: 503 }
          );
        }
      } else {
        try {
          await ensureExplicitAgentDispatch(options.room_name, agentName, agentMetadata);
        } catch (error) {
          console.error('Error creating agent dispatch:', error);
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
          pendingDispatchConfirmation.claimId,
          'created'
        );
      }
    } catch (error) {
      if (pendingDispatchConfirmation) {
        await confirmViventiumDispatch(
          pendingDispatchConfirmation.callSessionId,
          pendingDispatchConfirmation.claimId,
          'failed',
          error
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
