import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  disconnectDurablyEndedCallSession,
  fetchCallConnectionDetailsForStart,
  getConnectionDetailsTokenSource,
  markCallSessionEndingForTokenSource,
} from '@/components/app/app';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('call-end token source fence', () => {
  it('reuses the existing call token when the LiveKit end path forces a final fetch', async () => {
    let nowMs = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          serverUrl: 'ws://127.0.0.1:7888',
          roomName: 'room-call-end-race',
          participantToken: 'synthetic-token',
          participantIdentity: 'synthetic-owner',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const metadata = JSON.stringify({ callSessionId: 'call-end-race' });
    const tokenSource = getConnectionDetailsTokenSource({
      agentMetadata: metadata,
      participantMetadata: metadata,
    });

    const initial = await tokenSource.fetch();
    nowMs = 5_000;
    markCallSessionEndingForTokenSource('call-end-race');
    const endFetch = await tokenSource.fetch();

    expect(endFetch).toEqual(initial);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fences token reuse and absorbs disconnect failure after a durable remote end', async () => {
    let nowMs = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          serverUrl: 'ws://127.0.0.1:7888',
          roomName: 'room-durable-end',
          participantToken: 'synthetic-token',
          participantIdentity: 'synthetic-owner',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const metadata = JSON.stringify({ callSessionId: 'call-durable-end' });
    const tokenSource = getConnectionDetailsTokenSource({
      agentMetadata: metadata,
      participantMetadata: metadata,
    });
    const initial = await tokenSource.fetch();

    await expect(
      disconnectDurablyEndedCallSession('call-durable-end', () =>
        Promise.reject(new Error('synthetic disconnect failure'))
      )
    ).resolves.toBeUndefined();
    nowMs = 5_000;
    const endFetch = await tokenSource.fetch();

    expect(endFetch).toEqual(initial);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('cached call token scope', () => {
  it('does not use another call token when the next call authority rejects admission', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            serverUrl: 'ws://livekit.example.com',
            roomName: 'room-cache-owner',
            participantToken: 'synthetic-token-owner',
            participantIdentity: 'synthetic-owner',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ code: 'auth_expired', message: 'Synthetic call authority rejected.' }),
          {
            status: 403,
            headers: { 'Content-Type': 'application/json' },
          }
        )
      );
    vi.stubGlobal('fetch', fetchMock);
    const metadata = (id: string) => ({
      agentMetadata: JSON.stringify({ callSessionId: id }),
      participantMetadata: JSON.stringify({ callSessionId: id }),
    });
    const owner = getConnectionDetailsTokenSource(metadata('call-cache-owner'));
    const existing = await owner.fetch();
    const other = getConnectionDetailsTokenSource(metadata('call-cache-other'));
    await expect(other.fetch()).rejects.toMatchObject({ code: 'auth_expired' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await owner.fetch()).toEqual(existing);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/* VIVENTIUM START: A prepared canonical dispatch is refreshed by explicit Start alone. */
it('refreshes expired preparation and explicit Retry once while passive SDK fetches reuse it', async () => {
  let now = 1_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const request = vi.fn().mockImplementation(
    async () =>
      new Response(
        JSON.stringify({
          serverUrl: 'ws://livekit.example.com',
          roomName: 'room-explicit-refresh',
          participantToken: 'synthetic-token',
          participantIdentity: 'synthetic-owner',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
  );
  vi.stubGlobal('fetch', request);
  const options = { agentMetadata: JSON.stringify({ callSessionId: 'call-explicit-refresh' }) };
  const source = getConnectionDetailsTokenSource(options);
  await source.fetch();
  await fetchCallConnectionDetailsForStart(source, options, false);
  expect(request).toHaveBeenCalledTimes(1);
  now = 5_000;
  await source.fetch();
  expect(request).toHaveBeenCalledTimes(1);
  await fetchCallConnectionDetailsForStart(source, options, false);
  await source.fetch();
  expect(request).toHaveBeenCalledTimes(2);
  now = 5_001;
  await fetchCallConnectionDetailsForStart(source, options, true);
  await source.fetch();
  expect(request).toHaveBeenCalledTimes(3);
});
/* VIVENTIUM END */
