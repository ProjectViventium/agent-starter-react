import { afterEach, describe, expect, it, vi } from 'vitest';
import {
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
});
