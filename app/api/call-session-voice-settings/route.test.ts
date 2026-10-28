/* VIVENTIUM START
 * Feature: Advisory Assistant route labels across the existing voice-settings proxy.
 * Purpose: Preserve public display metadata without another request or weaker call capability auth.
 * VIVENTIUM END */
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  delete process.env.VIVENTIUM_CALL_SESSION_SECRET;
});
describe('call voice settings label carrier', () => {
  it.each(['GET', 'POST'] as const)(
    'forwards labels and exact IDs on the existing %s response',
    async (method) => {
      process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
      process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
      const assignment = {
        provider: 'declared-provider',
        model: 'declared-model',
        providerLabel: 'Declared provider',
        modelLabel: 'Declared model',
        effort: 'high',
      };
      const payload = {
        assistantRoute: {
          primary: assignment,
          effective: assignment,
          inheritsPrimary: true,
        },
        requestedVoiceRoute: {},
        savedVoiceRoute: {},
      };
      const fetchMock = vi.fn(
        async (url: string) =>
          new Response(
            JSON.stringify(url.endsWith('/capabilities') ? { capabilities: [] } : payload),
            { status: 200 }
          )
      );
      vi.stubGlobal('fetch', fetchMock);
      const route = await import('@/app/api/call-session-voice-settings/route');
      const req = new Request(
        'https://playground.example.com/api/call-session-voice-settings?callSessionId=call-1',
        {
          method,
          headers: {
            'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
            'Content-Type': 'application/json',
          },
          ...(method === 'POST'
            ? {
                body: JSON.stringify({
                  callSessionId: 'call-1',
                  requestedVoiceRoute: {},
                }),
              }
            : {}),
        }
      );
      const response = await route[method](req);
      expect(response.status).toBe(200);
      expect((await response.json()).assistantRoute).toEqual(payload.assistantRoute);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    }
  );
  it('does not expose route labels without the existing exact call capability', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/call-session-voice-settings/route');
    const response = await GET(
      new Request(
        'https://playground.example.com/api/call-session-voice-settings?callSessionId=call-1'
      )
    );
    expect(response.status).toBe(401);
    expect((await response.json()).assistantRoute).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('voice settings response body deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.VIVENTIUM_VOICE_SETTINGS_PROXY_TIMEOUT_MS;
  });

  const configure = () => {
    vi.useFakeTimers();
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
    process.env.VIVENTIUM_VOICE_SETTINGS_PROXY_TIMEOUT_MS = '10';
  };
  const request = () =>
    new Request(
      'https://playground.example.com/api/call-session-voice-settings?callSessionId=call-1',
      { headers: { 'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43) } }
    );

  it.each([200, 410])('bounds a stalled HTTP%s body after headers', async (status) => {
    configure();
    const observation: { signal?: AbortSignal } = {};
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/capabilities')) return new Response('{}');
      observation.signal = init?.signal ?? undefined;
      return {
        status,
        text: () =>
          new Promise<string>((_resolve, reject) => {
            observation.signal?.addEventListener(
              'abort',
              () => {
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true }
            );
          }),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    const { GET } = await import('@/app/api/call-session-voice-settings/route');
    let settled = false;
    const pending = GET(request()).then((response) => {
      settled = true;
      return response;
    });
    await vi.advanceTimersByTimeAsync(11);
    expect(settled).toBe(true);
    const response = await pending;
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ code: 'gateway_down', retryable: true });
    expect(observation.signal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [
      200,
      JSON.stringify({ requestedVoiceRoute: { sttProvider: 'declared-provider' } }),
      { requestedVoiceRoute: { sttProvider: 'declared-provider' } },
    ],
    [200, 'plain response', { message: 'plain response' }],
    [
      410,
      JSON.stringify({ code: 'auth_expired', message: 'This call has ended.', retryable: false }),
      { code: 'auth_expired', message: 'This call has ended.', retryable: false },
    ],
  ] as const)(
    'keeps completed HTTP%s payloads and clears their deadline',
    async (status, body, expected) => {
      configure();
      const observation: { signal?: AbortSignal } = {};
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string, init?: RequestInit) => {
          if (url.endsWith('/capabilities')) return new Response('{}');
          observation.signal = init?.signal ?? undefined;
          return new Response(body, { status });
        })
      );
      const { GET } = await import('@/app/api/call-session-voice-settings/route');
      const response = await GET(request());
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toMatchObject(expected);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(11);
      expect(observation.signal?.aborted).toBe(false);
    }
  );
});
