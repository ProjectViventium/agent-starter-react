import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppConfig } from '@/app-config';
import { CallRequestError } from '@/lib/call-start';

let App: typeof import('@/components/app/app').App;

const state = vi.hoisted(() => ({
  enabled: false,
  settingsBlocked: false,
  settingsLoading: false,
  useSession: vi.fn(),
  prewarm: vi.fn(),
  responseStatus: 200,
  payload: {} as Record<string, unknown>,
  recover: undefined as (() => Promise<void>) | undefined,
  start: vi.fn().mockResolvedValue(undefined),
  fetchConnectionDetails: undefined as (() => Promise<unknown>) | undefined,
  roomConnect: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
  startAudio: vi.fn().mockResolvedValue(undefined),
  setMicrophoneEnabled: vi.fn(),
  toggle: vi.fn(),
  saveAudioInputEnabled: vi.fn(),
}));
const session = {
  isConnected: false,
  connectionState: 'disconnected',
  start: state.start,
  end: state.end,
  room: {
    on: vi.fn(),
    off: vi.fn(),
    startAudio: state.startAudio,
    remoteParticipants: new Map(),
    localParticipant: { setMicrophoneEnabled: state.setMicrophoneEnabled },
  },
};

vi.mock('@livekit/components-react', () => ({
  useSession: (tokenSource: { fetch: () => Promise<unknown> }) => {
    state.fetchConnectionDetails = () => tokenSource.fetch();
    state.useSession();
    React.useEffect(() => {
      state.prewarm();
    }, []);
    return session;
  },
  SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  RoomAudioRenderer: () => null,
  useRemoteParticipants: () => [],
  useLocalParticipant: () => ({ localParticipant: session.room.localParticipant }),
  useTrackToggle: () => ({ enabled: state.enabled, toggle: state.toggle }),
  usePersistentUserChoices: () => ({
    saveAudioInputEnabled: state.saveAudioInputEnabled,
    saveVideoInputEnabled: vi.fn(),
    saveAudioInputDeviceId: vi.fn(),
    saveVideoInputDeviceId: vi.fn(),
  }),
}));
vi.mock('@/components/app/view-controller', async () => {
  const { useInputControls } = await import(
    '@/components/livekit/agent-control-bar/hooks/use-input-controls'
  );
  return {
    ViewController: ({
      callSessionId,
      conversationId,
      callEnded,
      callIssue,
      canStartCall,
    }: {
      callSessionId: string | null;
      conversationId: string | null;
      callEnded: boolean;
      callIssue?: { kind: string } | null;
      canStartCall: boolean;
    }) => {
      const { microphoneToggle } = useInputControls({ callSessionId });
      return (
        <>
          <output aria-label="Call scope">{callSessionId}</output>
          <output aria-label="Linked chat">{conversationId}</output>
          <output aria-label="Call ended">{String(callEnded)}</output>
          <output aria-label="Call issue">{callEnded ? '' : callIssue?.kind}</output>
          <output aria-label="Can start">{String(canStartCall)}</output>
          <button onClick={() => void microphoneToggle.toggle(false)}>Mute</button>
          <button onClick={() => void microphoneToggle.toggle(true)}>Unmute</button>
        </>
      );
    },
  };
});
vi.mock('@/hooks/useCallSessionVoiceSettings', () => ({
  useCallSessionVoiceSettings: () => ({
    configuredVoiceRoute: {
      stt: { provider: 'synthetic-stt' },
      tts: { provider: 'synthetic-tts' },
    },
    isLoading: state.settingsLoading,
    isSaving: false,
    error: state.settingsBlocked ? 'Call capability is unavailable.' : null,
    issue: state.settingsBlocked
      ? { kind: 'auth_expired', message: 'Call capability is unavailable.' }
      : null,
  }),
}));
vi.mock('@/components/app/advanced-voice-settings', () => ({
  AdvancedVoiceSettings: () => null,
  ConnectedAdvancedVoiceSettings: () => null,
}));
vi.mock('@/components/livekit/voice-audio-playback-evidence', () => ({
  VoiceAudioPlaybackEvidence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/livekit/toaster', () => ({ Toaster: () => null }));
vi.mock('@/hooks/useConnectionRecovery', () => ({
  useConnectionRecovery: ({ start }: { start: () => Promise<void> }) => {
    state.recover = start;
  },
}));
vi.mock('@/hooks/useWakeLock', () => ({ useWakeLock: () => undefined }));
vi.mock('@/hooks/useAgentErrors', () => ({ useAgentErrors: () => undefined }));
vi.mock('@/hooks/useDebug', () => ({ useDebugMode: () => undefined }));

const appConfig = { agentName: 'synthetic-agent', startButtonText: 'Start call' } as AppConfig;
function openCall(id = 'call-current') {
  window.history.replaceState(
    null,
    '',
    `/?callSessionId=${id}&conversationId=conversation-current&roomName=room-current&autoConnect=1`
  );
  return render(<App appConfig={appConfig} />);
}
beforeEach(async () => {
  vi.resetModules();
  // Vitest uses classic JSX; Next uses the automatic React runtime.
  vi.stubGlobal('React', React);
  window.sessionStorage.clear();
  state.enabled = false;
  state.settingsBlocked = false;
  state.settingsLoading = false;
  session.isConnected = false;
  session.connectionState = 'disconnected';
  state.useSession.mockClear();
  state.prewarm.mockClear();
  state.responseStatus = 200;
  state.payload = {
    version: 1,
    callSessionId: 'call-current',
    mode: 'call',
    status: 'listening',
    revision: 0,
    updatedAt: '2026-10-05T12:00:00.000Z',
  };
  state.start.mockReset().mockImplementation(async () => {
    await state.fetchConnectionDetails?.();
    await state.roomConnect();
  });
  state.roomConnect.mockClear();
  state.end.mockClear();
  state.startAudio.mockClear();
  state.setMicrophoneEnabled.mockReset().mockImplementation(async (enabled: boolean) => {
    state.enabled = enabled;
  });
  state.toggle.mockReset().mockImplementation(async (enabled?: boolean) => {
    state.enabled = enabled ?? !state.enabled;
  });
  state.saveAudioInputEnabled.mockClear();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/connection-details') {
        const body = JSON.parse(String(options?.body ?? '{}')) as { agentMetadata?: string };
        const callSessionId = JSON.parse(body.agentMetadata ?? '{}').callSessionId as string;
        const rejected =
          state.responseStatus !== 200 ||
          state.payload.status === 'ended' ||
          state.payload.callSessionId !== callSessionId;
        return new Response(
          JSON.stringify(
            rejected
              ? { code: 'auth_expired', message: 'Synthetic canonical admission rejected.' }
              : {
                  serverUrl: 'ws://livekit.example.com',
                  roomName: 'room-current',
                  participantToken: 'synthetic-token',
                  participantIdentity: 'synthetic-owner',
                }
          ),
          {
            status: rejected ? (state.responseStatus !== 200 ? state.responseStatus : 410) : 200,
            headers: { 'Content-Type': 'application/json' },
          }
        );
      }
      return new Response(JSON.stringify(state.payload), {
        status: state.responseStatus,
        headers: { 'Content-Type': 'application/json' },
      });
    })
  );
  vi.stubGlobal('navigator', {
    permissions: { query: vi.fn().mockResolvedValue({ state: 'granted' }) },
  });
  ({ App } = await import('@/components/app/app'));
});
afterEach(() => vi.unstubAllGlobals());

describe('call microphone persistence and terminal bootstrap', () => {
  it('retains explicit mute after reload of the same call', async () => {
    const first = openCall();
    await waitFor(() => expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    await waitFor(() => expect(state.enabled).toBe(false));
    first.unmount();
    state.setMicrophoneEnabled.mockClear();
    state.start.mockClear();
    openCall();
    await waitFor(() => expect(state.startAudio).toHaveBeenCalledTimes(2));
    expect(state.start).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      tracks: { microphone: { enabled: false } },
    });
    expect(state.setMicrophoneEnabled).not.toHaveBeenCalledWith(true);
    expect(state.enabled).toBe(false);
    expect(screen.getByLabelText('Call scope')).toHaveTextContent('call-current');
    expect(screen.getByLabelText('Linked chat')).toHaveTextContent('conversation-current');
  });

  it('retains explicit mute when recovery starts the same call again', async () => {
    openCall();
    await waitFor(() => expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    await waitFor(() => expect(state.enabled).toBe(false));
    state.setMicrophoneEnabled.mockClear();
    await act(async () => {
      await state.recover?.();
    });
    expect(state.setMicrophoneEnabled).not.toHaveBeenCalledWith(true);
    expect(state.startAudio).toHaveBeenCalledTimes(2);
  });

  it('enables a fresh call despite the previous call being muted', async () => {
    const first = openCall();
    await waitFor(() => expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    await waitFor(() => expect(state.enabled).toBe(false));
    first.unmount();
    state.setMicrophoneEnabled.mockClear();
    state.payload.callSessionId = 'call-fresh';
    openCall('call-fresh');
    await waitFor(() => expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(true));
    expect(state.enabled).toBe(true);
  });

  it('preserves an explicit unmute after the same call reloads', async () => {
    const first = openCall();
    await waitFor(() => expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    await waitFor(() => expect(state.enabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Unmute' }));
    await waitFor(() => expect(state.enabled).toBe(true));
    first.unmount();
    state.setMicrophoneEnabled.mockClear();
    openCall();
    await waitFor(() => expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(true));
  });

  it('renders exact authoritative ended state on reload while settings remain closed', async () => {
    state.settingsBlocked = true;
    state.payload.status = 'ended';
    state.payload.error = { code: 'provider_failure', message: 'Stale failure', retryable: true };
    openCall();
    await waitFor(() => expect(screen.getByLabelText('Call ended')).toHaveTextContent('true'));
    expect(screen.getByLabelText('Call issue')).toHaveTextContent('');
    expect(screen.getByLabelText('Can start')).toHaveTextContent('false');
    expect(screen.getByLabelText('Call scope')).toHaveTextContent('call-current');
    expect(screen.getByLabelText('Linked chat')).toHaveTextContent('conversation-current');
    expect(state.start).not.toHaveBeenCalled();
    expect(state.roomConnect).not.toHaveBeenCalled();
    expect(state.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(state.startAudio).not.toHaveBeenCalled();
  });

  it.each(['expired', 'wrong-call'])(
    'does not invent Ended for %s authority',
    async (condition) => {
      state.settingsBlocked = true;
      if (condition === 'expired') {
        state.responseStatus = 410;
        state.payload = { code: 'auth_expired', message: 'Expired capability' };
      } else {
        state.payload.status = 'ended';
        state.payload.callSessionId = 'call-foreign';
      }
      openCall();
      await waitFor(() =>
        expect(screen.getByLabelText('Call issue')).toHaveTextContent('auth_expired')
      );
      expect(screen.getByLabelText('Call ended')).toHaveTextContent('false');
      expect(screen.getByLabelText('Can start')).toHaveTextContent('false');
      expect(state.start).not.toHaveBeenCalled();
      expect(state.roomConnect).not.toHaveBeenCalled();
      expect(state.setMicrophoneEnabled).not.toHaveBeenCalled();
      expect(state.startAudio).not.toHaveBeenCalled();
    }
  );
});

describe('authoritative End without redundant native disconnect', () => {
  it('keeps the native prewarm but never ends an already disconnected session on reload', async () => {
    state.settingsBlocked = true;
    state.payload.status = 'ended';
    openCall();
    await waitFor(() => expect(screen.getByLabelText('Call ended')).toHaveTextContent('true'));
    expect(state.useSession).toHaveBeenCalled();
    expect(state.prewarm).toHaveBeenCalledTimes(1);
    expect(state.end).not.toHaveBeenCalled();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.roomConnect).not.toHaveBeenCalled();
    expect(state.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(state.startAudio).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Linked chat')).toHaveTextContent('conversation-current');
  });

  it.each(['connected', 'connecting', 'reconnecting', 'signalReconnecting'])(
    'still disconnects a %s session once when the server has ended it',
    async (connectionState) => {
      session.connectionState = connectionState;
      session.isConnected = connectionState !== 'connecting';
      state.settingsBlocked = true;
      state.payload.status = 'ended';
      const { rerender } = openCall();
      await waitFor(() => expect(screen.getByLabelText('Call ended')).toHaveTextContent('true'));
      expect(state.end).toHaveBeenCalledTimes(1);
      rerender(<App appConfig={appConfig} />);
      expect(state.end).toHaveBeenCalledTimes(1);
      expect(state.start).not.toHaveBeenCalled();
      expect(state.roomConnect).not.toHaveBeenCalled();
      expect(state.setMicrophoneEnabled).not.toHaveBeenCalled();
      expect(state.startAudio).not.toHaveBeenCalled();
    }
  );

  it('does not auto-start known Ended after the settings become ready', async () => {
    state.settingsBlocked = true;
    state.payload.status = 'ended';
    const { rerender } = openCall();
    await waitFor(() => expect(screen.getByLabelText('Call ended')).toHaveTextContent('true'));
    state.settingsBlocked = false;
    rerender(<App appConfig={appConfig} />);
    await act(async () => undefined);
    expect(screen.getByLabelText('Call ended')).toHaveTextContent('true');
    expect(screen.getByLabelText('Can start')).toHaveTextContent('false');
    expect(state.start).not.toHaveBeenCalled();
    expect(state.roomConnect).not.toHaveBeenCalled();
    expect(state.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(state.startAudio).not.toHaveBeenCalled();
    expect(state.end).not.toHaveBeenCalled();
    expect(state.prewarm).toHaveBeenCalledTimes(1);
  });

  it('preserves fresh-call prewarm and starts once while advisory settings load', async () => {
    state.settingsLoading = true;
    const { rerender } = openCall();
    await waitFor(() => expect(state.start).toHaveBeenCalledTimes(1));
    expect(state.prewarm).toHaveBeenCalledTimes(1);
    expect(state.settingsLoading).toBe(true);
    state.settingsLoading = false;
    rerender(<App appConfig={appConfig} />);
    await act(async () => undefined);
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.prewarm).toHaveBeenCalledTimes(1);
    expect(state.end).not.toHaveBeenCalled();
    expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  });

  it('keeps a genuine authorized start failure visible', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.start.mockRejectedValueOnce(
      new CallRequestError({ kind: 'provider_failure', message: 'Synthetic provider failed.' })
    );
    openCall();
    await waitFor(() =>
      expect(screen.getByLabelText('Call issue')).toHaveTextContent('provider_failure')
    );
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(state.prewarm).toHaveBeenCalledTimes(1);
    expect(state.end).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});

describe('canonical admission before native room startup', () => {
  it('uses the same cached token for admission and the native room start without another request', async () => {
    openCall();
    await waitFor(() => expect(state.roomConnect).toHaveBeenCalledTimes(1));
    const requests = vi
      .mocked(fetch)
      .mock.calls.filter(([url]) => url === '/api/connection-details');
    expect(requests).toHaveLength(1);
    expect(state.start).toHaveBeenCalledTimes(1);
  });

  it('cannot reconnect a locally ended call using the token retained for native disconnect', async () => {
    const first = openCall();
    await waitFor(() => expect(state.roomConnect).toHaveBeenCalledTimes(1));
    const { markCallSessionEndingForTokenSource } = await import('@/components/app/app');
    expect(markCallSessionEndingForTokenSource('call-current')).toBe(true);
    first.unmount();
    state.payload.status = 'ended';
    state.start.mockClear();
    state.roomConnect.mockClear();
    state.setMicrophoneEnabled.mockClear();
    state.startAudio.mockClear();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    openCall();
    await waitFor(() => expect(screen.getByLabelText('Call ended')).toHaveTextContent('true'));
    expect(state.start).not.toHaveBeenCalled();
    expect(state.roomConnect).not.toHaveBeenCalled();
    expect(state.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(state.startAudio).not.toHaveBeenCalled();
    expect(errorLog.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
