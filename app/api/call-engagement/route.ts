/*
 * Wing engagement proxy (CP-APP-022): asks Core whether a finished owner turn in Wing mode was
 * addressed to Viventium and returns Core's signed verdict unchanged.
 */
import { NextResponse } from 'next/server';
import { corePaths, coreRequest, readCoreJson } from '@/app/api/call-tasks/proxy';
import { readRequestCallBrowserCapability } from '@/lib/call-browser-capability';
import { normalizeProxyFailure, parseCallIdentifier } from '@/lib/call-proxy';

const REQUEST_FIELDS = new Set(['version', 'callSessionId', 'turnId', 'segmentIds']);
const MAX_SEGMENT_IDS = 32;
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;
// The verdict comes from a model: keep it inside the browser's 9-second and the gateway's
// 10-second deadlines, independent of the shared 4.5-second proxy budget.
const CALL_ENGAGEMENT_PROXY_TIMEOUT_MS = 8_500;

type CallEngagementRequest = {
  version: 1;
  callSessionId: string;
  turnId: string;
  segmentIds?: string[];
};

function invalidRequest() {
  return NextResponse.json(
    { code: 'unknown', message: 'The call engagement request is invalid.', retryable: false },
    { status: 400, headers: NO_STORE_HEADERS }
  );
}

function engagementRuntimeFailure(message: string, retryable: boolean, status: 503 | 504) {
  return NextResponse.json(
    { code: 'gateway_down', message, retryable },
    { status, headers: NO_STORE_HEADERS }
  );
}

async function proxyCallEngagementRequest(
  request: Request,
  browserCapability: string,
  body: CallEngagementRequest
) {
  const outcome = await coreRequest({
    path: corePaths.engagementClassify(),
    method: 'POST',
    browserCapability,
    sessionHeader: body.callSessionId,
    body,
    timeoutMs: CALL_ENGAGEMENT_PROXY_TIMEOUT_MS,
    // Never forward the server-only call secret through an upstream redirect.
    redirect: 'error',
    cancelWith: request.signal,
    readBody: readCoreJson,
  });
  if (outcome.kind === 'unconfigured') {
    return engagementRuntimeFailure('The voice task runtime is not configured.', false, 503);
  }
  if (outcome.kind === 'timeout') {
    return engagementRuntimeFailure(
      'The voice task runtime did not respond before the request timed out.',
      true,
      504
    );
  }
  if (outcome.kind === 'unreachable') {
    return engagementRuntimeFailure('Viventium could not reach the voice task runtime.', true, 503);
  }
  return NextResponse.json(
    outcome.ok ? (outcome.payload ?? {}) : normalizeProxyFailure(outcome.status, outcome.payload),
    { status: outcome.status, headers: NO_STORE_HEADERS }
  );
}

export async function POST(request: Request) {
  const browserCapability = readRequestCallBrowserCapability(request);
  if (!browserCapability) {
    return NextResponse.json(
      {
        code: 'auth_expired',
        message: 'The call capability is missing or invalid.',
        retryable: false,
      },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  if (new URL(request.url).search) {
    return invalidRequest();
  }

  const body: unknown = await request.json().catch(() => null);
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    Object.keys(body).some((field) => !REQUEST_FIELDS.has(field))
  ) {
    return invalidRequest();
  }

  const incoming = body as Record<string, unknown>;
  const callSessionId = parseCallIdentifier(incoming.callSessionId);
  const turnId = parseCallIdentifier(incoming.turnId);
  const requestSessionId = request.headers.get('X-VIVENTIUM-CALL-SESSION');
  if (
    incoming.version !== 1 ||
    !callSessionId ||
    callSessionId !== incoming.callSessionId ||
    !turnId ||
    turnId !== incoming.turnId ||
    (requestSessionId !== null && requestSessionId !== callSessionId)
  ) {
    return invalidRequest();
  }

  let segmentIds: string[] | undefined;
  if (Object.hasOwn(incoming, 'segmentIds')) {
    if (
      !Array.isArray(incoming.segmentIds) ||
      incoming.segmentIds.length === 0 ||
      incoming.segmentIds.length > MAX_SEGMENT_IDS ||
      incoming.segmentIds.some((segmentId) => parseCallIdentifier(segmentId) !== segmentId) ||
      new Set(incoming.segmentIds).size !== incoming.segmentIds.length
    ) {
      return invalidRequest();
    }
    segmentIds = incoming.segmentIds as string[];
  }

  return proxyCallEngagementRequest(request, browserCapability, {
    version: 1,
    callSessionId,
    turnId,
    ...(segmentIds ? { segmentIds } : {}),
  });
}
