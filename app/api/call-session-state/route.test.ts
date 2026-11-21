import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  delete process.env.VIVENTIUM_CALL_SESSION_SECRET;
  delete process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS;
  vi.resetModules();
});

describe('call session state proxy', () => {
  it.each(['.', '..'])('rejects dot-segment call %s without contacting Core', async (callId) => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://core.example.test';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-secret';
    const upstream = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', upstream);
    const { GET } = await import('@/app/api/call-session-state/route');
    const response = await GET(
      new Request(`https://voice.example.test/api/call-session-state?callSessionId=${callId}`, {
        headers: { 'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43) },
      })
    );
    expect(response.status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('bounds an unreachable state runtime with a retryable classified timeout', async () => {
    vi.useFakeTimers();
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS = '10';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError'))
            );
          })
      )
    );
    const { GET } = await import('@/app/api/call-session-state/route');

    const pending = GET(
      new Request('https://playground.example.com/api/call-session-state?callSessionId=call-1', {
        headers: { 'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43) },
      })
    );
    await vi.advanceTimersByTimeAsync(11);
    const response = await pending;

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      code: 'gateway_down',
      retryable: true,
    });
  });
});

describe('call state response-body deadline', () => {
  it.each([200, 410])('bounds a stalled state body after status %s', async (status) => {
    vi.useFakeTimers();
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://core.example.test';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-secret';
    process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS = '10';
    let signal: AbortSignal | null = null;
    const upstream = vi.fn(async (_url: string, init: RequestInit) => {
      signal = init.signal as AbortSignal;
      return {
        ok: status === 200,
        status,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            signal!.addEventListener('abort', () => reject(new Error('body aborted')), {
              once: true,
            });
          }),
      };
    });
    vi.stubGlobal('fetch', upstream);
    const { GET } = await import('@/app/api/call-session-state/route');
    const observed: { response?: Response } = {};
    void GET(
      new Request('https://voice.example.test/api/call-session-state?callSessionId=call-1', {
        headers: { 'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43) },
      })
    ).then((value) => {
      observed.response = value;
    });
    await vi.advanceTimersByTimeAsync(11);
    expect(observed.response?.status).toBe(504);
    await expect(observed.response!.json()).resolves.toMatchObject({
      code: 'gateway_down',
      retryable: true,
    });
    expect(signal!.aborted).toBe(true);
    expect(upstream).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes a completed state through unchanged and clears the deadline', async () => {
    vi.useFakeTimers();
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://core.example.test';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ mode: 'wing', shadowModeEnabled: true }), { status: 200 })
      )
    );
    const { GET } = await import('@/app/api/call-session-state/route');
    const response = await GET(
      new Request('https://voice.example.test/api/call-session-state?callSessionId=call-1', {
        headers: { 'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43) },
      })
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ mode: 'wing', shadowModeEnabled: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('call state single mode contract', () => {
  const stateRequest = (init?: RequestInit) =>
    new Request('https://voice.example.test/api/call-session-state?callSessionId=call-1', {
      ...init,
      headers: { 'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43), ...(init?.headers ?? {}) },
    });

  it.each([
    [{ listenOnlyModeEnabled: true, wingModeEnabled: true }, 'listen_only'],
    [{ wingModeEnabled: true }, 'wing'],
    [{ shadowModeEnabled: true }, 'wing'],
    [{ wingModeEnabled: false, shadowModeEnabled: true }, 'call'],
    [{ listenOnlyModeEnabled: false }, 'call'],
  ])('derives mode once for a legacy-only state %j', async (legacy, mode) => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://core.example.test';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(legacy), { status: 200 }))
    );
    const { GET } = await import('@/app/api/call-session-state/route');
    const response = await GET(stateRequest());
    await expect(response.json()).resolves.toEqual({ ...legacy, mode });
  });

  it('does not invent a mode for a state that reports none', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://core.example.test';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ status: 'listening' }), { status: 200 }))
    );
    const { GET } = await import('@/app/api/call-session-state/route');
    const response = await GET(stateRequest());
    await expect(response.json()).resolves.toEqual({ status: 'listening' });
  });

  it('forwards only mode, keep-alive and end to Core', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://core.example.test';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-secret';
    const upstream = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () => new Response('{}', { status: 200 })
    );
    vi.stubGlobal('fetch', upstream);
    const { POST } = await import('@/app/api/call-session-state/route');
    const post = (body: Record<string, unknown>) =>
      POST(
        stateRequest({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ callSessionId: 'call-1', ...body }),
        })
      );

    await post({ touch: true, mode: 'wing', wingModeEnabled: true, shadowModeEnabled: true });
    await post({ touch: true });
    await post({ status: 'ended', touch: true });
    expect((await post({ status: 'listening' })).status).toBe(400);

    expect(upstream).toHaveBeenCalledTimes(3);
    expect(upstream.mock.calls[0]?.[0]).toBe(
      'https://core.example.test/api/viventium/calls/call-1/state'
    );
    const sent = upstream.mock.calls.map((call) => JSON.parse(String(call[1]?.body)));
    expect(sent).toEqual([
      { touch: true, mode: 'wing' },
      { touch: true },
      { touch: false, status: 'ended' },
    ]);
    const headers = upstream.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['X-VIVENTIUM-CALL-SECRET']).toBe('synthetic-secret');
    expect(headers['X-VIVENTIUM-CALL-CAPABILITY']).toBe('A'.repeat(43));
    expect(headers['X-VIVENTIUM-CALL-SESSION']).toBeUndefined();
  });
});
