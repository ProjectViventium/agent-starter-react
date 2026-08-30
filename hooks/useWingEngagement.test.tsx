import type { DataPublishOptions } from 'livekit-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseSessionReturn } from '@livekit/components-react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { POST as classifyEngagement } from '@/app/api/call-engagement/route';
import type { VoiceCallMode } from '@/hooks/useCallSessionState';
import { VIVENTIUM_VOICE_ENGAGEMENT_TOPIC, useWingEngagement } from '@/hooks/useWingEngagement';
import type { SpeakerSegmentV1 } from '@/lib/voice-events';

const browserCapability = 'A'.repeat(43);
const gatewayIdentity = 'gateway-participant';
const guestIdentity = 'guest-participant';
type BrowserFetch = (url: string, init?: RequestInit) => Promise<Response>;
type TestRemoteParticipant = { identity: string; isAgent: boolean };

function ownerSegment(overrides: Partial<SpeakerSegmentV1> = {}): SpeakerSegmentV1 {
  return {
    version: 1,
    segmentId: 'segment-owner-1',
    callSessionId: 'call-owner-1',
    turnId: 'turn-owner-1',
    sequence: 4,
    revision: 3,
    text: 'Synthetic private owner transcript that must never enter the browser request.',
    isFinal: true,
    speaker: {
      key: 'participant:owner-participant',
      label: 'You',
      source: 'hybrid',
      attribution: 'verified',
      actorTrust: 'owner_participant',
      participantIdentity: 'owner-participant',
    },
    ...overrides,
  };
}

function signedVerdict(overrides: Record<string, unknown> = {}) {
  const nowMs = Date.now();
  return {
    version: 1,
    callSessionId: 'call-owner-1',
    turnId: 'turn-owner-1',
    participantIdentity: 'owner-participant',
    segmentIds: ['segment-owner-1'],
    directlyAddressed: true,
    source: 'semantic_model',
    revision: 3,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + 30_000,
    attestation: 'B'.repeat(43),
    ...overrides,
  };
}

function createSession(
  participantIdentity = 'owner-participant',
  connected = true,
  participants: TestRemoteParticipant[] = [
    { identity: gatewayIdentity, isAgent: true },
    { identity: guestIdentity, isAgent: false },
  ]
) {
  const remoteParticipants = new Map(
    participants.map((participant) => [participant.identity, participant])
  );
  const deliveries = new Map<string, Uint8Array[]>();
  const publishData = vi.fn(async (payload: Uint8Array, options: DataPublishOptions = {}) => {
    for (const identity of remoteParticipants.keys()) {
      if (
        !options.destinationIdentities?.length ||
        options.destinationIdentities.includes(identity)
      ) {
        deliveries.set(identity, [...(deliveries.get(identity) ?? []), Uint8Array.from(payload)]);
      }
    }
  });
  return {
    session: {
      isConnected: connected,
      room: {
        remoteParticipants,
        localParticipant: {
          identity: participantIdentity,
          publishData,
        },
      },
    } as unknown as UseSessionReturn,
    publishData,
    remoteParticipants,
    deliveries,
  };
}

function mockResponse(payload: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function decodePublication(publishData: ReturnType<typeof vi.fn>, index = 0) {
  const payload = publishData.mock.calls[index]?.[0] as Uint8Array;
  return JSON.parse(new TextDecoder().decode(payload));
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.sessionStorage.setItem('viventium.call.capability.v1:call-owner-1', browserCapability);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
  delete process.env.VIVENTIUM_LIBRECHAT_ORIGIN;
  delete process.env.VIVENTIUM_CALL_SESSION_SECRET;
});

describe('useWingEngagement', () => {
  it.each([true, false])(
    'publishes the unchanged signed %s semantic verdict for the current verified owner turn',
    async (directlyAddressed) => {
      const verdict = signedVerdict({ directlyAddressed });
      const fetchMock = mockResponse(verdict);
      const { session, publishData, deliveries } = createSession();
      const segment = ownerSegment();

      renderHook(() =>
        useWingEngagement({
          session,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment: segment,
        })
      );

      await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('/api/call-engagement');
      expect(init).toMatchObject({
        method: 'POST',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-VIVENTIUM-CALL-CAPABILITY': browserCapability,
        },
      });
      expect(JSON.parse(String(init.body))).toEqual({
        version: 1,
        callSessionId: 'call-owner-1',
        turnId: 'turn-owner-1',
      });
      expect(String(init.body)).not.toContain(segment.text);
      expect(String(init.body)).not.toContain('owner-participant');
      expect(String(init.body)).not.toContain(browserCapability);
      expect(decodePublication(publishData)).toEqual(verdict);
      expect(deliveries.get(gatewayIdentity)).toHaveLength(1);
      expect(deliveries.get(guestIdentity) ?? []).toHaveLength(0);
      expect(deliveries.get('owner-participant') ?? []).toHaveLength(0);
      const [publishedBytes, publishOptions] = publishData.mock.calls[0] as [
        Uint8Array,
        DataPublishOptions,
      ];
      expect(ArrayBuffer.isView(publishedBytes)).toBe(true);
      expect(publishOptions).toEqual({
        reliable: true,
        topic: VIVENTIUM_VOICE_ENGAGEMENT_TOPIC,
        destinationIdentities: [gatewayIdentity],
      });
      expect(VIVENTIUM_VOICE_ENGAGEMENT_TOPIC).toBe('viventium.voice.engagement.v1');
    }
  );

  it.each([true, false])(
    'integrates the mounted owner hook, protected BFF, Core verdict, and reliable %s relay',
    async (directlyAddressed) => {
      process.env.VIVENTIUM_LIBRECHAT_ORIGIN = 'https://librechat.example.com';
      process.env.VIVENTIUM_CALL_SESSION_SECRET = 'synthetic-server-secret';
      const verdict = signedVerdict({ directlyAddressed });
      const fetchMock = vi.fn(async (resource: string | URL, init?: RequestInit) => {
        if (resource === '/api/call-engagement') {
          return classifyEngagement(
            new Request('https://playground.example.com/api/call-engagement', {
              method: init?.method,
              headers: init?.headers,
              body: init?.body,
            })
          );
        }
        if (
          String(resource) ===
          'https://librechat.example.com/api/viventium/voice/engagement/classify'
        ) {
          return new Response(JSON.stringify(verdict), { status: 200 });
        }
        throw new Error('Unexpected synthetic classification route');
      });
      vi.stubGlobal('fetch', fetchMock);
      const { session, publishData, deliveries } = createSession();

      renderHook(() =>
        useWingEngagement({
          session,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment: ownerSegment(),
        })
      );

      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const proxiedResponse = (await fetchMock.mock.results[0]?.value) as Response;
      expect(proxiedResponse.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
      const [, coreRequest] = fetchMock.mock.calls[1] as [URL, RequestInit];
      expect(coreRequest.headers).toEqual({
        'Content-Type': 'application/json',
        'X-VIVENTIUM-CALL-SECRET': 'synthetic-server-secret',
        'X-VIVENTIUM-CALL-SESSION': 'call-owner-1',
        'X-VIVENTIUM-CALL-CAPABILITY': browserCapability,
      });
      expect(JSON.parse(String(coreRequest.body))).toEqual({
        version: 1,
        callSessionId: 'call-owner-1',
        turnId: 'turn-owner-1',
      });
      expect(decodePublication(publishData)).toEqual(verdict);
      expect(deliveries.get(gatewayIdentity)).toHaveLength(1);
      expect(deliveries.get(guestIdentity) ?? []).toHaveLength(0);
    }
  );

  it.each([
    { label: 'no remote participants', participants: [] },
    {
      label: 'only an unauthenticated guest',
      participants: [{ identity: guestIdentity, isAgent: false }],
    },
    {
      label: 'a guest using the expected gateway identity',
      participants: [{ identity: gatewayIdentity, isAgent: false }],
    },
    {
      label: 'multiple authenticated agent participants',
      participants: [
        { identity: gatewayIdentity, isAgent: true },
        { identity: 'another-gateway-participant', isAgent: true },
      ],
    },
    {
      label: 'an authenticated agent claiming the owner identity',
      participants: [{ identity: 'owner-participant', isAgent: true }],
    },
    {
      label: 'an empty authenticated gateway identity',
      participants: [{ identity: '', isAgent: true }],
    },
    {
      label: 'an unsafe authenticated gateway identity',
      participants: [{ identity: '../another-gateway', isAgent: true }],
    },
  ])('fails closed before classification when the room has $label', async ({ participants }) => {
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData, deliveries } = createSession(
      'owner-participant',
      true,
      participants
    );

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );

    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publishData).not.toHaveBeenCalled();
    expect(deliveries.size).toBe(0);
  });

  it('rejects an authenticated gateway whose room map key does not match its identity', async () => {
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData, remoteParticipants, deliveries } = createSession();
    const gateway = remoteParticipants.get(gatewayIdentity)!;
    remoteParticipants.delete(gatewayIdentity);
    remoteParticipants.set('spoofed-room-identity', gateway);

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );

    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publishData).not.toHaveBeenCalled();
    expect(deliveries.size).toBe(0);
  });

  it.each([
    {
      label: 'the gateway disconnects',
      change: (participants: Map<string, TestRemoteParticipant>) =>
        participants.delete(gatewayIdentity),
    },
    {
      label: 'a guest replaces the gateway identity',
      change: (participants: Map<string, TestRemoteParticipant>) =>
        participants.set(gatewayIdentity, { identity: gatewayIdentity, isAgent: false }),
    },
    {
      label: 'another authenticated agent joins',
      change: (participants: Map<string, TestRemoteParticipant>) =>
        participants.set('another-gateway-participant', {
          identity: 'another-gateway-participant',
          isAgent: true,
        }),
    },
    {
      label: 'the gateway reconnects under a different identity',
      change: (participants: Map<string, TestRemoteParticipant>) => {
        participants.delete(gatewayIdentity);
        participants.set('reconnected-gateway-participant', {
          identity: 'reconnected-gateway-participant',
          isAgent: true,
        });
      },
    },
  ])('never publishes a pending signed verdict when $label', async ({ change }) => {
    let resolveRequest!: (response: Response) => void;
    const fetchMock = vi.fn<BrowserFetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { session, publishData, remoteParticipants, deliveries } = createSession();

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    change(remoteParticipants);
    await act(async () => {
      resolveRequest(new Response(JSON.stringify(signedVerdict()), { status: 200 }));
    });

    expect(publishData).not.toHaveBeenCalled();
    expect(deliveries.size).toBe(0);
  });

  it('safely delivers to the authenticated gateway after a same-identity reconnect', async () => {
    let resolveRequest!: (response: Response) => void;
    const fetchMock = vi.fn<BrowserFetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { session, publishData, remoteParticipants, deliveries } = createSession();

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    remoteParticipants.set(gatewayIdentity, { identity: gatewayIdentity, isAgent: true });
    await act(async () => {
      resolveRequest(new Response(JSON.stringify(signedVerdict()), { status: 200 }));
    });

    expect(publishData).toHaveBeenCalledOnce();
    expect(publishData.mock.calls[0]?.[1]).toMatchObject({
      destinationIdentities: [gatewayIdentity],
      reliable: true,
    });
    expect(deliveries.get(gatewayIdentity)).toHaveLength(1);
    expect(deliveries.get(guestIdentity) ?? []).toHaveLength(0);
  });

  it.each([true, false])(
    'retries a rejected publish using the unchanged signed %s verdict without reclassification',
    async (directlyAddressed) => {
      const verdict = signedVerdict({ directlyAddressed });
      const fetchMock = mockResponse(verdict);
      const { session, publishData, deliveries } = createSession();
      publishData.mockRejectedValueOnce(new Error('Synthetic transient LiveKit publish failure'));

      renderHook(() =>
        useWingEngagement({
          session,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment: ownerSegment(),
        })
      );

      await waitFor(() => expect(publishData).toHaveBeenCalledTimes(2));
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(decodePublication(publishData, 0)).toEqual(verdict);
      expect(decodePublication(publishData, 1)).toEqual(verdict);
      expect(publishData.mock.calls[1]?.[1]).toMatchObject({
        destinationIdentities: [gatewayIdentity],
        reliable: true,
      });
      expect(deliveries.get(gatewayIdentity)).toHaveLength(1);
      expect(deliveries.get(guestIdentity) ?? []).toHaveLength(0);
    }
  );

  it('redelivers the same fresh signed verdict after the authenticated gateway reconnects', async () => {
    const verdict = signedVerdict();
    const fetchMock = mockResponse(verdict);
    const { session, publishData, remoteParticipants, deliveries } = createSession();
    let rejectFirstPublication!: (reason: Error) => void;
    publishData.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstPublication = reject;
        })
    );
    const { rerender } = renderHook(
      ({ activeSession }) =>
        useWingEngagement({
          session: activeSession,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment: ownerSegment(),
        }),
      { initialProps: { activeSession: session } }
    );

    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
    const disconnectedSession = {
      ...session,
      isConnected: false,
    } as unknown as UseSessionReturn;

    await act(async () => {
      remoteParticipants.delete(gatewayIdentity);
      rerender({ activeSession: disconnectedSession });
      rejectFirstPublication(new Error('Synthetic gateway disconnected during publish'));
    });
    expect(publishData).toHaveBeenCalledOnce();

    await act(async () => {
      remoteParticipants.set(gatewayIdentity, { identity: gatewayIdentity, isAgent: true });
      rerender({ activeSession: { ...session, isConnected: true } as UseSessionReturn });
    });

    await waitFor(() => expect(publishData).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(decodePublication(publishData, 0)).toEqual(verdict);
    expect(decodePublication(publishData, 1)).toEqual(verdict);
    expect(deliveries.get(gatewayIdentity)).toHaveLength(1);
    expect(deliveries.get(guestIdentity) ?? []).toHaveLength(0);
  });

  it('waits for the rejected first publish before redelivering after an authenticated reconnect', async () => {
    const verdict = signedVerdict();
    const fetchMock = mockResponse(verdict);
    const { session, publishData, remoteParticipants, deliveries } = createSession();
    let rejectFirstPublication!: (reason: Error) => void;
    publishData.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstPublication = reject;
        })
    );
    const { rerender } = renderHook(
      ({ activeSession }) =>
        useWingEngagement({
          session: activeSession,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment: ownerSegment(),
        }),
      { initialProps: { activeSession: session } }
    );

    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
    await act(async () => {
      remoteParticipants.delete(gatewayIdentity);
      rerender({ activeSession: { ...session, isConnected: false } as UseSessionReturn });
    });
    await act(async () => {
      remoteParticipants.set(gatewayIdentity, { identity: gatewayIdentity, isAgent: true });
      rerender({ activeSession: { ...session, isConnected: true } as UseSessionReturn });
    });
    expect(publishData).toHaveBeenCalledOnce();

    await act(async () => {
      rejectFirstPublication(new Error('Synthetic pending publication was disconnected'));
    });

    await waitFor(() => expect(publishData).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(decodePublication(publishData, 1)).toEqual(verdict);
    expect(deliveries.get(gatewayIdentity)).toHaveLength(1);
    expect(deliveries.get(guestIdentity) ?? []).toHaveLength(0);
  });

  it('never repeats an acknowledged signed publication after the same gateway reconnects', async () => {
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData, deliveries } = createSession();
    const { rerender } = renderHook(
      ({ activeSession }) =>
        useWingEngagement({
          session: activeSession,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment: ownerSegment(),
        }),
      { initialProps: { activeSession: session } }
    );

    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
    await act(async () => {
      rerender({ activeSession: { ...session, isConnected: false } as UseSessionReturn });
    });
    await act(async () => {
      rerender({ activeSession: { ...session, isConnected: true } as UseSessionReturn });
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(publishData).toHaveBeenCalledOnce();
    expect(deliveries.get(gatewayIdentity)).toHaveLength(1);
    expect(deliveries.get(guestIdentity) ?? []).toHaveLength(0);
  });

  it('bounds repeated rejected publications without reclassifying the signed turn', async () => {
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData, deliveries } = createSession();
    publishData.mockRejectedValue(new Error('Synthetic persistent LiveKit publish failure'));

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );

    await waitFor(() => expect(publishData).toHaveBeenCalledTimes(3));
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(publishData).toHaveBeenCalledTimes(3);
    expect(deliveries.size).toBe(0);
  });

  it.each([
    { label: 'Listen-Only mode', mode: 'listen_only' as VoiceCallMode, pending: false },
    { label: 'normal Call mode', mode: 'call' as VoiceCallMode, pending: false },
    { label: 'a pending Wing transition', mode: 'wing' as VoiceCallMode, pending: true },
  ])('never retries a rejected signed verdict after $label', async ({ mode, pending }) => {
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData, deliveries } = createSession();
    let rejectFirstPublication!: (reason: Error) => void;
    publishData.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstPublication = reject;
        })
    );
    const { rerender } = renderHook(
      ({ activeMode, modePending }) =>
        useWingEngagement({
          session,
          callSessionId: 'call-owner-1',
          mode: activeMode,
          modePending,
          speakerSegment: ownerSegment(),
        }),
      { initialProps: { activeMode: 'wing' as VoiceCallMode, modePending: false } }
    );

    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
    await act(async () => {
      rerender({ activeMode: mode, modePending: pending });
      rejectFirstPublication(new Error('Synthetic publication lost its Wing authority'));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(publishData).toHaveBeenCalledOnce();
    expect(deliveries.size).toBe(0);
  });

  it.each([
    {
      label: 'a guest replaces the gateway',
      change: (participants: Map<string, TestRemoteParticipant>) =>
        participants.set(gatewayIdentity, { identity: gatewayIdentity, isAgent: false }),
    },
    {
      label: 'another authenticated gateway replaces the gateway',
      change: (participants: Map<string, TestRemoteParticipant>) => {
        participants.delete(gatewayIdentity);
        participants.set('another-gateway-participant', {
          identity: 'another-gateway-participant',
          isAgent: true,
        });
      },
    },
    {
      label: 'a second authenticated gateway joins',
      change: (participants: Map<string, TestRemoteParticipant>) =>
        participants.set('another-gateway-participant', {
          identity: 'another-gateway-participant',
          isAgent: true,
        }),
    },
  ])('never retries or exposes a signed verdict when $label', async ({ change }) => {
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData, remoteParticipants, deliveries } = createSession();
    let rejectFirstPublication!: (reason: Error) => void;
    publishData.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstPublication = reject;
        })
    );

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );

    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
    await act(async () => {
      change(remoteParticipants);
      rejectFirstPublication(new Error('Synthetic publication lost its authenticated gateway'));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(publishData).toHaveBeenCalledOnce();
    expect(deliveries.size).toBe(0);
  });

  it.each([
    { label: 'the signed verdict expires', elapsedMs: 30_000 },
    { label: 'the classification and gateway budget expires', elapsedMs: 9_100 },
  ])('never retries a rejected publication when $label', async ({ elapsedMs }) => {
    const verdict = signedVerdict();
    const fetchMock = mockResponse(verdict);
    const { session, publishData, deliveries } = createSession();
    let rejectFirstPublication!: (reason: Error) => void;
    publishData.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstPublication = reject;
        })
    );

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );

    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
    const now = vi.spyOn(Date, 'now').mockReturnValue(verdict.issuedAtMs + elapsedMs);
    await act(async () => {
      rejectFirstPublication(new Error('Synthetic signed publication exceeded its deadline'));
    });
    now.mockRestore();
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(publishData).toHaveBeenCalledOnce();
    expect(deliveries.size).toBe(0);
  });

  it('never retries a signed publication after its canonical owner utterance changes', async () => {
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData, deliveries } = createSession();
    let rejectFirstPublication!: (reason: Error) => void;
    publishData.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstPublication = reject;
        })
    );
    const { rerender } = renderHook(
      ({ segment }) =>
        useWingEngagement({
          session,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment: segment,
        }),
      { initialProps: { segment: ownerSegment() } }
    );

    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
    await act(async () => {
      rerender({ segment: ownerSegment({ text: 'A different synthetic owner instruction.' }) });
      rejectFirstPublication(new Error('Synthetic owner utterance changed during publication'));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(publishData).toHaveBeenCalledOnce();
    expect(deliveries.size).toBe(0);
  });

  it.each([
    {
      label: 'the verified owner identity changes',
      change: (session: UseSessionReturn, segment: SpeakerSegmentV1) => {
        const replacement = createSession('another-owner-participant');
        return { session: replacement.session, segment };
      },
    },
    {
      label: 'the exact signed room changes',
      change: (_session: UseSessionReturn, segment: SpeakerSegmentV1) => {
        const replacement = createSession();
        return { session: replacement.session, segment };
      },
    },
    {
      label: 'the final owner turn revision advances',
      change: (session: UseSessionReturn, segment: SpeakerSegmentV1) => ({
        session,
        segment: ownerSegment({ revision: segment.revision + 1 }),
      }),
    },
    {
      label: 'the exact owner turn changes',
      change: (session: UseSessionReturn) => ({
        session,
        segment: ownerSegment({ segmentId: 'segment-owner-2', turnId: 'turn-owner-2' }),
      }),
    },
    {
      label: 'the owner attribution is downgraded',
      change: (session: UseSessionReturn) => ({
        session,
        segment: ownerSegment({
          speaker: { ...ownerSegment().speaker, actorTrust: 'authenticated_participant' },
        }),
      }),
    },
  ])('never retries a stale signed publication when $label', async ({ change }) => {
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData, deliveries } = createSession();
    let rejectFirstPublication!: (reason: Error) => void;
    publishData.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstPublication = reject;
        })
    );
    const { rerender } = renderHook(
      ({ activeSession, segment }) =>
        useWingEngagement({
          session: activeSession,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment: segment,
        }),
      { initialProps: { activeSession: session, segment: ownerSegment() } }
    );

    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
    let replacementSession = session;
    await act(async () => {
      const replacement = change(session, ownerSegment());
      replacementSession = replacement.session;
      rerender({ activeSession: replacement.session, segment: replacement.segment });
      rejectFirstPublication(new Error('Synthetic signed publication lost its exact turn'));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(publishData).toHaveBeenCalledOnce();
    expect(deliveries.size).toBe(0);
    if (replacementSession !== session) {
      expect(replacementSession.room.localParticipant.publishData).not.toHaveBeenCalled();
    }
    expect(fetchMock).toHaveBeenCalled();
  });

  it('never retries a rejected signed verdict while its owner remains disconnected', async () => {
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData, remoteParticipants, deliveries } = createSession();
    let rejectFirstPublication!: (reason: Error) => void;
    publishData.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirstPublication = reject;
        })
    );
    const { rerender } = renderHook(
      ({ activeSession }) =>
        useWingEngagement({
          session: activeSession,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment: ownerSegment(),
        }),
      { initialProps: { activeSession: session } }
    );

    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
    await act(async () => {
      remoteParticipants.delete(gatewayIdentity);
      rerender({ activeSession: { ...session, isConnected: false } as UseSessionReturn });
      rejectFirstPublication(new Error('Synthetic owner remains disconnected'));
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(publishData).toHaveBeenCalledOnce();
    expect(deliveries.size).toBe(0);
  });

  it('relays the complete authoritative verdict for a multi-segment owner turn', async () => {
    const verdict = signedVerdict({
      segmentIds: ['segment-owner-1', 'segment-owner-2'],
      revision: 4,
    });
    const fetchMock = mockResponse(verdict);
    const { session, publishData } = createSession();

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );

    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).not.toHaveProperty('segmentIds');
    expect(decodePublication(publishData)).toEqual(verdict);
  });

  it('recovers after React Strict Mode cleans up and remounts the same owner turn', async () => {
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData } = createSession();

    renderHook(
      () =>
        useWingEngagement({
          session,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment: ownerSegment(),
        }),
      { reactStrictMode: true }
    );

    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(decodePublication(publishData)).toMatchObject({ directlyAddressed: true });
  });

  it.each([
    { label: 'normal Call mode', mode: 'call' as VoiceCallMode },
    { label: 'Listen-Only mode', mode: 'listen_only' as VoiceCallMode },
    { label: 'a pending mode transition', mode: 'wing' as VoiceCallMode, modePending: true },
  ])('never classifies or publishes during $label', async ({ mode, modePending }) => {
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData } = createSession();

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode,
        modePending,
        speakerSegment: ownerSegment(),
      })
    );

    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publishData).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'an unfinished segment', segment: ownerSegment({ isFinal: false }) },
    { label: 'a cross-session segment', segment: ownerSegment({ callSessionId: 'another-call' }) },
    { label: 'an ambiguous overlap', segment: ownerSegment({ overlap: true }) },
    { label: 'uncertain attribution', segment: ownerSegment({ uncertain: true }) },
    { label: 'a zero revision', segment: ownerSegment({ revision: 0 }) },
    { label: 'a negative revision', segment: ownerSegment({ revision: -1 }) },
    { label: 'an unsafe turn identity', segment: ownerSegment({ turnId: '../another-turn' }) },
    {
      label: 'an unverified participant',
      segment: ownerSegment({
        speaker: { ...ownerSegment().speaker, attribution: 'unverified' },
      }),
    },
    {
      label: 'an authenticated non-owner participant',
      segment: ownerSegment({
        speaker: { ...ownerSegment().speaker, actorTrust: 'authenticated_participant' },
      }),
    },
    {
      label: 'a shared microphone',
      segment: ownerSegment({
        speaker: { ...ownerSegment().speaker, actorTrust: 'shared_mic_unverified' },
      }),
    },
    {
      label: 'another participant identity',
      segment: ownerSegment({
        speaker: { ...ownerSegment().speaker, participantIdentity: 'another-owner' },
      }),
    },
    {
      label: 'a missing participant identity',
      segment: ownerSegment({
        speaker: { ...ownerSegment().speaker, participantIdentity: undefined },
      }),
    },
  ])('fails closed before contacting Core for $label', async ({ segment }) => {
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData } = createSession();

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: segment,
      })
    );

    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publishData).not.toHaveBeenCalled();
  });

  it('rejects a local participant that is not the verified owner', async () => {
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData } = createSession('guest-participant');

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );

    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publishData).not.toHaveBeenCalled();
  });

  it('requires a connected room and the exact-session browser capability', async () => {
    window.sessionStorage.clear();
    const fetchMock = mockResponse(signedVerdict());
    const { session, publishData } = createSession();
    const disconnected = createSession('owner-participant', false);

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );
    renderHook(() =>
      useWingEngagement({
        session: disconnected.session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );

    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    expect(publishData).not.toHaveBeenCalled();
    expect(disconnected.publishData).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing attestation', override: { attestation: undefined } },
    { label: 'a short attestation', override: { attestation: 'B'.repeat(42) } },
    { label: 'a non-base64url attestation', override: { attestation: `${'B'.repeat(42)}+` } },
    { label: 'an unknown version', override: { version: 2 } },
    { label: 'another call session', override: { callSessionId: 'another-call' } },
    { label: 'another turn', override: { turnId: 'another-turn' } },
    { label: 'another owner', override: { participantIdentity: 'another-owner' } },
    { label: 'another segment', override: { segmentIds: ['another-segment'] } },
    { label: 'missing segments', override: { segmentIds: [] } },
    {
      label: 'duplicate segments',
      override: { segmentIds: ['segment-owner-1', 'segment-owner-1'] },
    },
    { label: 'a nonboolean decision', override: { directlyAddressed: 'true' } },
    { label: 'a fabricated browser source', override: { source: 'browser' } },
    { label: 'another speaker revision', override: { revision: 4 } },
    { label: 'a zero speaker revision', override: { revision: 0 } },
    { label: 'an invalid issue timestamp', override: { issuedAtMs: 'now' } },
    { label: 'an invalid expiry timestamp', override: { expiresAtMs: 'later' } },
    {
      label: 'a far-future issue timestamp',
      override: { issuedAtMs: Date.now() + 60_000, expiresAtMs: Date.now() + 85_000 },
    },
    {
      label: 'an expired verdict',
      override: { issuedAtMs: Date.now() - 30_000, expiresAtMs: Date.now() - 1 },
    },
    {
      label: 'an expiry preceding issuance',
      override: { issuedAtMs: Date.now(), expiresAtMs: Date.now() - 1 },
    },
    {
      label: 'an excessive signed lifetime',
      override: { issuedAtMs: Date.now(), expiresAtMs: Date.now() + 30_001 },
    },
    { label: 'an unexpected transcript field', override: { text: 'Private transcript' } },
  ])('never publishes a model response containing $label', async ({ override }) => {
    const fetchMock = mockResponse(signedVerdict(override));
    const { session, publishData } = createSession();

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    await act(async () => {
      await fetchMock.mock.results[0]?.value;
    });
    expect(publishData).not.toHaveBeenCalled();
  });

  it.each([null, [], 'invalid'])(
    'rejects malformed signed-response envelopes: %o',
    async (body) => {
      const fetchMock = mockResponse(body);
      const { session, publishData } = createSession();

      renderHook(() =>
        useWingEngagement({
          session,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment: ownerSegment(),
        })
      );

      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      await act(async () => {
        await fetchMock.mock.results[0]?.value;
      });
      expect(publishData).not.toHaveBeenCalled();
    }
  );

  it('deduplicates the exact turn/revision and never replays an older revision', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(signedVerdict()), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(signedVerdict({ revision: 4 })), { status: 200 })
      );
    vi.stubGlobal('fetch', fetchMock);
    const { session, publishData } = createSession();
    const { rerender } = renderHook(
      ({ speakerSegment }) =>
        useWingEngagement({
          session,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment,
        }),
      { initialProps: { speakerSegment: ownerSegment() } }
    );

    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
    rerender({ speakerSegment: ownerSegment() });
    rerender({ speakerSegment: ownerSegment({ revision: 2 }) });
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledOnce();

    rerender({ speakerSegment: ownerSegment({ revision: 4 }) });
    await waitFor(() => expect(publishData).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(decodePublication(publishData, 1)).toMatchObject({ revision: 4 });
  });

  it('keeps one classification when another final owner segment arrives for the same turn/revision', async () => {
    let resolveRequest!: (response: Response) => void;
    const fetchMock = vi.fn<BrowserFetch>(
      () =>
        new Promise<Response>((resolve) => {
          resolveRequest = resolve;
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { session, publishData } = createSession();
    const { rerender } = renderHook(
      ({ speakerSegment }) =>
        useWingEngagement({
          session,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment,
        }),
      { initialProps: { speakerSegment: ownerSegment() } }
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    rerender({ speakerSegment: ownerSegment({ segmentId: 'segment-owner-2', sequence: 5 }) });

    expect(signal?.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();

    const verdict = signedVerdict({ segmentIds: ['segment-owner-1', 'segment-owner-2'] });
    await act(async () => {
      resolveRequest(new Response(JSON.stringify(verdict), { status: 200 }));
    });

    expect(publishData).toHaveBeenCalledOnce();
    expect(decodePublication(publishData)).toEqual(verdict);
  });

  it.each([
    { label: 'Listen-Only', mode: 'listen_only' as VoiceCallMode, modePending: false },
    { label: 'normal Call', mode: 'call' as VoiceCallMode, modePending: false },
    { label: 'a pending mode transition', mode: 'wing' as VoiceCallMode, modePending: true },
  ])(
    'aborts an in-flight verdict when authority changes to $label',
    async ({ mode, modePending }) => {
      let resolveRequest!: (response: Response) => void;
      const fetchMock = vi.fn<BrowserFetch>(
        () =>
          new Promise<Response>((resolve) => {
            resolveRequest = resolve;
          })
      );
      vi.stubGlobal('fetch', fetchMock);
      const { session, publishData } = createSession();
      const segment = ownerSegment();
      const { rerender } = renderHook(
        ({ activeMode, pending }) =>
          useWingEngagement({
            session,
            callSessionId: 'call-owner-1',
            mode: activeMode,
            modePending: pending,
            speakerSegment: segment,
          }),
        { initialProps: { activeMode: 'wing' as VoiceCallMode, pending: false } }
      );

      await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
      const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal;
      rerender({ activeMode: mode, pending: modePending });
      expect(signal?.aborted).toBe(true);

      await act(async () => {
        resolveRequest(new Response(JSON.stringify(signedVerdict()), { status: 200 }));
      });
      expect(publishData).not.toHaveBeenCalled();
    }
  );

  it('rejects a prior-mode segment when Wing becomes active and waits for a new revision', async () => {
    const fetchMock = mockResponse(signedVerdict({ revision: 4 }));
    const { session, publishData } = createSession();
    const { rerender } = renderHook(
      ({ mode, speakerSegment }) =>
        useWingEngagement({
          session,
          callSessionId: 'call-owner-1',
          mode,
          speakerSegment,
        }),
      {
        initialProps: {
          mode: 'call' as VoiceCallMode,
          speakerSegment: ownerSegment(),
        },
      }
    );

    rerender({ mode: 'wing', speakerSegment: ownerSegment() });
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();

    rerender({ mode: 'wing', speakerSegment: ownerSegment({ revision: 4 }) });
    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());
    expect(decodePublication(publishData)).toMatchObject({ revision: 4 });
  });

  it('aborts a replaced turn and publishes only the current owner turn', async () => {
    let resolvePrevious!: (response: Response) => void;
    const nextSegment = ownerSegment({ segmentId: 'segment-owner-2', turnId: 'turn-owner-2' });
    const currentVerdict = signedVerdict({
      segmentIds: ['segment-owner-2'],
      turnId: 'turn-owner-2',
    });
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            resolvePrevious = resolve;
          })
      )
      .mockResolvedValueOnce(new Response(JSON.stringify(currentVerdict), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const { session, publishData } = createSession();
    const { rerender } = renderHook(
      ({ speakerSegment }) =>
        useWingEngagement({
          session,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment,
        }),
      { initialProps: { speakerSegment: ownerSegment() } }
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const previousSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal;
    rerender({ speakerSegment: nextSegment });
    expect(previousSignal?.aborted).toBe(true);
    await waitFor(() => expect(publishData).toHaveBeenCalledOnce());

    await act(async () => {
      resolvePrevious(new Response(JSON.stringify(signedVerdict()), { status: 200 }));
    });
    expect(publishData).toHaveBeenCalledOnce();
    expect(decodePublication(publishData)).toEqual(currentVerdict);
  });

  it('aborts a hung classification within the bounded freshness window', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const { session, publishData } = createSession();

    renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_001);
    });

    expect(signal?.aborted).toBe(true);
    expect(publishData).not.toHaveBeenCalled();
  });

  it('aborts outstanding authority when the call view unmounts', async () => {
    const fetchMock = vi.fn<BrowserFetch>(() => new Promise<Response>(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    const { session, publishData } = createSession();
    const { unmount } = renderHook(() =>
      useWingEngagement({
        session,
        callSessionId: 'call-owner-1',
        mode: 'wing',
        speakerSegment: ownerSegment(),
      })
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const signal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal;
    unmount();

    expect(signal?.aborted).toBe(true);
    expect(publishData).not.toHaveBeenCalled();
  });

  it('treats Core denial and network failure as silent non-authority', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ code: 'auth_expired' }), { status: 403 })
      )
      .mockRejectedValueOnce(new Error('Synthetic connection failure'));
    vi.stubGlobal('fetch', fetchMock);
    const { session, publishData } = createSession();
    const { rerender } = renderHook(
      ({ speakerSegment }) =>
        useWingEngagement({
          session,
          callSessionId: 'call-owner-1',
          mode: 'wing',
          speakerSegment,
        }),
      { initialProps: { speakerSegment: ownerSegment() } }
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    rerender({ speakerSegment: ownerSegment({ revision: 4 }) });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(publishData).not.toHaveBeenCalled();
  });
});
