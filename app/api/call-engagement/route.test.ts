import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '@/app/api/call-engagement/route';
import { proxyCallTaskRequest } from '@/app/api/call-tasks/proxy';

const browserCapability = 'A'.repeat(43);
const validRequest = {
  version: 1,
  callSessionId: 'call-owner-1',
  turnId: 'turn-owner-1',
  segmentIds: ['segment-owner-1'],
};

function request(
  body: unknown = validRequest,
  options: { capability?: string; session?: string; search?: string; signal?: AbortSignal } = {}
) {
  const incoming = new Request(
    `https://playground.example.com/api/call-engagement${options.search ?? ''}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(options.capability !== undefined
          ? { 'X-VIVENTIUM-CALL-CAPABILITY': options.capability }
          : {}),
        ...(options.session !== undefined ? { 'X-VIVENTIUM-CALL-SESSION': options.session } : {}),
      },
      body: JSON.stringify(body),
    }
  );
  if (options.signal) {
    Object.defineProperty(incoming, 'signal', { value: options.signal });
  }
  return incoming;
}

function signedVerdict(directlyAddressed: boolean) {
  return {
    version: 1,
    callSessionId: validRequest.callSessionId,
    turnId: validRequest.turnId,
    participantIdentity: 'owner-participant',
    segmentIds: validRequest.segmentIds,
    directlyAddressed,
    source: 'semantic_model',
    revision: 3,
    issuedAtMs: 1_787_659_200_000,
    expiresAtMs: 1_787_659_215_000,
    attestation: 'B'.repeat(43),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  delete process.env.VIVENTIUM_CALL_SESSION_SECRET;
  delete process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS;
});

describe('call engagement classification proxy', () => {
  it.each([true, false])(
    'forwards the exact protected request and preserves a signed %s model verdict',
    async (directlyAddressed) => {
      process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
      process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
      const verdict = signedVerdict(directlyAddressed);
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(verdict), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(request(validRequest, { capability: browserCapability }));

      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.json()).toEqual(verdict);
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(url.toString()).toBe(
        'https://librechat.example.com/api/viventium/voice/engagement/classify'
      );
      expect(init).toMatchObject({
        method: 'POST',
        cache: 'no-store',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-SECRET': 'synthetic-server-secret',
          'X-VIVENTIUM-CALL-SESSION': 'call-owner-1',
          'X-VIVENTIUM-CALL-CAPABILITY': browserCapability,
        },
      });
      expect(JSON.parse(String(init.body))).toEqual(validRequest);
      expect(String(url)).not.toContain(browserCapability);
      expect(String(init.body)).not.toContain(browserCapability);
      expect(String(init.body)).not.toContain('synthetic-server-secret');
      expect(String(init.body)).not.toContain('owner-participant');
    }
  );

  it('accepts the documented request without optional segment identifiers', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(signedVerdict(true)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const body = { version: 1, callSessionId: 'call-owner-1', turnId: 'turn-owner-1' };
    const response = await POST(request(body, { capability: browserCapability }));

    expect(response.status).toBe(200);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual(body);
  });

  it('gives classification 8.5 seconds without changing the 4.5-second task proxy deadline', async () => {
    vi.useFakeTimers();
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
    const fetchMock = vi.fn(
      (_url: URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const engagementResponse = POST(request(validRequest, { capability: browserCapability }));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledOnce();
    const engagementSignal = fetchMock.mock.calls[0]?.[1]?.signal;

    const taskResponse = proxyCallTaskRequest(
      '/api/viventium/voice/tasks?callSessionId=call-owner-1',
      'GET',
      'call-owner-1',
      browserCapability
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const taskSignal = fetchMock.mock.calls[1]?.[1]?.signal;

    await vi.advanceTimersByTimeAsync(4_499);
    expect(taskSignal?.aborted).toBe(false);
    expect(engagementSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(taskSignal?.aborted).toBe(true);
    expect(engagementSignal?.aborted).toBe(false);
    expect((await taskResponse).status).toBe(504);

    await vi.advanceTimersByTimeAsync(3_999);
    expect(engagementSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(engagementSignal?.aborted).toBe(true);
    const response = await engagementResponse;
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: 'gateway_down', retryable: true });
  });

  it('accepts a 7.8-second signed model response even when task proxies have a shorter configured budget', async () => {
    vi.useFakeTimers();
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
    process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS = '1600';
    const verdict = signedVerdict(false);
    const fetchMock = vi.fn(
      (_url: URL, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
          setTimeout(() => resolve(new Response(JSON.stringify(verdict), { status: 200 })), 7_800);
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const pending = POST(request(validRequest, { capability: browserCapability }));
    await vi.advanceTimersByTimeAsync(0);
    const coreRequest = fetchMock.mock.calls[0]?.[1]?.signal;

    await vi.advanceTimersByTimeAsync(1_600);
    expect(coreRequest?.aborted).toBe(false);
    expect(process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS).toBe('1600');

    await vi.advanceTimersByTimeAsync(6_200);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(verdict);
    expect(coreRequest?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('propagates browser request cancellation to the authenticated Core classification', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
    const fetchMock = vi.fn(
      (_url: URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true }
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const browserRequest = new AbortController();

    const response = POST(
      request(validRequest, {
        capability: browserCapability,
        signal: browserRequest.signal,
      })
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const coreRequest = fetchMock.mock.calls[0]?.[1]?.signal;

    browserRequest.abort();

    expect(coreRequest?.aborted).toBe(true);
    expect((await response).status).toBe(503);
  });

  it('passes an already-cancelled browser request to fetch as aborted', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
    let coreSignal: AbortSignal | null | undefined;
    const fetchMock = vi.fn((_url: URL, init?: RequestInit) => {
      coreSignal = init?.signal;
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    });
    vi.stubGlobal('fetch', fetchMock);
    const browserRequest = new AbortController();
    browserRequest.abort();

    const response = await POST(
      request(validRequest, {
        capability: browserCapability,
        signal: browserRequest.signal,
      })
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(coreSignal?.aborted).toBe(true);
    expect(response.status).toBe(503);
  });

  it('fails closed when the server-side Core origin or session secret is unavailable', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request(validRequest, { capability: browserCapability }));

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: 'gateway_down', retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed when the configured Core origin is malformed', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'not a valid URL';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request(validRequest, { capability: browserCapability }));

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      code: 'gateway_down',
      message: 'The voice task runtime is not configured.',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalizes a Core connection failure without exposing credentials or internal errors', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Private upstream connection')));

    const response = await POST(request(validRequest, { capability: browserCapability }));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: 'gateway_down',
      message: 'Viventium could not reach the voice task runtime.',
      retryable: true,
    });
  });

  it.each([undefined, '', 'invalid', 'A'.repeat(42)])(
    'rejects missing or malformed browser capability without contacting Core: %s',
    async (capability) => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const response = await POST(request(validRequest, { capability }));

      expect(response.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    { ...validRequest, version: 2 },
    { ...validRequest, callSessionId: '' },
    { ...validRequest, callSessionId: ' call-owner-1 ' },
    { ...validRequest, callSessionId: '../another-call' },
    { ...validRequest, turnId: '' },
    { ...validRequest, turnId: '../another-turn' },
    { ...validRequest, segmentIds: [] },
    { ...validRequest, segmentIds: ['segment-owner-1', 'segment-owner-1'] },
    { ...validRequest, segmentIds: ['../another-segment'] },
    { ...validRequest, segmentIds: Array.from({ length: 33 }, (_, index) => `segment-${index}`) },
    { ...validRequest, segmentIds: 'segment-owner-1' },
    { ...validRequest, text: 'Private owner transcript must never leave this boundary.' },
    { ...validRequest, participantIdentity: 'owner-participant' },
    { ...validRequest, directlyAddressed: true },
    { ...validRequest, source: 'semantic_model' },
    { ...validRequest, attestation: 'B'.repeat(43) },
    { ...validRequest, browserCapability },
    ['call-owner-1'],
    null,
  ])('rejects malformed or over-authoritative request bodies: %o', async (body) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(request(body, { capability: browserCapability }));

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a browser session header bound to another call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      request(validRequest, {
        capability: browserCapability,
        session: 'call-another-owner',
      })
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects query-string authority and malformed JSON without contacting Core', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const queried = await POST(
      request(validRequest, {
        capability: browserCapability,
        search: '?callSessionId=call-another-owner',
      })
    );
    const malformed = await POST(
      new Request('https://playground.example.com/api/call-engagement', {
        method: 'POST',
        headers: { 'X-VIVENTIUM-CALL-CAPABILITY': browserCapability },
        body: '{',
      })
    );

    expect(queried.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves upstream authorization failures without exposing internal detail', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'voice_engagement_not_authorized',
            message: 'The speaker cannot authorize this call turn.',
            retryable: false,
          }),
          { status: 403 }
        )
      )
    );

    const response = await POST(request(validRequest, { capability: browserCapability }));

    expect(response.status).toBe(403);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      code: 'unknown',
      message: 'The speaker cannot authorize this call turn.',
      retryable: false,
    });
  });
});
