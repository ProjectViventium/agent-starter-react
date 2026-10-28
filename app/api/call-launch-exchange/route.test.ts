// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS;
  delete process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  delete process.env.VIVENTIUM_CALL_SESSION_SECRET;
  vi.resetModules();
});

describe('one-time call launch exchange BFF', () => {
  it('forwards the launch bearer only in its dedicated header and never caches it', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://chat.example.test';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    const upstream = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get('X-VIVENTIUM-CALL-SECRET')).toBe('server-secret');
      expect(headers.get('X-VIVENTIUM-CALL-LAUNCH')).toBe('L'.repeat(43));
      expect(headers.get('X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY')).toBe('I'.repeat(43));
      return new Response(
        JSON.stringify({
          version: 1,
          callSessionId: 'call-1',
          browserCapability: 'B'.repeat(43),
          expiresAt: '2026-08-09T22:00:00.000Z',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    });
    vi.stubGlobal('fetch', upstream);
    const { POST } = await import('@/app/api/call-launch-exchange/route');
    const response = await POST(
      new Request('https://voice.example.test/api/call-launch-exchange?callSessionId=call-1', {
        method: 'POST',
        headers: {
          'X-VIVENTIUM-CALL-LAUNCH': 'L'.repeat(43),
          'X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY': 'I'.repeat(43),
        },
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, private');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    await expect(response.json()).resolves.toEqual({
      version: 1,
      callSessionId: 'call-1',
      browserCapability: 'B'.repeat(43),
      expiresAt: '2026-08-09T22:00:00.000Z',
    });
    expect(upstream).toHaveBeenCalledWith(
      'https://chat.example.test/api/viventium/calls/call-1/browser-capability/exchange',
      expect.objectContaining({ method: 'POST', cache: 'no-store', redirect: 'error' })
    );
    expect(upstream.mock.calls[0]?.[0]).not.toContain('L'.repeat(43));
  });

  it.each([
    ['missing', ''],
    ['malformed', 'short'],
  ])('rejects a %s bearer before contacting LibreChat', async (_label, launch) => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://chat.example.test';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const { POST } = await import('@/app/api/call-launch-exchange/route');
    const headers = launch
      ? {
          'X-VIVENTIUM-CALL-LAUNCH': launch,
          'X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY': 'I'.repeat(43),
        }
      : undefined;
    const response = await POST(
      new Request('https://voice.example.test/api/call-launch-exchange?callSessionId=call-1', {
        method: 'POST',
        headers,
      })
    );
    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('passes through replay, expiry, and cross-session rejection without leaking the bearer', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://chat.example.test';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              code: 'auth_expired',
              message: 'This call link expired or was already used.',
              retryable: false,
            }),
            { status: 410, headers: { 'Content-Type': 'application/json' } }
          )
      )
    );
    const { POST } = await import('@/app/api/call-launch-exchange/route');
    const response = await POST(
      new Request('https://voice.example.test/api/call-launch-exchange?callSessionId=other-call', {
        method: 'POST',
        headers: {
          'X-VIVENTIUM-CALL-LAUNCH': 'L'.repeat(43),
          'X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY': 'I'.repeat(43),
        },
      })
    );
    expect(response.status).toBe(410);
    const body = await response.text();
    expect(body).not.toContain('L'.repeat(43));
  });
});

describe('launch exchange upstream lifetime', () => {
  function launchRequest(signal?: AbortSignal) {
    return new Request('https://voice.example.test/api/call-launch-exchange?callSessionId=call-1', {
      method: 'POST',
      headers: {
        'X-VIVENTIUM-CALL-LAUNCH': 'L'.repeat(43),
        'X-VIVENTIUM-CALL-LAUNCH-IDEMPOTENCY': 'I'.repeat(43),
      },
      signal,
    });
  }

  function configure() {
    vi.useFakeTimers();
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://core.example.test';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-secret';
    process.env.VIVENTIUM_CALL_PROXY_TIMEOUT_MS = '10';
  }

  it.each(['headers', 'body-200', 'body-410'])(
    'bounds an upstream stall at %s without retrying or changing the launch binding',
    async (stage) => {
      configure();
      const observed: { signal?: AbortSignal; response?: Response } = {};
      const upstream = vi.fn(async (_url: string, init: RequestInit) => {
        observed.signal = init.signal as AbortSignal;
        const stalled = () =>
          new Promise<string>((_resolve, reject) => {
            observed.signal?.addEventListener(
              'abort',
              () => reject(new Error('upstream aborted')),
              { once: true }
            );
          });
        if (stage === 'headers') return await stalled();
        return {
          ok: stage === 'body-200',
          status: stage === 'body-200' ? 200 : 410,
          text: stalled,
        };
      });
      vi.stubGlobal('fetch', upstream);
      const { POST } = await import('@/app/api/call-launch-exchange/route');
      void POST(launchRequest()).then((value) => {
        observed.response = value;
      });
      await vi.advanceTimersByTimeAsync(11);
      expect(observed.response?.status).toBe(504);
      await expect(observed.response!.json()).resolves.toMatchObject({
        code: 'gateway_down',
        retryable: true,
      });
      expect(observed.signal?.aborted).toBe(true);
      expect(upstream).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it('aborts the same upstream body when the requesting browser disconnects', async () => {
    configure();
    const browser = new AbortController();
    const observed: { signal?: AbortSignal } = {};
    const upstream = vi.fn(async (_url: string, init: RequestInit) => {
      observed.signal = init.signal as AbortSignal;
      return {
        ok: true,
        status: 200,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            observed.signal?.addEventListener(
              'abort',
              () => reject(new Error('upstream aborted')),
              { once: true }
            );
          }),
      };
    });
    vi.stubGlobal('fetch', upstream);
    const { POST } = await import('@/app/api/call-launch-exchange/route');
    const pending = POST(launchRequest(browser.signal));
    await vi.advanceTimersByTimeAsync(0);
    browser.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(observed.signal?.aborted).toBe(true);
    expect((await pending).status).toBe(503);
    expect(upstream).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not send a launch exchange for an already disconnected request', async () => {
    configure();
    const browser = new AbortController();
    browser.abort();
    const upstream = vi.fn();
    vi.stubGlobal('fetch', upstream);
    const { POST } = await import('@/app/api/call-launch-exchange/route');
    const response = await POST(launchRequest(browser.signal));
    expect(response.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the deadline after a valid complete launch exchange', async () => {
    configure();
    const upstream = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            version: 1,
            callSessionId: 'call-1',
            browserCapability: 'B'.repeat(43),
          }),
          { status: 200 }
        )
    );
    vi.stubGlobal('fetch', upstream);
    const { POST } = await import('@/app/api/call-launch-exchange/route');
    const response = await POST(launchRequest());
    expect(response.status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
    expect(upstream).toHaveBeenCalledOnce();
  });
});
