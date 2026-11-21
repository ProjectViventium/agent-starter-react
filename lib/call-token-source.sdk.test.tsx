/*
 * The installed LiveKit session against the real token source, without media or a network
 * service: `useSession` asks for a token when it mounts (prewarm), on `end()` and after an
 * unexpected disconnect. A signed call must reach the server once for all of them.
 */
import { useEffect } from 'react';
import { ConnectionState, type LocalTrack, Room, RoomEvent } from 'livekit-client';
import { afterEach, expect, it, vi } from 'vitest';
import { useSession } from '@livekit/components-react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCallStart } from '@/hooks/useCallStart';
import { createCallTokenSource } from '@/lib/call-token-source';

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'reuses the prepared token through the SDK prewarm, disconnect and end (Strict Mode=%s)',
  async (strictMode) => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const roomName = `room-sdk-terminal-${String(strictMode)}`;
    const callSessionId = `call-sdk-terminal-${String(strictMode)}`;
    const token = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ video: { room: roomName } }))}.signature`;
    const request = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            serverUrl: 'ws://livekit.example.test',
            roomName,
            participantIdentity: 'owner-sdk-terminal',
            participantToken: token,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', request);
    const source = createCallTokenSource('/api/token', {
      agentMetadata: JSON.stringify({ callSessionId }),
    });
    const room = new Room();
    vi.spyOn(room, 'prepareConnection').mockResolvedValue(undefined);
    vi.spyOn(room, 'connect').mockImplementation(async () => {
      room.state = ConnectionState.Connected;
      room.emit(RoomEvent.ConnectionStateChanged, room.state);
    });
    vi.spyOn(room, 'disconnect').mockImplementation(async () => {
      if (room.state === ConnectionState.Disconnected) return;
      room.state = ConnectionState.Disconnected;
      room.emit(RoomEvent.ConnectionStateChanged, room.state);
      room.emit(RoomEvent.Disconnected);
    });
    const effectSetups = vi.fn();
    const { result } = renderHook(
      () => {
        useEffect(effectSetups, []);
        return useSession(source.tokenSource, { room });
      },
      { reactStrictMode: strictMode }
    );
    // Native SDK prewarm waits; the call Start owner authorizes dispatch only after capture.
    await act(async () => {
      await Promise.resolve();
    });
    expect(room.prepareConnection).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect(effectSetups).toHaveBeenCalledTimes(strictMode ? 2 : 1);

    await act(async () => {
      await source.fetchForStart(false);
    });
    await waitFor(() => expect(room.prepareConnection).toHaveBeenCalled());
    let started!: Promise<void>;
    await act(async () => {
      started = result.current.start({ tracks: { microphone: { enabled: false } } });
      await Promise.resolve();
    });
    await act(async () => {
      await started;
    });
    expect(request).toHaveBeenCalledTimes(1);

    now = 5_000;
    await act(async () => {
      await room.disconnect();
    });
    source.markEnding();
    await act(async () => {
      await result.current.end();
    });
    expect(request).toHaveBeenCalledTimes(1);
  }
);

it.each(['allow', 'end', 'expiry'] as const)(
  'keeps native SDK prewarm behind permission and handles %s without an early dispatch',
  async (outcome) => {
    const steps: string[] = [];
    let resolvePermission!: (tracks: LocalTrack[]) => void;
    const permission = new Promise<LocalTrack[]>((resolve) => {
      resolvePermission = resolve;
    });
    const track = { stop: vi.fn(() => steps.push('capture disposed')) } as unknown as LocalTrack;
    const roomName = `room-sdk-capture-${outcome}`;
    const callSessionId = `call-sdk-capture-${outcome}`;
    const token = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ video: { room: roomName } }))}.signature`;
    const request = vi.fn(async () => {
      steps.push('dispatch prepared');
      return new Response(
        JSON.stringify({
          serverUrl: 'ws://livekit.example.test',
          roomName,
          participantIdentity: 'synthetic-owner',
          participantToken: token,
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal('fetch', request);
    const source = createCallTokenSource('/api/token', {
      agentMetadata: JSON.stringify({ callSessionId }),
    });
    const room = new Room();
    vi.spyOn(room, 'prepareConnection').mockResolvedValue(undefined);
    vi.spyOn(room.localParticipant, 'createTracks').mockImplementation(async () => {
      steps.push('permission requested');
      const captured = await permission;
      steps.push('permission allowed');
      return captured;
    });
    vi.spyOn(room.localParticipant, 'setMicrophoneEnabled').mockResolvedValue(undefined);
    vi.spyOn(room, 'startAudio').mockResolvedValue(undefined);
    vi.spyOn(room, 'connect').mockImplementation(async () => {
      steps.push('room connected');
      room.state = ConnectionState.Connected;
      room.emit(RoomEvent.ConnectionStateChanged, room.state);
    });
    const { result, rerender } = renderHook(
      ({ blocked }: { blocked: boolean }) => {
        const session = useSession(source.tokenSource, { room });
        return useCallStart({
          session,
          tokens: source,
          callSessionId,
          soundMode: 'standard',
          ended: blocked && outcome === 'end',
          authorityIssue:
            blocked && outcome === 'expiry'
              ? { kind: 'auth_expired', message: 'Synthetic expiry.' }
              : null,
          autoStart: true,
        });
      },
      { initialProps: { blocked: false } }
    );
    await waitFor(() => expect(room.localParticipant.createTracks).toHaveBeenCalledOnce());
    expect(request).not.toHaveBeenCalled();
    expect(room.prepareConnection).not.toHaveBeenCalled();
    expect(room.connect).not.toHaveBeenCalled();
    if (outcome === 'allow') {
      await act(async () => {
        resolvePermission([track]);
      });
      await waitFor(() => expect(result.current.isStarting).toBe(false));
      expect(result.current.startError).toBeNull();
      expect(request).toHaveBeenCalledOnce();
      expect(room.connect).toHaveBeenCalledOnce();
      expect(steps.indexOf('permission allowed')).toBeLessThan(steps.indexOf('dispatch prepared'));
      expect(steps.indexOf('dispatch prepared')).toBeLessThan(steps.indexOf('room connected'));
    } else {
      rerender({ blocked: true });
      await waitFor(() => expect(result.current.isStarting).toBe(false));
      expect(result.current.isMicrophoneStarting).toBe(false);
      expect(result.current.startError?.kind).toBe('auth_expired');
      await act(async () => {
        resolvePermission([track]);
      });
      expect(track.stop).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
      expect(room.connect).not.toHaveBeenCalled();
    }
  }
);
