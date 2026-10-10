/* VIVENTIUM START
 * Purpose: Prove advisory settings cannot delay canonical Start and shared terminal state
 * remains truthful before and after the native call session mounts.
 * VIVENTIUM END */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppConfig } from '@/app-config';
let App: typeof import('@/components/app/app').App;
import { CallRequestError } from '@/lib/call-start';

const state = vi.hoisted(() => ({
  settingsLoading: false,
  settingsSaving: false,
  settingsError: false,
  emptyRoute: false,
  knownEnded: false,
  stateIssue: null as { kind: 'auth_expired'; message: string } | null,
  statePending: false,
  stateProbe: vi.fn(),
  nativeSessionMounts: 0,
  authorityCode: null as 'auth_expired' | 'no_route' | null,
  start: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
  startAudio: vi.fn().mockResolvedValue(undefined),
  setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
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
  useSession: () => { state.nativeSessionMounts++; return session; },
  SessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  RoomAudioRenderer: () => null,
}));
vi.mock('@/hooks/useCallSessionVoiceSettings', () => ({
  useCallSessionVoiceSettings: () => ({
    configuredVoiceRoute: {
      stt: { provider: state.emptyRoute ? '' : 'synthetic-stt' },
      tts: { provider: state.emptyRoute ? '' : 'synthetic-tts' },
    },
    isLoading: state.settingsLoading,
    isSaving: state.settingsSaving,
    error: state.settingsError ? 'Settings read failed.' : null,
    issue: state.settingsError ? { kind: 'gateway_down', message: 'Settings read failed.' } : null,
  }),
}));
vi.mock('@/components/app/advanced-voice-settings', () => ({
  AdvancedVoiceSettings: () => <output aria-label="Advisory settings">{state.settingsLoading ? 'loading' : 'ready'}</output>,
  ConnectedAdvancedVoiceSettings: () => null,
}));
vi.mock('@/components/app/welcome-view', () => ({
  WelcomeView: ({ startButtonText, onStartCall, startDisabled, helperText, callIssue, callEnded }: {
    startButtonText: string; onStartCall: () => void; startDisabled: boolean;
    helperText?: string; callIssue?: { kind: string } | null; callEnded?: boolean;
  }) => <><button disabled={startDisabled} onClick={onStartCall}>{startButtonText}</button>
    <output aria-label="Call issue">{callEnded ? '' : callIssue?.kind}</output><output aria-label="Start hint">{helperText}</output><output aria-label="Call ended">{String(callEnded ?? false)}</output></>,
}));
vi.mock('@/components/app/view-controller', () => ({
  ViewController: ({ canStartCall, onStartCall, callIssue, callEnded }: {
    canStartCall: boolean; onStartCall: () => void; callIssue?: { kind: string } | null;
    callEnded: boolean;
  }) => <><button disabled={!canStartCall} onClick={onStartCall}>Connect</button>
    <output aria-label="Call issue">{callEnded ? '' : callIssue?.kind}</output>
    <output aria-label="Call ended">{String(callEnded)}</output></>,
}));
vi.mock('@/components/livekit/voice-audio-playback-evidence', () => ({
  VoiceAudioPlaybackEvidence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/livekit/toaster', () => ({ Toaster: () => null }));
vi.mock('@/hooks/useConnectionRecovery', () => ({ useConnectionRecovery: () => undefined }));
vi.mock('@/hooks/useWakeLock', () => ({ useWakeLock: () => undefined }));
vi.mock('@/hooks/useAgentErrors', () => ({ useAgentErrors: () => undefined }));
vi.mock('@/hooks/useDebug', () => ({ useDebugMode: () => undefined }));
let heldState: {promise: Promise<Response>; resolve: (response: Response) => void} | null = null;
const appConfig = { agentName: 'synthetic-agent', startButtonText: 'Start call' } as AppConfig;
function openCall(autoConnect = false) {
  window.history.replaceState(null, '',
    `/?callSessionId=call-advisory&roomName=room-advisory&autoConnect=${autoConnect ? '1' : '0'}`);
  return render(<App appConfig={appConfig} />);
}
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('React', React);
  window.sessionStorage.clear();
  state.settingsLoading = false;
  state.settingsSaving = false;
  state.settingsError = false;
  state.emptyRoute = false;
  state.knownEnded = false;
  state.stateIssue = null;
  state.statePending = false;
  state.stateProbe.mockReset();
  state.nativeSessionMounts = 0;
  heldState = null;
  session.isConnected = false;
  session.connectionState = 'disconnected';
  state.authorityCode = null;
  state.start.mockReset().mockResolvedValue(undefined);
  state.end.mockReset().mockResolvedValue(undefined);
  state.startAudio.mockReset().mockResolvedValue(undefined);
  state.setMicrophoneEnabled.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async (input: unknown) => {
    if (String(input).startsWith('/api/call-session-state?')) {
      if (heldState) return heldState.promise;
      return new Response(JSON.stringify({version: 1, callSessionId: 'call-advisory',
        mode: 'call', status: state.knownEnded ? 'ended' : 'created', revision: 1,
        updatedAt: '2026-08-09T12:00:00.000Z'}), {status: 200});
    }
    return new Response(JSON.stringify({serverUrl: 'ws://livekit.example.com',
      roomName: 'room-advisory', participantToken: 'synthetic-token', participantIdentity: 'synthetic-owner'}), {status: 200});
  }));
  vi.stubGlobal('navigator', { permissions: { query: vi.fn().mockResolvedValue({ state: 'granted' }) } });
  ({ App } = await import('@/components/app/app'));
});
afterEach(() => {heldState?.resolve(new Response(JSON.stringify({version: 1, callSessionId: 'call-advisory', mode: 'call', status: 'created', revision: 1, updatedAt: '2026-08-09T12:00:00.000Z'}),{status:200}));vi.unstubAllGlobals();});

const stateReads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).startsWith('/api/call-session-state?'));
const tokenReads = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url) === '/api/connection-details');
describe('App uses the original canonical state hook across setup and live phases', () => {
  it('loads one actual typed Ended state before manual Start without mounting the native session', async () => {
    state.knownEnded = true;
    state.settingsError = true;
    openCall(false);
    expect(await screen.findByRole('button', { name: 'Call ended' })).toBeDisabled();
    expect(screen.getByLabelText('Call ended')).toHaveTextContent('true');
    expect(stateReads()).toHaveLength(1);
    expect(tokenReads()).toHaveLength(0);
    expect(state.nativeSessionMounts).toBe(0);
    expect(state.start).not.toHaveBeenCalled();
    expect(state.setMicrophoneEnabled).not.toHaveBeenCalled();
  });
  it('keeps a pending presentation read in the same hook when manual Start mounts the session', async () => {
    let resolve!: (response: Response) => void;
    heldState = {promise: new Promise<Response>(next => {resolve=next;}), resolve: response=>resolve(response)};
    state.settingsLoading = true;
    openCall(false);
    await waitFor(() => expect(stateReads()).toHaveLength(1));
    const button = await screen.findByRole('button', { name: 'Start call' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(state.start).toHaveBeenCalledTimes(1));
    expect(stateReads()).toHaveLength(1);
    expect(tokenReads()).toHaveLength(1);
    expect(state.settingsLoading).toBe(true);
  });
});
