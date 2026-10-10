/* VIVENTIUM START
 * Purpose: Exercise the installed LiveKit session's passive token refresh through the real
 * token source after terminal transport loss. No media or network service is started.
 * VIVENTIUM END */
import React from 'react';
import { ConnectionState, Room, RoomEvent } from 'livekit-client';
import { afterEach, expect, it, vi } from 'vitest';
import { useSession } from '@livekit/components-react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { getConnectionDetailsTokenSource } from '@/components/app/app';

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each([false, true])(
  'reuses prepared credentials through installed SDK disconnect/end with Strict Mode=%s',
  async (strictMode) => {
    vi.stubGlobal('React', React);
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const roomName = `room-sdk-terminal-${String(strictMode)}`;
    const callSessionId = `call-sdk-terminal-${String(strictMode)}`;
    const token = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ video: { room: roomName } }))}.signature`;
    const request = vi.fn().mockImplementation(
      async () =>
        new Response(
          JSON.stringify({
            serverUrl: 'ws://livekit.example.com',
            roomName,
            participantIdentity: 'owner-sdk-terminal',
            participantToken: token,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
    );
    vi.stubGlobal('fetch', request);
    const source = getConnectionDetailsTokenSource({
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
        React.useEffect(effectSetups, []);
        return useSession(source, { room });
      },
      {
        reactStrictMode: strictMode,
      }
    );
    await waitFor(() => expect(room.prepareConnection).toHaveBeenCalled());
    expect(effectSetups).toHaveBeenCalledTimes(strictMode ? 2 : 1);
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
    await act(async () => {
      await result.current.end();
    });
    expect(request).toHaveBeenCalledTimes(1);
  }
);
