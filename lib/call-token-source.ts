/*
 * Token source for a Viventium call (CP-CMP-002, CP-CMP-003, seam S1).
 *
 * The page asks its own server (`POST /api/token`) for the room address and token, with the
 * per-call browser capability in a header. Upstream's `TokenSource.endpoint` cannot send that
 * header, so this is a literal token source around one `fetch`.
 *
 * Why it remembers the token: `useSession` (components-react 2.9.25) asks the token source again
 * on mount (connection prewarm), on `end()` and on every unexpected disconnect. For a signed call
 * each request prepares a voice-worker dispatch on the server, so only an explicit Start or Retry
 * may ask the server. Initial prewarm waits for that Start (after microphone capture); later SDK
 * requests get the token this call already has.
 *
 * One instance belongs to one call (one set of options). Nothing is shared between instances.
 *
 * Not ported: the client-side "re-dispatch when the room has no agent" watchdog (CP-CMP-006).
 * In the live page it only armed when the link carried `roomName` and `agentName`; the launch
 * link (`/call-bootstrap`) carries neither, so it never ran for a real call. The token route
 * still replaces a dispatch whose worker is gone whenever Start or Retry asks for a token.
 */
import { TokenSource, type TokenSourceFetchOptions, type TokenSourceFixed } from 'livekit-client';
import { callBrowserCapabilityHeaders } from '@/lib/call-browser-capability';
import { parseCallIdentifier } from '@/lib/call-proxy';
import { CallRequestError, callIssueFromResponse } from '@/lib/call-start';

export type CallTokenOptions = TokenSourceFetchOptions & {
  agentMetadata?: string;
  participantMetadata?: string;
};

export type CallConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantToken: string;
  participantName?: string;
  participantIdentity?: string;
};

export type CallTokenSource = {
  /** Hand this to `useSession`. */
  tokenSource: TokenSourceFixed;
  /** The signed call this source belongs to; `null` for an unsigned development call. */
  callSessionId: string | null;
  /** Explicit Start or Retry: replaces a token that is stale (or always, on Retry). */
  fetchForStart: (retry: boolean) => Promise<CallConnectionDetails>;
  /** From now on (30 s) the call counts as ending: no new token, no restart. */
  markEnding: () => void;
  isEnding: () => boolean;
};

const NETWORK_RETRY_MS = 1_500;
const NETWORK_MAX_ATTEMPTS = 2;
/** A prepared token younger than this is reused by an explicit Start (prewarm then Start). */
const PREPARED_TOKEN_FRESH_MS = 2_000;
const CALL_END_FENCE_MS = 30_000;

function callSessionIdFromOptions(options: CallTokenOptions): string | null {
  for (const candidate of [options.agentMetadata, options.participantMetadata]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      const parsed = JSON.parse(candidate) as { callSessionId?: unknown };
      const id = parseCallIdentifier(parsed.callSessionId);
      if (id) return id;
    } catch {
      // Structured metadata only; a malformed value carries no call authority.
    }
  }
  return null;
}

function readConnectionDetails(payload: unknown): CallConnectionDetails {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CallRequestError({
      kind: 'gateway_down',
      message: 'The voice runtime returned invalid connection details.',
    });
  }
  const value = payload as Record<string, unknown>;
  const required = (field: unknown) => (typeof field === 'string' && field.trim() ? field : null);
  const serverUrl = required(value.serverUrl);
  const roomName = required(value.roomName);
  const participantToken = required(value.participantToken);
  if (!serverUrl || !roomName || !participantToken) {
    throw new CallRequestError({
      kind: 'gateway_down',
      message: 'The voice runtime returned incomplete connection details.',
    });
  }
  return {
    serverUrl,
    roomName,
    participantToken,
    ...(typeof value.participantName === 'string'
      ? { participantName: value.participantName }
      : {}),
    ...(typeof value.participantIdentity === 'string'
      ? { participantIdentity: value.participantIdentity }
      : {}),
  };
}

export function createCallTokenSource(
  endpoint: string,
  options: CallTokenOptions = {}
): CallTokenSource {
  const callSessionId = callSessionIdFromOptions(options);
  let prepared: { value: CallConnectionDetails; createdAt: number } | null = null;
  let inFlight: Promise<CallConnectionDetails> | null = null;
  /** The room and identity this call got first; a signed call may never change them. */
  let pinned: { roomName: string; participantIdentity: string } | null = null;
  let endingUntil = 0;
  let sdkPreparation: {
    promise: Promise<CallConnectionDetails>;
    resolve: (details: CallConnectionDetails) => void;
    reject: (error: unknown) => void;
  } | null = null;

  const isEnding = () => endingUntil > Date.now();

  const endedCallError = () =>
    new CallRequestError({
      kind: 'auth_expired',
      message: 'This call has ended. Start a fresh call from Viventium.',
    });

  const checkCallIdentity = (details: CallConnectionDetails) => {
    if (!callSessionId) return;
    if (options.roomName && options.roomName !== details.roomName) {
      throw new CallRequestError({
        kind: 'auth_expired',
        message: 'The signed call session does not match the connected room.',
      });
    }
    if (!details.participantIdentity) {
      throw new CallRequestError({
        kind: 'auth_expired',
        message: 'The signed call session returned no stable owner identity.',
      });
    }
    if (
      pinned &&
      (pinned.roomName !== details.roomName ||
        pinned.participantIdentity !== details.participantIdentity)
    ) {
      throw new CallRequestError({
        kind: 'auth_expired',
        message: 'The signed call identity changed during reconnect.',
      });
    }
    pinned = { roomName: details.roomName, participantIdentity: details.participantIdentity };
  };

  const request = async (): Promise<CallConnectionDetails> => {
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      if (isEnding()) throw endedCallError();
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...callBrowserCapabilityHeaders(callSessionId ?? ''),
          },
          body: JSON.stringify(options),
          cache: 'no-store',
        });
        break;
      } catch (error) {
        if (!(error instanceof TypeError) || attempt + 1 >= NETWORK_MAX_ATTEMPTS) {
          throw new CallRequestError({
            kind: 'gateway_down',
            message: 'Viventium could not reach the voice runtime.',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, NETWORK_RETRY_MS));
      }
    }
    let payload: unknown = null;
    try {
      payload = JSON.parse(await response.text());
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const issue = callIssueFromResponse(response.status, payload);
      throw new CallRequestError(issue, issue.retryable === true);
    }
    const details = readConnectionDetails(payload);
    checkCallIdentity(details);
    return details;
  };

  const fetchDetails = (): Promise<CallConnectionDetails> => {
    if (inFlight) return inFlight;
    if (
      prepared &&
      (isEnding() || callSessionId || Date.now() - prepared.createdAt < PREPARED_TOKEN_FRESH_MS)
    ) {
      return Promise.resolve(prepared.value);
    }
    if (isEnding()) return Promise.reject(endedCallError());
    const pending = request()
      .then((value) => {
        prepared = { value, createdAt: Date.now() };
        return value;
      })
      .finally(() => {
        if (inFlight === pending) inFlight = null;
      });
    inFlight = pending;
    return pending;
  };

  // SDK prewarm has no microphone permission context. For a signed call it waits for the
  // existing Start owner to finish capture and explicitly prepare dispatch, then shares that
  // exact result. Passive SDK fetches never initiate a new signed dispatch.
  const fetchForSdk = (): Promise<CallConnectionDetails> => {
    if (!callSessionId || prepared || inFlight || isEnding()) return fetchDetails();
    if (!sdkPreparation) {
      let resolve!: (details: CallConnectionDetails) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<CallConnectionDetails>((accept, decline) => {
        resolve = accept;
        reject = decline;
      });
      sdkPreparation = { promise, resolve, reject };
    }
    return sdkPreparation.promise;
  };

  return {
    tokenSource: TokenSource.literal(fetchForSdk),
    callSessionId,
    fetchForStart: (retry) => {
      if (
        prepared &&
        !isEnding() &&
        (retry || Date.now() - prepared.createdAt >= PREPARED_TOKEN_FRESH_MS)
      ) {
        prepared = null;
      }
      const pending = fetchDetails();
      if (sdkPreparation) {
        const waiting = sdkPreparation;
        sdkPreparation = null;
        void pending.then(waiting.resolve, waiting.reject);
      }
      return pending;
    },
    markEnding: () => {
      endingUntil = Date.now() + CALL_END_FENCE_MS;
      if (sdkPreparation) {
        sdkPreparation.reject(endedCallError());
        sdkPreparation = null;
      }
    },
    isEnding,
  };
}
