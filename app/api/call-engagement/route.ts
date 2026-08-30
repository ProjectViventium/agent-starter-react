import { NextResponse } from 'next/server';
import {
  CALL_CAPABILITY_HEADER,
  readRequestCallBrowserCapability,
} from '@/lib/call-browser-capability';
import { normalizeProxyFailure, parseCallIdentifier } from '@/lib/call-proxy';

const REQUEST_FIELDS = new Set(['version', 'callSessionId', 'turnId', 'segmentIds']);
const MAX_SEGMENT_IDS = 32;
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' } as const;
// Keep model classification inside the browser's 9-second and gateway's 10-second deadlines
// without changing the shared task proxy's unrelated 4.5-second request budget.
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

async function proxyCallEngagementRequest(
  request: Request,
  browserCapability: string,
  body: CallEngagementRequest
) {
  const origin = process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  const secret = process.env.VIVENTIUM_CALL_SESSION_SECRET;
  if (!origin || !secret) {
    return NextResponse.json(
      {
        code: 'gateway_down',
        message: 'The voice task runtime is not configured.',
        retryable: false,
      },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }

  let target: URL;
  try {
    target = new URL('/api/viventium/voice/engagement/classify', origin);
  } catch {
    return NextResponse.json(
      {
        code: 'gateway_down',
        message: 'The voice task runtime is not configured.',
        retryable: false,
      },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  }
  const controller = new AbortController();
  const abortRequest = () => controller.abort();
  if (request.signal.aborted) {
    controller.abort();
  }
  request.signal.addEventListener('abort', abortRequest, { once: true });
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CALL_ENGAGEMENT_PROXY_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(target, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-VIVENTIUM-CALL-SECRET': secret,
        'X-VIVENTIUM-CALL-SESSION': body.callSessionId,
        [CALL_CAPABILITY_HEADER]: browserCapability,
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      // Never forward the server-only call secret through an upstream redirect.
      redirect: 'error',
      signal: controller.signal,
    });
  } catch {
    if (timedOut) {
      return NextResponse.json(
        {
          code: 'gateway_down',
          message: 'The voice task runtime did not respond before the request timed out.',
          retryable: true,
        },
        { status: 504, headers: NO_STORE_HEADERS }
      );
    }
    return NextResponse.json(
      {
        code: 'gateway_down',
        message: 'Viventium could not reach the voice task runtime.',
        retryable: true,
      },
      { status: 503, headers: NO_STORE_HEADERS }
    );
  } finally {
    clearTimeout(timeoutId);
    request.signal.removeEventListener('abort', abortRequest);
  }

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    return NextResponse.json(normalizeProxyFailure(response.status, payload), {
      status: response.status,
      headers: NO_STORE_HEADERS,
    });
  }
  return NextResponse.json(payload ?? {}, {
    status: response.status,
    headers: NO_STORE_HEADERS,
  });
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
