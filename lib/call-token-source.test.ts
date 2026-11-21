import { afterEach, describe, expect, it, vi } from 'vitest';
import { CALL_CAPABILITY_HEADER } from '@/lib/call-browser-capability';
import { createCallTokenSource } from '@/lib/call-token-source';

const CAPABILITY = 'c'.repeat(43);

function details(roomName: string, identity = 'synthetic-owner', token = 'synthetic-token') {
  return new Response(
    JSON.stringify({
      serverUrl: 'ws://livekit.example.test',
      roomName,
      participantToken: token,
      participantIdentity: identity,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

function callOptions(callSessionId: string) {
  const metadata = JSON.stringify({ callSessionId });
  return { agentMetadata: metadata, participantMetadata: metadata };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.sessionStorage.clear();
});

describe('call token request', () => {
  it('posts the call options to the token endpoint with the per-call capability header', async () => {
    window.sessionStorage.setItem('viventium.call.capability.v1:call-header', CAPABILITY);
    const request = vi.fn().mockImplementation(async () => details('room-header'));
    vi.stubGlobal('fetch', request);
    const source = createCallTokenSource('/api/token', callOptions('call-header'));

    await expect(source.fetchForStart(false)).resolves.toMatchObject({ roomName: 'room-header' });

    const [url, init] = request.mock.calls[0];
    expect(url).toBe('/api/token');
    expect(init.method).toBe('POST');
    expect(init.headers[CALL_CAPABILITY_HEADER]).toBe(CAPABILITY);
    expect(JSON.parse(init.body)).toEqual(callOptions('call-header'));
    expect(source.callSessionId).toBe('call-header');
  });

  it('turns a rejected request into a typed call problem', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 'auth_expired',
            message: 'Synthetic rejection.',
            retryable: false,
          }),
          { status: 401 }
        )
      )
    );
    const source = createCallTokenSource('/api/token', callOptions('call-rejected'));
    await expect(source.fetchForStart(false)).rejects.toMatchObject({
      code: 'auth_expired',
      message: 'Synthetic rejection.',
    });
  });

  it('retries once after a network failure and then reports the voice runtime as unreachable', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', request);
    const source = createCallTokenSource('/api/token', callOptions('call-offline'));
    const pending = source.fetchForStart(false);
    const outcome = expect(pending).rejects.toMatchObject({ code: 'gateway_down' });
    await vi.advanceTimersByTimeAsync(1_500);
    await outcome;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('rejects incomplete connection details', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ serverUrl: 'ws://x' }), { status: 200 }))
    );
    const source = createCallTokenSource('/api/token', callOptions('call-incomplete'));
    await expect(source.fetchForStart(false)).rejects.toMatchObject({ code: 'gateway_down' });
  });
});

describe('signed call identity', () => {
  it('rejects a reply without an owner identity', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ serverUrl: 'ws://x', roomName: 'room-a', participantToken: 't' }),
            { status: 200 }
          )
        )
    );
    const source = createCallTokenSource('/api/token', callOptions('call-no-identity'));
    await expect(source.fetchForStart(false)).rejects.toMatchObject({ code: 'auth_expired' });
  });

  it('rejects a room that differs from the one the link named', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(details('room-other')));
    const source = createCallTokenSource('/api/token', {
      ...callOptions('call-room'),
      roomName: 'room-expected',
    });
    await expect(source.fetchForStart(false)).rejects.toMatchObject({ code: 'auth_expired' });
  });

  it('rejects a changed room or identity on a later explicit Start', async () => {
    const request = vi
      .fn()
      .mockImplementationOnce(async () => details('room-pinned', 'owner-a'))
      .mockImplementationOnce(async () => details('room-pinned', 'owner-b'));
    vi.stubGlobal('fetch', request);
    const source = createCallTokenSource('/api/token', callOptions('call-pinned'));
    await source.fetchForStart(false);
    await expect(source.fetchForStart(true)).rejects.toMatchObject({
      code: 'auth_expired',
      message: 'The signed call identity changed during reconnect.',
    });
  });
});

describe('prepared token reuse', () => {
  it('does not dispatch for SDK prewarm until Start explicitly prepares after capture', async () => {
    const request = vi.fn().mockImplementation(async () => details('room-after-capture'));
    vi.stubGlobal('fetch', request);
    const source = createCallTokenSource('/api/token', callOptions('call-prewarm'));
    const prewarm = source.tokenSource.fetch();
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    const prepared = await source.fetchForStart(false);
    expect(await prewarm).toEqual(prepared);
    expect(request).toHaveBeenCalledOnce();
  });

  it('settles prewarm without dispatch if End arrives before microphone permission', async () => {
    const request = vi.fn();
    vi.stubGlobal('fetch', request);
    const source = createCallTokenSource('/api/token', callOptions('call-prewarm-ended'));
    const prewarm = source.tokenSource.fetch();
    const outcome = expect(prewarm).rejects.toMatchObject({ code: 'auth_expired' });
    source.markEnding();
    await outcome;
    expect(request).not.toHaveBeenCalled();
  });

  it('shares one in-flight request between the prewarm and Start', async () => {
    const request = vi.fn().mockImplementation(async () => details('room-shared'));
    vi.stubGlobal('fetch', request);
    const source = createCallTokenSource('/api/token', callOptions('call-shared'));
    const [first, second] = await Promise.all([
      source.tokenSource.fetch(),
      source.fetchForStart(false),
    ]);
    expect(first).toEqual(second);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('refreshes expired preparation and explicit Retry once while passive SDK fetches reuse it', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const request = vi.fn().mockImplementation(async () => details('room-explicit-refresh'));
    vi.stubGlobal('fetch', request);
    const source = createCallTokenSource('/api/token', callOptions('call-explicit-refresh'));
    await source.fetchForStart(false);
    await source.fetchForStart(false);
    expect(request).toHaveBeenCalledTimes(1);
    now = 5_000;
    await source.tokenSource.fetch();
    expect(request).toHaveBeenCalledTimes(1);
    await source.fetchForStart(false);
    await source.tokenSource.fetch();
    expect(request).toHaveBeenCalledTimes(2);
    now = 5_001;
    await source.fetchForStart(true);
    await source.tokenSource.fetch();
    expect(request).toHaveBeenCalledTimes(3);
  });

  it('does not use another call token when the next call authority rejects admission', async () => {
    const request = vi
      .fn()
      .mockImplementationOnce(async () => details('room-cache-owner'))
      .mockImplementationOnce(
        async () =>
          new Response(
            JSON.stringify({ code: 'auth_expired', message: 'Synthetic call authority rejected.' }),
            { status: 403 }
          )
      );
    vi.stubGlobal('fetch', request);
    const owner = createCallTokenSource('/api/token', callOptions('call-cache-owner'));
    const existing = await owner.fetchForStart(false);
    const other = createCallTokenSource('/api/token', callOptions('call-cache-other'));
    await expect(other.fetchForStart(false)).rejects.toMatchObject({ code: 'auth_expired' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(await owner.tokenSource.fetch()).toEqual(existing);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('asks again after a failed request', async () => {
    const request = vi
      .fn()
      .mockImplementationOnce(async () => new Response('{}', { status: 503 }))
      .mockImplementationOnce(async () => details('room-after-failure'));
    vi.stubGlobal('fetch', request);
    const source = createCallTokenSource('/api/token', callOptions('call-after-failure'));
    await expect(source.fetchForStart(false)).rejects.toMatchObject({ code: 'gateway_down' });
    await expect(source.fetchForStart(false)).resolves.toMatchObject({
      roomName: 'room-after-failure',
    });
  });
});

describe('call-end fence', () => {
  it.each(['sdk', 'retry'] as const)(
    'refuses a cold %s fetch after End without requesting a token',
    async (path) => {
      const request = vi.fn().mockImplementation(async () => details('room-must-not-start'));
      vi.stubGlobal('fetch', request);
      const source = createCallTokenSource('/api/token', callOptions('call-ended-before-token'));
      source.markEnding();

      const pending = path === 'sdk' ? source.tokenSource.fetch() : source.fetchForStart(true);
      await expect(pending).rejects.toMatchObject({ code: 'auth_expired' });
      expect(request).not.toHaveBeenCalled();
    }
  );

  it('does not retry a failed network request after End while its retry delay is pending', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', request);
    const source = createCallTokenSource('/api/token', callOptions('call-ended-during-retry'));
    const pending = source.fetchForStart(false);
    const outcome = expect(pending).rejects.toMatchObject({ code: 'auth_expired' });
    await vi.advanceTimersByTimeAsync(1);
    source.markEnding();
    await vi.advanceTimersByTimeAsync(1_500);
    await outcome;
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reuses a stale unsigned token after End rather than minting another development room', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockImplementation(async () => details('room-existing-development'));
    vi.stubGlobal('fetch', request);
    const source = createCallTokenSource('/api/token');
    const initial = await source.tokenSource.fetch();
    await vi.advanceTimersByTimeAsync(3_000);
    source.markEnding();

    expect(await source.tokenSource.fetch()).toEqual(initial);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reuses the existing call token when the LiveKit end path forces a final fetch', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const request = vi.fn().mockImplementation(async () => details('room-call-end-race'));
    vi.stubGlobal('fetch', request);
    const source = createCallTokenSource('/api/token', callOptions('call-end-race'));

    const initial = await source.fetchForStart(false);
    now = 5_000;
    source.markEnding();
    expect(source.isEnding()).toBe(true);
    expect(await source.tokenSource.fetch()).toEqual(initial);
    // Even an explicit Retry cannot replace the token of a call that is ending.
    expect(await source.fetchForStart(true)).toEqual(initial);
    expect(request).toHaveBeenCalledTimes(1);

    now = 5_000 + 30_001;
    expect(source.isEnding()).toBe(false);
  });
});
