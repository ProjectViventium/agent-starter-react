/*
 * Smoke test of the real call screen: the real LiveKit session hooks on a real (never
 * networked) Room, the base's agents-ui parts and every Viventium component together, with
 * only the network and the browser media APIs replaced. It catches wiring mistakes that the
 * unit tests, which mock their neighbours, cannot see. It does not prove layout or sound.
 */
import { useState } from 'react';
import { ConnectionState, Room, RoomEvent } from 'livekit-client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useSession } from '@livekit/components-react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AgentSessionProvider } from '@/components/agents-ui/agent-session-provider';
import { type CallContextValue, CallProvider } from '@/components/app/call-context';
import { ViewController } from '@/components/app/view-controller';
import { CallVoicePicker } from '@/components/app/voice-picker';
import { createCallTokenSource } from '@/lib/call-token-source';

vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));

const CALL = 'call-smoke';

class FakeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

function connectionDetails() {
  const token = `eyJhbGciOiJub25lIn0.${btoa(JSON.stringify({ video: { room: 'room-smoke' } }))}.signature`;
  return new Response(
    JSON.stringify({
      serverUrl: 'ws://livekit.example.test',
      roomName: 'room-smoke',
      participantIdentity: 'owner-smoke',
      participantToken: token,
    }),
    { status: 200 }
  );
}

const call: CallContextValue = {
  callSessionId: CALL,
  conversationId: 'chat-smoke',
  mode: 'call',
  modePending: false,
  setMode: vi.fn(),
  authoritativeStatus: 'listening',
  callStateError: null,
  lastKeepalive: null,
};

const deviceSound = { mode: 'standard', ready: true, notice: null, selectMode: vi.fn() } as const;

function CallPage({ room, value }: { room: Room; value: CallContextValue }) {
  const [tokens] = useState(() =>
    createCallTokenSource('/api/token', {
      agentMetadata: JSON.stringify({ callSessionId: CALL }),
    })
  );
  const session = useSession(tokens.tokenSource, { room });
  return (
    <AgentSessionProvider session={session}>
      <CallProvider value={value}>
        <ViewController
          start={{ buttonText: 'Start chat', disabled: false, ended: false }}
          startupPending={false}
          onStartCall={() =>
            void (async () => {
              // This screen-only harness has no capture owner; authorize preparation explicitly,
              // as useCallStart does after microphone capture on the actual page.
              await tokens.fetchForStart(false);
              await session.start({ tracks: { microphone: { enabled: false } } });
            })()
          }
          onRetry={vi.fn()}
          onCallEnding={vi.fn()}
          onCallEnded={vi.fn()}
          isVideoInputSupported={false}
          picker={<CallVoicePicker settings={null} ended={false} deviceSound={deviceSound} />}
        />
      </CallProvider>
    </AgentSessionProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', FakeObserver);
  vi.stubGlobal('IntersectionObserver', FakeObserver);
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    }))
  );
  // jsdom is not a secure context and has no media devices; the device menus only need an
  // empty list.
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      enumerateDevices: async () => [],
      getUserMedia: async () => {
        throw new Error('No media in this test');
      },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  window.sessionStorage.setItem(`viventium.call.capability.v1:${CALL}`, 'c'.repeat(43));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('/api/token')) return connectionDetails();
      // Work, speech history and everything else: nothing yet.
      return new Response(JSON.stringify({ version: 1, events: [], segments: [] }), {
        status: 200,
      });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

it('goes from the start screen to the real call screen and back without a runtime error', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
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

  const view = render(<CallPage room={room} value={call} />);
  expect(screen.getByText('Chat live with Viventium')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Voice settings' })).toBeInTheDocument();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    await Promise.resolve();
  });

  // The call screen: status line, waiting line, the whole control bar.
  const controls = await screen.findByLabelText('Voice assistant controls');
  expect(screen.getByRole('status', { name: /^Call status:/ })).toHaveTextContent(/^Call · /);
  // Connected with the microphone still off (the test publishes none): the waiting line says so.
  expect(screen.getByText('Microphone is muted.')).toBeInTheDocument();
  const mode = within(controls).getByRole('group', { name: 'Call mode' });
  expect(within(mode).getByRole('button', { name: 'Call' })).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  expect(within(controls).getByRole('button', { name: 'Toggle microphone' })).toBeInTheDocument();
  expect(within(controls).queryByRole('button', { name: 'Toggle camera' })).not.toBeInTheDocument();
  expect(within(controls).getByRole('button', { name: 'End call' })).toBeEnabled();
  expect(within(controls).getByRole('button', { name: 'Voice settings' })).toBeInTheDocument();

  // Mode switch reaches the call context.
  fireEvent.click(within(mode).getByRole('button', { name: 'Wing' }));
  expect(call.setMode).toHaveBeenCalledWith('wing');

  // Transcript opens on the base's scroller, with the text box (assistant not joined yet).
  fireEvent.click(within(controls).getByRole('button', { name: 'Toggle transcript' }));
  expect(await screen.findByRole('textbox', { name: 'Message' })).toBeDisabled();
  expect(view.container.querySelector('[data-slot="message-scroller"]')).not.toBeNull();

  // Listen-Only: the text box goes, the transcript stays.
  view.rerender(<CallPage room={room} value={{ ...call, mode: 'listen_only' }} />);
  expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument();
  expect(screen.getByRole('status', { name: /^Call status:/ })).toHaveTextContent(
    /^Listen-Only · /
  );

  // The voice panel opens during the call.
  fireEvent.click(within(controls).getByRole('button', { name: 'Voice settings' }));
  expect(await screen.findByRole('dialog', { name: 'Voice' })).toBeInTheDocument();
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Voice' }), { key: 'Escape' });

  // End: the server is told, the room is left, the start screen comes back.
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'End call' }));
    await Promise.resolve();
  });
  await waitFor(() => expect(room.disconnect).toHaveBeenCalled());
  await screen.findByText('Chat live with Viventium');
  const fetchMock = vi.mocked(fetch);
  const ended = fetchMock.mock.calls.find(
    ([url, init]) =>
      String(url) === '/api/call-session-state' &&
      JSON.parse(String((init as RequestInit).body)).status === 'ended'
  );
  expect(ended).toBeDefined();
  // One token request for the whole visit: prewarm, Start, End and disconnect share it.
  expect(fetchMock.mock.calls.filter(([url]) => String(url) === '/api/token')).toHaveLength(1);

  const reactErrors = errors.mock.calls.filter(([message]) =>
    /Warning:|Cannot update|Maximum update depth|Invalid hook|not wrapped in act/.test(
      String(message)
    )
  );
  expect(reactErrors.filter(([message]) => !/not wrapped in act/.test(String(message)))).toEqual(
    []
  );
});
