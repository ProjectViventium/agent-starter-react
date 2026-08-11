import { afterEach, describe, expect, it, vi } from 'vitest';

const liveKitMocks = vi.hoisted(() => ({
  createDispatch: vi.fn().mockResolvedValue({
    id: 'dispatch-ready',
    agentName: 'viventium-voice',
    state: {
      jobs: [
        {
          id: 'job-ready',
          dispatchId: 'dispatch-ready',
          state: { status: 1, workerId: 'worker-1' },
        },
      ],
    },
  }),
  listDispatch: vi.fn().mockResolvedValue([]),
  getDispatch: vi.fn().mockResolvedValue({
    id: 'dispatch-ready',
    agentName: 'viventium-voice',
    state: {
      jobs: [
        {
          id: 'job-ready',
          dispatchId: 'dispatch-ready',
          state: { status: 1, workerId: 'worker-1' },
        },
      ],
    },
  }),
  deleteDispatch: vi.fn().mockResolvedValue(undefined),
  createRoom: vi.fn().mockResolvedValue({ name: 'room-canonical' }),
  toJwt: vi.fn().mockResolvedValue('signed-token'),
  accessTokens: [] as Array<{
    roomConfig?: {
      departureTimeout?: number;
      agents?: Array<{ agentName?: string; metadata?: string }>;
    };
  }>,
}));

vi.mock('livekit-server-sdk', () => ({
  AccessToken: class {
    roomConfig?: { departureTimeout?: number };
    constructor() {
      liveKitMocks.accessTokens.push(this);
    }
    addGrant = vi.fn();
    toJwt = liveKitMocks.toJwt;
  },
  AgentDispatchClient: class {
    createDispatch = liveKitMocks.createDispatch;
    listDispatch = liveKitMocks.listDispatch;
    getDispatch = liveKitMocks.getDispatch;
    deleteDispatch = liveKitMocks.deleteDispatch;
  },
  RoomServiceClient: class {
    createRoom = liveKitMocks.createRoom;
  },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  delete process.env.VIVENTIUM_CALL_SESSION_SECRET;
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  delete process.env.LIVEKIT_URL;
  delete process.env.VIVENTIUM_ALLOW_DIRECT_AGENT_DISPATCH;
  delete process.env.VIVENTIUM_LIVEKIT_AGENT_DISPATCH_MODE;
  delete process.env.VIVENTIUM_CALL_DISPATCH_ASSIGN_TIMEOUT_MS;
  liveKitMocks.createDispatch.mockReset().mockResolvedValue({
    id: 'dispatch-ready',
    agentName: 'viventium-voice',
    state: {
      jobs: [
        {
          id: 'job-ready',
          dispatchId: 'dispatch-ready',
          state: { status: 1, workerId: 'worker-1' },
        },
      ],
    },
  });
  liveKitMocks.listDispatch.mockReset().mockResolvedValue([]);
  liveKitMocks.getDispatch.mockReset().mockResolvedValue({
    id: 'dispatch-ready',
    agentName: 'viventium-voice',
    state: {
      jobs: [
        {
          id: 'job-ready',
          dispatchId: 'dispatch-ready',
          state: { status: 1, workerId: 'worker-1' },
        },
      ],
    },
  });
  liveKitMocks.deleteDispatch.mockReset().mockResolvedValue(undefined);
  liveKitMocks.createRoom.mockReset().mockResolvedValue({ name: 'room-canonical' });
  liveKitMocks.toJwt.mockClear();
  liveKitMocks.accessTokens.length = 0;
  vi.resetModules();
});

const canonical = {
  callSessionId: 'call-1',
  roomName: 'room-canonical',
  gatewayAgentName: 'viventium-voice',
  ownerParticipantIdentity: 'owner-call-1',
  status: 'listening' as const,
  requestedVoiceRoute: {
    stt: { provider: 'assemblyai', variant: 'u3-rt-pro' },
    tts: { provider: 'cartesia', variant: 'voice-1' },
  },
};

describe('connection details call-session authority', () => {
  it('overwrites browser agent, participant, route, attributes, and room config', async () => {
    const { applyAuthoritativeCallSession } = await import('@/lib/authoritative-call-session');
    const options = {
      room_name: canonical.roomName,
      roomName: canonical.roomName,
      participant_identity: 'browser-chosen-owner',
      participantIdentity: 'browser-chosen-owner',
      participant_metadata: JSON.stringify({ unsafe: true }),
      participant_attributes: { role: 'owner' },
      room_config: { agents: [{ agentName: 'browser-agent' }] },
      agentName: 'browser-agent',
      agentMetadata: JSON.stringify({
        callSessionId: 'call-1',
        requestedVoiceRoute: {
          stt: { provider: 'openai', variant: 'whisper-1' },
          tts: { provider: 'openai', variant: 'alloy' },
        },
      }),
    };

    applyAuthoritativeCallSession(options, canonical);

    expect(options).toMatchObject({
      room_name: canonical.roomName,
      participant_identity: canonical.ownerParticipantIdentity,
      agentName: canonical.gatewayAgentName,
      participant_attributes: undefined,
      room_config: undefined,
    });
    expect(JSON.parse(String(options.agentMetadata))).toEqual({
      callSessionId: 'call-1',
      participantIdentity: canonical.ownerParticipantIdentity,
      requestedVoiceRoute: canonical.requestedVoiceRoute,
    });
  });

  it('keeps a signed call room alive for reconnect without changing its canonical identity', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    process.env.VIVENTIUM_LIVEKIT_AGENT_DISPATCH_MODE = 'room_config';
    liveKitMocks.listDispatch.mockResolvedValueOnce([
      {
        id: 'dispatch-existing-room-config',
        agentName: canonical.gatewayAgentName,
        state: {
          jobs: [
            {
              id: 'job-existing-room-config',
              dispatchId: 'dispatch-existing-room-config',
              state: { status: 1, workerId: 'worker-existing-room-config' },
            },
          ],
        },
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(canonical), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'already' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
    );
    const { POST } = await import('@/app/api/connection-details/route');

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({
          room_name: canonical.roomName,
          agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(liveKitMocks.accessTokens).toHaveLength(1);
    expect(liveKitMocks.accessTokens[0]?.roomConfig?.departureTimeout).toBeGreaterThanOrEqual(60);
    expect(liveKitMocks.accessTokens[0]?.roomConfig?.agents).toEqual([]);
    expect(liveKitMocks.createDispatch).not.toHaveBeenCalled();
  });

  it('reclaims a missing room-config worker through an explicit claimed dispatch', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    process.env.VIVENTIUM_LIVEKIT_AGENT_DISPATCH_MODE = 'room_config';
    liveKitMocks.listDispatch.mockResolvedValueOnce([]);
    liveKitMocks.createDispatch.mockResolvedValueOnce({
      id: 'dispatch-room-recovery',
      agentName: canonical.gatewayAgentName,
      state: {
        jobs: [
          {
            id: 'job-room-recovery',
            dispatchId: 'dispatch-room-recovery',
            state: { status: 1, workerId: 'worker-room-recovery' },
          },
        ],
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(canonical), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'already' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'claimed', claimId: 'claim-room-recovery' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'created' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
    );
    const { POST } = await import('@/app/api/connection-details/route');

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({
          room_name: canonical.roomName,
          agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(liveKitMocks.createDispatch).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(liveKitMocks.createDispatch.mock.calls[0]?.[2]?.metadata)).dispatchClaimId
    ).toBe('claim-room-recovery');
    expect(liveKitMocks.accessTokens[0]?.roomConfig?.agents).toEqual([]);
  });

  it('binds token room-config dispatch metadata to the one-time server claim', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    process.env.VIVENTIUM_LIVEKIT_AGENT_DISPATCH_MODE = 'token_room_config';
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(canonical), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'claimed', claimId: 'claim-room-config' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'created' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
    );
    const { POST } = await import('@/app/api/connection-details/route');

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({
          room_name: canonical.roomName,
          agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
        }),
      })
    );

    expect(response.status).toBe(200);
    const metadata = liveKitMocks.accessTokens[0]?.roomConfig?.agents?.[0]?.metadata;
    expect(JSON.parse(String(metadata))).toMatchObject({
      callSessionId: canonical.callSessionId,
      dispatchClaimId: 'claim-room-config',
    });
    expect(liveKitMocks.createDispatch).not.toHaveBeenCalled();
  });

  it('uses an explicit claimed dispatch when the reconnect watchdog reclaims room-config mode', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    process.env.VIVENTIUM_LIVEKIT_AGENT_DISPATCH_MODE = 'token_room_config';
    liveKitMocks.createDispatch.mockResolvedValueOnce({
      id: 'dispatch-watchdog',
      agentName: canonical.gatewayAgentName,
      state: {
        jobs: [
          {
            id: 'job-watchdog',
            dispatchId: 'dispatch-watchdog',
            state: { status: 1, workerId: 'worker-watchdog' },
          },
        ],
      },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(canonical), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'claimed', claimId: 'claim-watchdog' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'created' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
    );
    const { POST } = await import('@/app/api/connection-details/route');

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({
          room_name: canonical.roomName,
          agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
          reclaimDispatch: true,
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(liveKitMocks.createDispatch).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(liveKitMocks.createDispatch.mock.calls[0]?.[2]?.metadata)).dispatchClaimId
    ).toBe('claim-watchdog');
    expect(liveKitMocks.accessTokens[0]?.roomConfig?.agents).toEqual([]);
  });

  it('fails with gateway_down before token mint when no registered worker accepts dispatch', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.VIVENTIUM_CALL_DISPATCH_ASSIGN_TIMEOUT_MS = '250';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    liveKitMocks.createDispatch.mockResolvedValueOnce({
      id: 'dispatch-unassigned',
      agentName: canonical.gatewayAgentName,
      state: { jobs: [] },
    });
    liveKitMocks.getDispatch.mockResolvedValue({
      id: 'dispatch-unassigned',
      agentName: canonical.gatewayAgentName,
      state: { jobs: [] },
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(canonical), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'claimed', claimId: 'claim-unassigned' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'released' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
    );
    const { POST } = await import('@/app/api/connection-details/route');

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({
          room_name: canonical.roomName,
          agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
        }),
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: 'gateway_down',
      retryable: true,
    });
    expect(liveKitMocks.getDispatch).toHaveBeenCalled();
    expect(
      JSON.parse(String(liveKitMocks.createDispatch.mock.calls[0]?.[2]?.metadata)).dispatchClaimId
    ).toBe('claim-unassigned');
    expect(liveKitMocks.toJwt).not.toHaveBeenCalled();
  });

  it('creates the canonical room before the first dispatch without listing a room that cannot exist yet', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.VIVENTIUM_CALL_DISPATCH_ASSIGN_TIMEOUT_MS = '250';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    liveKitMocks.listDispatch.mockImplementationOnce(() => new Promise(() => undefined));
    liveKitMocks.createDispatch.mockResolvedValueOnce({
      id: 'dispatch-initial',
      agentName: canonical.gatewayAgentName,
      state: {
        jobs: [
          {
            id: 'job-initial',
            dispatchId: 'dispatch-initial',
            state: { status: 1, workerId: 'worker-initial' },
          },
        ],
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(canonical), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'claimed', claimId: 'claim-initial' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'created' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/connection-details/route');

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({
          room_name: canonical.roomName,
          agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(liveKitMocks.createRoom).toHaveBeenCalledWith({
      name: canonical.roomName,
      emptyTimeout: 60,
      departureTimeout: 60,
    });
    expect(liveKitMocks.listDispatch).not.toHaveBeenCalled();
    expect(liveKitMocks.createDispatch).toHaveBeenCalledTimes(1);
    expect(liveKitMocks.toJwt).toHaveBeenCalledTimes(1);
  });

  it('reclaims a missing confirmed dispatch with a fresh claim before replacement', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.VIVENTIUM_CALL_DISPATCH_ASSIGN_TIMEOUT_MS = '250';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    liveKitMocks.listDispatch.mockResolvedValueOnce([]);
    liveKitMocks.createDispatch.mockResolvedValueOnce({
      id: 'dispatch-replacement',
      agentName: canonical.gatewayAgentName,
      state: {
        jobs: [
          {
            id: 'job-replacement',
            dispatchId: 'dispatch-replacement',
            state: { status: 1, workerId: 'worker-replacement' },
          },
        ],
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(canonical), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'already' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'claimed', claimId: 'claim-replacement' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'created' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/connection-details/route');

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({
          room_name: canonical.roomName,
          agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(liveKitMocks.createDispatch).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(liveKitMocks.createDispatch.mock.calls[0]?.[2]?.metadata)).dispatchClaimId
    ).toBe('claim-replacement');
    expect(JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body))).toMatchObject({
      reclaimConfirmed: true,
    });
    expect(liveKitMocks.toJwt).toHaveBeenCalledTimes(1);
  });

  it('bounds a stalled LiveKit SDK call, releases its claim, and deletes a late dispatch', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.VIVENTIUM_CALL_DISPATCH_ASSIGN_TIMEOUT_MS = '250';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    let resolveLateDispatch: ((value: unknown) => void) | undefined;
    liveKitMocks.createDispatch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLateDispatch = resolve;
        })
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(canonical), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'claimed', claimId: 'claim-stalled' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: 'released' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/connection-details/route');
    const startedAt = Date.now();

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({
          room_name: canonical.roomName,
          agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
        }),
      })
    );

    expect(response.status).toBe(503);
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(liveKitMocks.toJwt).not.toHaveBeenCalled();
    resolveLateDispatch?.({
      id: 'dispatch-late',
      agentName: canonical.gatewayAgentName,
      state: { jobs: [] },
    });
    await vi.waitFor(() => {
      expect(liveKitMocks.deleteDispatch).toHaveBeenCalledWith('dispatch-late', canonical.roomName);
    });
    expect(
      JSON.parse(String(liveKitMocks.createDispatch.mock.calls[0]?.[2]?.metadata)).dispatchClaimId
    ).toBe('claim-stalled');
  });

  it('mints the owner token once LiveKit assigns a pending room job to the exact worker', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.VIVENTIUM_CALL_DISPATCH_ASSIGN_TIMEOUT_MS = '250';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    const assignedDispatch = {
      id: 'dispatch-assigned',
      agentName: canonical.gatewayAgentName,
      state: {
        jobs: [
          {
            id: 'job-assigned',
            dispatchId: 'dispatch-assigned',
            state: { status: 0, workerId: 'worker-assigned' },
          },
        ],
      },
    };
    liveKitMocks.createDispatch.mockResolvedValue(assignedDispatch);
    liveKitMocks.getDispatch.mockResolvedValue(assignedDispatch);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(canonical), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'claimed', claimId: 'claim-assigned' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'created' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
    );
    const { POST } = await import('@/app/api/connection-details/route');

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({
          room_name: canonical.roomName,
          agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(liveKitMocks.toJwt).toHaveBeenCalledTimes(1);
  });

  it('rejects a dispatch whose only LiveKit job is already terminal', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.VIVENTIUM_CALL_DISPATCH_ASSIGN_TIMEOUT_MS = '250';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    const failedDispatch = {
      id: 'dispatch-failed',
      agentName: canonical.gatewayAgentName,
      state: {
        jobs: [
          {
            id: 'job-failed',
            dispatchId: 'dispatch-failed',
            state: { status: 3, workerId: 'worker-failed' },
          },
        ],
      },
    };
    liveKitMocks.createDispatch.mockResolvedValue(failedDispatch);
    liveKitMocks.getDispatch.mockResolvedValue(failedDispatch);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(canonical), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'claimed', claimId: 'claim-failed' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'released' }), { status: 200 })
        )
    );
    const { POST } = await import('@/app/api/connection-details/route');

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({
          room_name: canonical.roomName,
          agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
        }),
      })
    );

    expect(response.status).toBe(503);
    expect(liveKitMocks.toJwt).not.toHaveBeenCalled();
  });

  it('waits for an in-flight claim to become confirmed before minting a token', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.VIVENTIUM_CALL_DISPATCH_ASSIGN_TIMEOUT_MS = '500';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    liveKitMocks.listDispatch.mockResolvedValue([
      {
        id: 'dispatch-ready',
        agentName: canonical.gatewayAgentName,
        state: {
          jobs: [
            {
              id: 'job-ready',
              dispatchId: 'dispatch-ready',
              state: { status: 1, workerId: 'worker-ready' },
            },
          ],
        },
      },
    ]);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify(canonical), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: 'in_flight' }), { status: 200 })
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'already' }), { status: 200 }))
    );
    const { POST } = await import('@/app/api/connection-details/route');

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({
          room_name: canonical.roomName,
          agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
        }),
      })
    );

    expect(response.status).toBe(200);
    expect(liveKitMocks.toJwt).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an in-flight claim never reaches confirmation', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.VIVENTIUM_CALL_DISPATCH_ASSIGN_TIMEOUT_MS = '250';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(canonical), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
      .mockResolvedValue(
        new Response(JSON.stringify({ status: 'in_flight' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/connection-details/route');

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({
          room_name: canonical.roomName,
          agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
        }),
      })
    );

    expect(response.status).toBe(503);
    expect(liveKitMocks.toJwt).not.toHaveBeenCalled();
  });

  it('rejects browser room mismatch and fetches canonical state with server credentials', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(canonical), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { applyAuthoritativeCallSession, fetchAuthoritativeCallSession } = await import(
      '@/lib/authoritative-call-session'
    );
    const state = await fetchAuthoritativeCallSession('call-1', 'A'.repeat(43));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://librechat.example.com/api/viventium/calls/call-1/state',
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-VIVENTIUM-CALL-SECRET': 'server-secret',
          'X-VIVENTIUM-CALL-SESSION': 'call-1',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        }),
      })
    );
    expect(() =>
      applyAuthoritativeCallSession(
        {
          room_name: 'attacker-room',
          participant_identity: 'attacker',
        },
        state
      )
    ).toThrow(/room/i);
  });

  it('rejects call-session states outside the frozen status contract', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...canonical, status: 'active' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
    const { fetchAuthoritativeCallSession } = await import('@/lib/authoritative-call-session');

    await expect(fetchAuthoritativeCallSession('call-1', 'A'.repeat(43))).rejects.toMatchObject({
      code: 'gateway_down',
      status: 502,
      retryable: true,
    });
  });

  it('rejects an ended authoritative session before dispatch or token creation', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...canonical, status: 'ended' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/connection-details/route');

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({
          room_name: canonical.roomName,
          agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
        }),
      })
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      code: 'auth_expired',
      message: 'This call has ended. Start a fresh call from Viventium.',
      retryable: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(liveKitMocks.createDispatch).not.toHaveBeenCalled();
    expect(liveKitMocks.toJwt).not.toHaveBeenCalled();
  });

  it('fails closed before canonical state or token mint for ID-only and forged capabilities', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/connection-details/route');
    const body = JSON.stringify({
      agentMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
    });

    const missing = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    );
    const malformed = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'forged',
        },
        body,
      })
    );

    expect(missing.status).toBe(401);
    expect(malformed.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(liveKitMocks.toJwt).not.toHaveBeenCalled();
  });

  it('does not mint a token for a derived call room without structured session authority', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/connection-details/route');
    const derivedRoom = `lc-${canonical.callSessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': 'A'.repeat(43),
        },
        body: JSON.stringify({ room_name: derivedRoom }),
      })
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(liveKitMocks.toJwt).not.toHaveBeenCalled();
  });

  it('treats participant metadata as call-session authority and still requires its capability', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { POST } = await import('@/app/api/connection-details/route');

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantMetadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
        }),
      })
    );

    expect(response.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(liveKitMocks.toJwt).not.toHaveBeenCalled();
  });

  it('isolates explicitly enabled unsigned development tokens from signed rooms and dispatch metadata', async () => {
    process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
    process.env.VIVENTIUM_CALL_SESSION_SECRET = 'server-secret';
    process.env.VIVENTIUM_ALLOW_DIRECT_AGENT_DISPATCH = 'true';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    const { POST } = await import('@/app/api/connection-details/route');
    const derivedRoom = `lc-${canonical.callSessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;

    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          room_name: derivedRoom,
          participant_identity: 'attacker',
          room_config: {
            agents: [
              {
                agent_name: canonical.gatewayAgentName,
                metadata: JSON.stringify({ callSessionId: canonical.callSessionId }),
              },
            ],
          },
        }),
      })
    );

    expect(response.status).toBe(401);
    expect(liveKitMocks.createDispatch).not.toHaveBeenCalled();
    expect(liveKitMocks.toJwt).not.toHaveBeenCalled();
  });

  it.each([
    ['origin only', { VIVENTIUM_LIBRECHAT_ORIGIN: 'https://librechat.example.com' }],
    ['secret only', { VIVENTIUM_CALL_SESSION_SECRET: 'server-secret' }],
  ])('fails closed with partial signed-call configuration: %s', async (_label, env) => {
    Object.assign(process.env, env, {
      LIVEKIT_API_KEY: 'test-key',
      LIVEKIT_API_SECRET: 'test-secret',
      LIVEKIT_URL: 'ws://livekit.example.com',
    });
    const { POST } = await import('@/app/api/connection-details/route');
    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'gateway_down' });
    expect(liveKitMocks.createDispatch).not.toHaveBeenCalled();
    expect(liveKitMocks.toJwt).not.toHaveBeenCalled();
  });

  it('requires explicit direct-development opt-in when signed-call auth is absent', async () => {
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    const { POST } = await import('@/app/api/connection-details/route');
    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'gateway_down' });
    expect(liveKitMocks.toJwt).not.toHaveBeenCalled();
  });

  it('never restores a referrer-selected agent in unsigned direct-development mode', async () => {
    process.env.VIVENTIUM_ALLOW_DIRECT_AGENT_DISPATCH = 'true';
    process.env.LIVEKIT_API_KEY = 'test-key';
    process.env.LIVEKIT_API_SECRET = 'test-secret';
    process.env.LIVEKIT_URL = 'ws://livekit.example.com';
    const { POST } = await import('@/app/api/connection-details/route');
    const response = await POST(
      new Request('https://playground.example.com/api/connection-details', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Referer: 'https://playground.example.com/?agentName=viventium-voice',
        },
        body: JSON.stringify({ agentName: 'viventium-voice' }),
      })
    );

    expect(response.status).toBe(200);
    expect(liveKitMocks.createDispatch).not.toHaveBeenCalled();
    expect(liveKitMocks.toJwt).toHaveBeenCalledTimes(1);
  });
});
