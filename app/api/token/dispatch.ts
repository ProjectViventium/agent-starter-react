/*
 * One voice worker per call (CP-APP-012, server side only).
 *
 * Before the owner's token is minted the token route makes sure exactly one voice worker is
 * attached to the call's room. Core arbitrates with a claim: the route claims the right to
 * dispatch, creates an explicit LiveKit agent dispatch tagged with the claim id, and waits until
 * a worker has consumed that claim. Reconnects reuse the proven dispatch, or replace it through a
 * fresh claim when its worker is gone. Everything fails fast: the whole step shares one budget.
 *
 * LiveKit applies a token's room configuration only when it creates the room, which is why a
 * reconnect into an existing room cannot rely on the token to bring a worker back.
 */
import {
  type AgentDispatch,
  AgentDispatchClient,
  RoomAgentDispatch,
  RoomServiceClient,
} from 'livekit-server-sdk';
import { JobStatus } from '@livekit/protocol';
import { corePaths, coreRequest, readCoreJson } from '@/app/api/call-tasks/proxy';

/** A signed call's room stays open this long after the owner drops, so a refresh rejoins it. */
export const CALL_SESSION_RECONNECT_GRACE_SECONDS = 60;

const DISPATCH_POLL_MS = 100;

export function dispatchBudgetMs(): number {
  return Math.min(
    Math.max(Number(process.env.VIVENTIUM_CALL_DISPATCH_ASSIGN_TIMEOUT_MS) || 2500, 250),
    5000
  );
}

/** Default: explicit dispatch. `token_room_config` / `room_config` put the agent in the token. */
function usesExplicitAgentDispatch(): boolean {
  const mode = (process.env.VIVENTIUM_LIVEKIT_AGENT_DISPATCH_MODE || '').trim().toLowerCase();
  return mode !== 'token_room_config' && mode !== 'room_config';
}

const remainingMs = (deadlineMs: number) => Math.max(1, Math.floor(deadlineMs - Date.now()));
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type CallAuthority = { callSessionId: string; browserCapability: string };
type DispatchClaim = { status?: string; claimId?: string | null };

// ---- Core: claim, status, confirm ---------------------------------------------------------

async function claimDispatch(
  call: CallAuthority,
  roomName: string,
  agentName: string,
  reclaimConfirmed: boolean,
  deadlineMs: number
): Promise<DispatchClaim | null> {
  const outcome = await coreRequest({
    path: corePaths.dispatchClaim(call.callSessionId),
    method: 'POST',
    browserCapability: call.browserCapability,
    body: { roomName, agentName, reclaimConfirmed },
    timeoutMs: remainingMs(deadlineMs),
    readBody: readCoreJson,
  });
  if (outcome.kind !== 'response' || !outcome.ok) {
    throw new Error(
      outcome.kind === 'response'
        ? `Dispatch claim failed (${outcome.status})`
        : 'Dispatch claim failed'
    );
  }
  return outcome.payload as DispatchClaim | null;
}

/** Claims, and while another request holds the claim (`in_flight`) keeps asking. */
async function claimDispatchWhenFree(
  call: CallAuthority,
  roomName: string,
  agentName: string,
  reclaimConfirmed: boolean,
  deadlineMs: number
): Promise<DispatchClaim | null> {
  let claim = await claimDispatch(call, roomName, agentName, reclaimConfirmed, deadlineMs);
  while (claim?.status === 'in_flight' && Date.now() < deadlineMs) {
    await pause(DISPATCH_POLL_MS);
    claim = await claimDispatch(call, roomName, agentName, reclaimConfirmed, deadlineMs);
  }
  if (claim?.status === 'in_flight') {
    throw new Error('Another dispatch claim did not reach a ready worker');
  }
  return claim;
}

async function awaitWorkerClaim(
  call: CallAuthority,
  claimId: string,
  deadlineMs: number
): Promise<void> {
  while (Date.now() < deadlineMs) {
    const outcome = await coreRequest({
      path: corePaths.dispatchStatus(call.callSessionId, claimId),
      method: 'GET',
      browserCapability: call.browserCapability,
      jsonContentType: false,
      timeoutMs: remainingMs(deadlineMs),
      readBody: readCoreJson,
    });
    if (outcome.kind !== 'response' || !outcome.ok) {
      throw new Error('Dispatch status failed');
    }
    const status = (outcome.payload ?? {}) as { status?: string; isWorkerClaimed?: boolean };
    if (status.isWorkerClaimed === true && status.status === 'claimed') {
      return;
    }
    if (status.status === 'expired' || status.status === 'superseded') {
      throw new Error(`Dispatch claim is ${status.status}`);
    }
    await pause(DISPATCH_POLL_MS);
  }
  throw new Error('No registered LiveKit voice worker consumed the dispatch claim');
}

/** Tells Core the claimed dispatch was created, or releases the claim with the failure. */
export async function confirmDispatch(
  call: CallAuthority,
  claimId: string,
  status: 'created' | 'failed',
  deadlineMs: number,
  error?: unknown
): Promise<void> {
  const outcome = await coreRequest({
    path: corePaths.dispatchConfirm(call.callSessionId),
    method: 'POST',
    browserCapability: call.browserCapability,
    body: {
      claimId,
      status,
      ...(status === 'failed'
        ? { error: error instanceof Error ? error.message : String(error ?? 'dispatch failed') }
        : {}),
    },
    timeoutMs: remainingMs(deadlineMs),
    readBody: readCoreJson,
  });
  if (outcome.kind !== 'response') {
    throw new Error('Dispatch confirm failed');
  }
  if (!outcome.ok) {
    console.error('Dispatch confirm failed:', outcome.status);
  }
}

// ---- LiveKit: explicit agent dispatch -----------------------------------------------------

function liveKitApiHost(): string {
  for (const url of [
    process.env.LIVEKIT_API_HOST,
    process.env.LIVEKIT_URL,
    process.env.NEXT_PUBLIC_LIVEKIT_URL,
  ]) {
    if (!url) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
      else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
      return parsed.origin;
    } catch {
      return url;
    }
  }
  throw new Error('LIVEKIT_API_HOST/LIVEKIT_URL is not configured for dispatch');
}

type DispatchAttempt = { cancelled: boolean; createdDispatchId?: string };

type ExplicitDispatchPlan =
  /** A new dispatch for a fresh claim; `replaceExisting` first deletes the agent's old ones. */
  | { kind: 'create'; metadata: string | undefined; replaceExisting: boolean }
  /** Reuse the dispatch a previous claim created, if a live worker still holds its job. */
  | { kind: 'verify_existing' };

function hasExplicitId(entry: AgentDispatch, agentName: string): boolean {
  // Token room-config entries can appear in ListDispatch without a real dispatch id. Only an
  // explicit dispatch id proves a worker assignment exists.
  return entry.agentName === agentName && typeof entry.id === 'string' && entry.id.length > 0;
}

async function runExplicitDispatch(
  roomName: string,
  agentName: string,
  plan: ExplicitDispatchPlan,
  deadlineMs: number,
  attempt: DispatchAttempt
): Promise<void> {
  const host = liveKitApiHost();
  const apiKey = process.env.LIVEKIT_API_KEY;
  const apiSecret = process.env.LIVEKIT_API_SECRET;
  const dispatch = new AgentDispatchClient(host, apiKey, apiSecret);
  const rooms = new RoomServiceClient(host, apiKey, apiSecret);
  await rooms.createRoom({
    name: roomName,
    emptyTimeout: CALL_SESSION_RECONNECT_GRACE_SECONDS,
    departureTimeout: CALL_SESSION_RECONNECT_GRACE_SECONDS,
  });
  if (attempt.cancelled) {
    throw new Error('LiveKit dispatch attempt was superseded');
  }

  if (plan.kind === 'create') {
    if (plan.replaceExisting) {
      try {
        const existing = ((await dispatch.listDispatch(roomName)) ?? []).filter((entry) =>
          hasExplicitId(entry, agentName)
        );
        await Promise.allSettled(
          existing.map((entry) => dispatch.deleteDispatch(entry.id, roomName))
        );
      } catch {
        console.warn('Unable to list existing LiveKit dispatches before forced create');
      }
    }
    const created = await dispatch.createDispatch(roomName, agentName, {
      metadata: plan.metadata ? plan.metadata : undefined,
    });
    if (!created?.id) {
      throw new Error('LiveKit did not return an explicit dispatch identity');
    }
    attempt.createdDispatchId = created.id;
    if (attempt.cancelled) {
      await dispatch.deleteDispatch(created.id, roomName).catch(() => undefined);
      throw new Error('LiveKit dispatch attempt was superseded');
    }
    // The worker's own claim (awaitWorkerClaim) is the proof of readiness for a new dispatch.
    return;
  }

  const existing = ((await dispatch.listDispatch(roomName)) ?? []).find((entry) =>
    hasExplicitId(entry, agentName)
  );
  if (!existing) {
    throw new Error('The confirmed LiveKit dispatch is no longer available');
  }
  const dispatchId = existing.id;
  // LiveKit assigns the room job before the owner token can join. A worker-bound pending job is
  // therefore sufficient; requiring JS_RUNNING would deadlock a cold start, because the gateway
  // is at the same time waiting for the canonical participant.
  const hasAssignedWorker = (candidate: AgentDispatch | undefined) =>
    candidate?.state?.jobs?.some(
      (job) =>
        job.dispatchId === dispatchId &&
        (job.state?.status === JobStatus.JS_PENDING ||
          job.state?.status === JobStatus.JS_RUNNING) &&
        typeof job.state.workerId === 'string' &&
        job.state.workerId.trim().length > 0
    ) === true;
  let current: AgentDispatch | undefined = existing;
  while (!hasAssignedWorker(current) && Date.now() < deadlineMs) {
    await pause(DISPATCH_POLL_MS);
    current = await dispatch.getDispatch(dispatchId, roomName);
  }
  if (!hasAssignedWorker(current)) {
    throw new Error('No registered LiveKit voice worker accepted the dispatch');
  }
}

/** Bounds the LiveKit calls by the deadline and deletes a dispatch that arrives too late. */
async function ensureExplicitDispatch(
  roomName: string,
  agentName: string,
  plan: ExplicitDispatchPlan,
  deadlineMs: number
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const attempt: DispatchAttempt = { cancelled: false };
  const work = runExplicitDispatch(roomName, agentName, plan, deadlineMs, attempt);
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('LiveKit dispatch readiness timed out')),
          remainingMs(deadlineMs)
        );
      }),
    ]);
  } catch (error) {
    attempt.cancelled = true;
    // A stalled create may still land later: the cancelled attempt deletes it when it does.
    if (attempt.createdDispatchId) {
      const host = liveKitApiHost();
      await new AgentDispatchClient(
        host,
        process.env.LIVEKIT_API_KEY,
        process.env.LIVEKIT_API_SECRET
      )
        .deleteDispatch(attempt.createdDispatchId, roomName)
        .catch(() => undefined);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function metadataForClaim(agentMetadata: string | undefined, claimId: string): string {
  try {
    const parsed = JSON.parse(agentMetadata || '{}') as Record<string, unknown>;
    return JSON.stringify({ ...parsed, dispatchClaimId: claimId });
  } catch {
    return JSON.stringify({ dispatchClaimId: claimId });
  }
}

// ---- The step the token route runs --------------------------------------------------------

export type CallDispatchResult =
  /**
   * A worker is attached (or, in token room-config mode, `tokenAgent` must go into the token).
   * `pendingClaimId` must be confirmed `created` after the token is minted, or `failed`.
   */
  | { kind: 'ready'; pendingClaimId: string | null; tokenAgent: RoomAgentDispatch | null }
  /** Core says the call session expired. */
  | { kind: 'expired' }
  /** No ready voice worker accepted the call within the budget; any claim was released. */
  | { kind: 'no_worker' };

export async function prepareCallDispatch(input: {
  call: CallAuthority;
  roomName: string;
  agentName: string;
  agentMetadata: string | undefined;
  /** The client's reconnect watchdog asks for a fresh explicit dispatch. */
  reclaimDispatch: boolean;
  /** End of the whole dispatch step, including releasing a failed claim. */
  deadlineMs: number;
}): Promise<CallDispatchResult> {
  const { call, roomName, agentName, agentMetadata, reclaimDispatch, deadlineMs } = input;
  const budgetMs = dispatchBudgetMs();
  // Keep a slice of the budget to release a failed claim.
  const workDeadlineMs = deadlineMs - Math.min(250, Math.max(1, Math.floor(budgetMs / 4)));
  let pendingClaimId: string | null = null;

  const createForClaim = async (claimId: string, replaceExisting: boolean) => {
    await ensureExplicitDispatch(
      roomName,
      agentName,
      { kind: 'create', metadata: metadataForClaim(agentMetadata, claimId), replaceExisting },
      workDeadlineMs
    );
    await awaitWorkerClaim(call, claimId, workDeadlineMs);
  };

  try {
    const claim = await claimDispatchWhenFree(
      call,
      roomName,
      agentName,
      reclaimDispatch,
      workDeadlineMs
    );
    const status = claim?.status ?? '';
    if (status === 'expired') {
      return { kind: 'expired' };
    }
    const claimId =
      status === 'claimed' && typeof claim?.claimId === 'string' ? claim.claimId : null;

    if (claimId) {
      pendingClaimId = claimId;
      // A watchdog reclaim must create a real dispatch even in token room-config mode.
      if (usesExplicitAgentDispatch() || reclaimDispatch) {
        await createForClaim(claimId, reclaimDispatch);
        return { kind: 'ready', pendingClaimId, tokenAgent: null };
      }
      return {
        kind: 'ready',
        pendingClaimId,
        tokenAgent: new RoomAgentDispatch({
          agentName,
          metadata: metadataForClaim(agentMetadata, claimId),
        }),
      };
    }

    if (status !== 'already') {
      throw new Error('Dispatch claim did not authorize a worker assignment');
    }
    try {
      await ensureExplicitDispatch(
        roomName,
        agentName,
        { kind: 'verify_existing' },
        workDeadlineMs
      );
    } catch {
      // The confirmed dispatch has no live worker any more: replace it under a fresh claim.
      const replacement = await claimDispatchWhenFree(
        call,
        roomName,
        agentName,
        true,
        workDeadlineMs
      );
      const replacementClaimId =
        replacement?.status === 'claimed' && typeof replacement.claimId === 'string'
          ? replacement.claimId
          : null;
      if (!replacementClaimId) {
        throw new Error('Confirmed dispatch could not be reclaimed');
      }
      pendingClaimId = replacementClaimId;
      await createForClaim(replacementClaimId, true);
    }
    return { kind: 'ready', pendingClaimId, tokenAgent: null };
  } catch (error) {
    console.error('Viventium dispatch was not accepted by a ready worker');
    if (pendingClaimId) {
      await confirmDispatch(call, pendingClaimId, 'failed', deadlineMs, error).catch(() => {
        console.error('Failed Viventium dispatch claim could not be released');
      });
    }
    return { kind: 'no_worker' };
  }
}
