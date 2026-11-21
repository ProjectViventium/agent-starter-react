import { afterEach, describe, expect, it, vi } from 'vitest';

const previousEnv = { ...process.env };
afterEach(() => {
  process.env = { ...previousEnv };
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('previous call token URL', () => {
  it('requires per-call authority before contacting Core', async () => {
    Object.assign(process.env, {
      VIVENTIUM_LIBRECHAT_ORIGIN: 'https://core.example.test',
      VIVENTIUM_CALL_SESSION_SECRET: 'synthetic-server-secret',
      LIVEKIT_URL: 'ws://localhost:7880',
      LIVEKIT_API_KEY: 'synthetic-key',
      LIVEKIT_API_SECRET: 'synthetic-secret',
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('./route');
    const response = await POST(
      new Request('https://call.example.test/api/connection-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentMetadata: JSON.stringify({ callSessionId: 'synthetic-call' }),
        }),
      })
    );
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      code: 'auth_expired',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
