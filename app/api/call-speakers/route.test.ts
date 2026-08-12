import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/call-speakers/route';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  delete process.env.VIVENTIUM_CALL_SESSION_SECRET;
});

describe('call speaker snapshot proxy', () => {
  it('forwards the atomic sequence/segment cursor pair', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ version: 1, segments: [], hasMore: false }), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await GET(
      new Request(
        'https://playground.example.com/api/call-speakers?callSessionId=call-1&beforeSequence=512&beforeSegmentId=segment-512',
        { headers: { 'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43) } }
      )
    );

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith(
      new URL(
        'https://librechat.example.com/api/viventium/voice/speaker-segments?callSessionId=call-1&beforeSequence=512&beforeSegmentId=segment-512'
      ),
      expect.any(Object)
    );
  });

  it('rejects a partial or malformed paging cursor', async () => {
    const response = await GET(
      new Request(
        'https://playground.example.com/api/call-speakers?callSessionId=call-1&beforeSequence=512',
        { headers: { 'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43) } }
      )
    );
    expect(response.status).toBe(400);
  });

  it('rejects session ID-only access without contacting LibreChat', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const response = await GET(
      new Request('https://playground.example.com/api/call-speakers?callSessionId=call-1')
    );
    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
