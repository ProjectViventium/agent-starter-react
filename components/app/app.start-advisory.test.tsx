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
import { RoomEvent } from 'livekit-client';

const state = vi.hoisted(() => ({
  settingsLoading: false,
  settingsSaving: false,
  settingsError: false,
  emptyRoute: false,
  knownEnded: false,
  stateIssue: null as { kind: 'auth_expired'; message: string } | null,
  statePending: false,
  stateProbe: vi.fn(),
  authorityCode: null as 'auth_expired' | 'no_route' | null,
  start: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
  startAudio: vi.fn().mockResolvedValue(undefined),
  setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined),
}));
const roomListeners = new Map<string, Set<() => void>>();
const session = {
  isConnected: false,
  connectionState: 'disconnected',
  start: state.start,
  end: state.end,
  room: {
    on: (event: string, listener: () => void) => {
      if (!roomListeners.has(event)) roomListeners.set(event, new Set());
      roomListeners.get(event)!.add(listener);
    },
    off: (event: string, listener: () => void) => { roomListeners.get(event)?.delete(listener); },
    startAudio: state.startAudio,
    remoteParticipants: new Map(),
    localParticipant: { setMicrophoneEnabled: state.setMicrophoneEnabled },
  },
};
vi.mock('@livekit/components-react', () => ({
  useSession: () => session,
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
vi.mock('@/hooks/useCallSessionState', () => ({
  useCallSessionState: (callSessionId: string | null, keepAlive: boolean) => {
    state.stateProbe(callSessionId, keepAlive);
    return ({
    mode: 'call',
    authoritativeStatus: state.knownEnded ? 'ended' : state.statePending ? null : 'created',
    callStateError: null,
    callStateIssue: state.stateIssue,
    modePending: false,
    setMode: vi.fn(),
  });
  },
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
  roomListeners.clear();
  session.isConnected = false;
  session.connectionState = 'disconnected';
  state.authorityCode = null;
  state.start.mockReset().mockResolvedValue(undefined);
  state.end.mockReset().mockResolvedValue(undefined);
  state.startAudio.mockReset().mockResolvedValue(undefined);
  state.setMicrophoneEnabled.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => new Response(JSON.stringify(state.authorityCode
    ? { code: state.authorityCode, message: 'Synthetic authority denied Start.' }
    : { serverUrl: 'ws://livekit.example.com', roomName: 'room-advisory', participantToken: 'synthetic-token', participantIdentity: 'synthetic-owner' }), { status: state.authorityCode ? 409 : 200, headers: { 'Content-Type': 'application/json' } })));
  vi.stubGlobal('navigator', { permissions: { query: vi.fn().mockResolvedValue({ state: 'granted' }) } });
  ({ App } = await import('@/components/app/app'));
});
afterEach(() => vi.unstubAllGlobals());
describe('advisory settings do not gate authoritative call start', () => {
  it('accepts manual Start while the settings read is still pending', async () => {
    state.settingsLoading = true;
    state.emptyRoute = true;
    openCall();
    const button = await screen.findByRole('button', { name: 'Start call' });
    expect(button).toBeEnabled();
    expect(screen.getByLabelText('Advisory settings')).toHaveTextContent('loading');
    fireEvent.click(button);
    await waitFor(() => expect(state.start).toHaveBeenCalledTimes(1));
    expect(state.settingsLoading).toBe(true);
    expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  });
  it('auto-connects once without waiting for a delayed settings read', async () => {
    state.settingsLoading = true;
    const { rerender } = openCall(true);
    await waitFor(() => expect(state.start).toHaveBeenCalledTimes(1));
    state.settingsLoading = false;
    rerender(<App appConfig={appConfig} />);
    await act(async () => undefined);
    expect(state.start).toHaveBeenCalledTimes(1);
  });
  it('keeps the settings read error visible but permits the authoritative Start request', async () => {
    state.settingsError = true;
    openCall();
    const button = await screen.findByRole('button', { name: 'Start call' });
    expect(button).toBeEnabled();
    expect(screen.getByLabelText('Call issue')).toHaveTextContent('gateway_down');
    fireEvent.click(button);
    await waitFor(() => expect(state.start).toHaveBeenCalledTimes(1));
  });
  it.each(['auth_expired', 'no_route'] as const)(
    'surfaces authoritative %s rejection without publishing the microphone', async (kind) => {
      state.settingsLoading = true;
      state.emptyRoute = true;
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      state.authorityCode = kind;
      openCall();
      const button = await screen.findByRole('button', { name: 'Start call' });
      expect(button).toBeEnabled();
      fireEvent.click(button);
      await waitFor(() => expect(screen.getByLabelText('Call issue')).toHaveTextContent(kind));
      expect(state.start).not.toHaveBeenCalled();
      expect(state.setMicrophoneEnabled).not.toHaveBeenCalled();
      expect(state.startAudio).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledTimes(1);
    }
  );
  it('keeps manual Start disabled during a persisted settings save', async () => {
    state.settingsSaving = true;
    const { rerender } = openCall();
    const button = await screen.findByRole('button', { name: 'Open from Viventium' });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(state.start).not.toHaveBeenCalled();
    state.settingsSaving = false;
    rerender(<App appConfig={appConfig} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Start call' }));
    await waitFor(() => expect(state.start).toHaveBeenCalledTimes(1));
  });
  it('keeps auto-connect fenced until the settings save finishes', async () => {
    state.settingsSaving = true;
    const { rerender } = openCall(true);
    await act(async () => undefined);
    expect(state.start).not.toHaveBeenCalled();
    state.settingsSaving = false;
    rerender(<App appConfig={appConfig} />);
    await waitFor(() => expect(state.start).toHaveBeenCalledTimes(1));
  });
  it('does not auto-start an already authoritative Ended call', async () => {
    state.knownEnded = true;
    state.settingsLoading = true;
    openCall(true);
    await waitFor(() => expect(screen.getByLabelText('Call ended')).toHaveTextContent('true'));
    expect(state.start).not.toHaveBeenCalled();
    expect(state.end).not.toHaveBeenCalled();
  });
});

describe('shared canonical state before native session mount', () => {
  it('shows a manual ended call truthfully while advisory settings fail', async () => {
    state.knownEnded = true;
    state.settingsError = true;
    openCall(false);
    expect(await screen.findByRole('button', { name: 'Call ended' })).toBeDisabled();
    expect(screen.getByLabelText('Call ended')).toHaveTextContent('true');
    expect(screen.getByLabelText('Call issue')).toBeEmptyDOMElement();
    expect(state.start).not.toHaveBeenCalled();
    expect(state.end).not.toHaveBeenCalled();
    expect(state.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(state.startAudio).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps real auth rejection distinct from ended before manual Start', async () => {
    state.stateIssue = { kind: 'auth_expired', message: 'Signed call rejected.' };
    openCall(false);
    expect(await screen.findByRole('button', { name: 'Open from Viventium' })).toBeDisabled();
    expect(screen.getByLabelText('Call ended')).toHaveTextContent('false');
    expect(screen.getByLabelText('Call issue')).toHaveTextContent('auth_expired');
    expect(state.start).not.toHaveBeenCalled();
    expect(state.setMicrophoneEnabled).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('does not wait for pending canonical presentation or advisory settings at Start', async () => {
    state.statePending = true;
    state.settingsLoading = true;
    openCall(false);
    const button = await screen.findByRole('button', { name: 'Start call' });
    expect(button).toBeEnabled();
    fireEvent.click(button);
    await waitFor(() => expect(state.start).toHaveBeenCalledTimes(1));
    expect(state.statePending).toBe(true);
    expect(state.settingsLoading).toBe(true);
  });
  it('retains native connecting/connected keepalive and stops it after canonical End', async () => {
    session.isConnected = true;
    session.connectionState = 'connected';
    const { rerender } = openCall(true);
    await waitFor(() => expect(state.stateProbe).toHaveBeenCalledWith('call-advisory', true));
    state.knownEnded = true;
    rerender(<App appConfig={appConfig} />);
    await waitFor(() => expect(state.end).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(state.stateProbe.mock.calls.at(-1)?.[1]).toBe(false));
  });
});

/* VIVENTIUM START: Terminal room loss settles the app wait, independent of a browser prompt. */
it('releases pending microphone startup on terminal room loss and neutralizes a late grant', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let grant!: () => void;
  const pending = new Promise<void>((resolve) => { grant = resolve; });
  state.setMicrophoneEnabled.mockImplementation((enabled: boolean) => enabled ? pending : Promise.resolve());
  vi.stubGlobal('navigator', { permissions: { query: vi.fn().mockResolvedValue({ state: 'prompt' }) } });
  state.start.mockImplementation(async () => {
    session.isConnected = true;
    session.connectionState = 'connected';
  });
  const { rerender } = openCall(true);
  await waitFor(() => expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(true));
  expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
  try {
    await act(async () => {
      session.isConnected = false;
      session.connectionState = 'disconnected';
      roomListeners.get(RoomEvent.Disconnected)?.forEach((listener) => listener());
      rerender(<App appConfig={appConfig} />);
    });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Connect' })).toBeEnabled(), { timeout: 500 });
    expect(screen.getByLabelText('Call issue')).toHaveTextContent('gateway_down');
    expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(false);
    const disables = state.setMicrophoneEnabled.mock.calls.filter(([enabled]) => !enabled).length;
    await act(async () => { grant(); });
    await waitFor(() => expect(state.setMicrophoneEnabled.mock.calls.filter(([enabled]) => !enabled).length).toBeGreaterThan(disables));
    expect(state.start).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledOnce();
  } finally { await act(async () => { grant(); }); }
});
/* VIVENTIUM END */

/* VIVENTIUM START: Capture and dispatch remain owned across a late permission decision. */
it('does not let obsolete late capture cleanup mute a newer explicit Retry', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let grant!: () => void;
  let muted = true;
  let capturePending = true;
  const pending = new Promise<void>((resolve) => { grant = resolve; });
  state.setMicrophoneEnabled.mockImplementation((enabled: boolean) => {
    // Match the SDK's single pending publication: disable and a later enable wait for it.
    return (capturePending ? pending : Promise.resolve()).then(() => { muted = !enabled; });
  });
  vi.stubGlobal('navigator', { permissions: { query: vi.fn().mockResolvedValue({ state: 'prompt' }) } });
  state.start.mockImplementation(async () => {
    session.isConnected = true; session.connectionState = 'connected';
  });
  const { rerender } = openCall(true);
  await waitFor(() => expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(true));
  await act(async () => {
    session.isConnected = false; session.connectionState = 'disconnected';
    roomListeners.get(RoomEvent.Disconnected)?.forEach((listener) => listener());
    rerender(<App appConfig={appConfig} />);
  });
  const retry = screen.getByRole('button', { name: 'Connect' });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await waitFor(() => expect(state.setMicrophoneEnabled.mock.calls.filter(([enabled]) => enabled)).toHaveLength(2));
  expect(state.start).toHaveBeenCalledTimes(2);
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
  await act(async () => { capturePending = false; grant(); });
  await waitFor(() => expect(state.startAudio).toHaveBeenCalledOnce());
  expect(muted).toBe(false);
  expect(state.setMicrophoneEnabled.mock.calls.filter(([enabled]) => !enabled)).toHaveLength(1);
});

it.each([false, true])('keeps cold-start reclaim truthful when terminal=%s', async (terminal) => {
  vi.useFakeTimers();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let grant!: () => void;
  const pending = new Promise<void>((resolve) => { grant = resolve; });
  state.setMicrophoneEnabled.mockImplementation((enabled: boolean) => enabled && terminal ? pending : Promise.resolve());
  vi.stubGlobal('navigator', { permissions: { query: vi.fn().mockResolvedValue({ state: terminal ? 'prompt' : 'granted' }) } });
  state.start.mockImplementation(async () => {
    session.isConnected = true; session.connectionState = 'connected';
  });
  try {
    await act(async () => { openCall(true); });
    await act(async () => { await Promise.resolve(); });
    expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(true);
    if (terminal) {
      // The terminal event is synchronous; the connected SDK snapshot may still be stale.
      await act(async () => { roomListeners.get(RoomEvent.Disconnected)?.forEach((listener) => listener()); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(8_001); });
    const reclaims = vi.mocked(fetch).mock.calls.filter(([, options]) =>
      JSON.parse(String(options?.body ?? '{}')).reclaimDispatch === true);
    expect(reclaims).toHaveLength(terminal ? 0 : 1);
  } finally {
    await act(async () => { grant(); });
    vi.useRealTimers();
  }
});
/* VIVENTIUM END */

it('does not automatically reclaim dispatch while a browser permission prompt remains pending', async () => {
  vi.useFakeTimers();
  let grant!: () => void;
  const pending = new Promise<void>((resolve) => { grant = resolve; });
  state.setMicrophoneEnabled.mockImplementation((enabled: boolean) => enabled ? pending : Promise.resolve());
  vi.stubGlobal('navigator', { permissions: { query: vi.fn().mockResolvedValue({ state: 'prompt' }) } });
  state.start.mockImplementation(async () => {
    session.isConnected = true; session.connectionState = 'connected';
  });
  try {
    await act(async () => { openCall(true); });
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(state.start).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Connect' })).toBeDisabled();
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
    expect(state.setMicrophoneEnabled).not.toHaveBeenCalledWith(false);
  } finally {
    await act(async () => { grant(); });
    vi.useRealTimers();
  }
});

/* VIVENTIUM START: React effect replay does not terminate a fresh one-click call. */
it('auto-starts once across React Strict Mode effect replay without a terminal room event', async () => {
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  window.history.replaceState(null, '', '/?callSessionId=call-advisory&roomName=room-advisory&autoConnect=1');
  render(<React.StrictMode><App appConfig={appConfig} /></React.StrictMode>);
  await waitFor(() => expect(state.startAudio).toHaveBeenCalledOnce(), { timeout: 500 });
  expect(state.start).toHaveBeenCalledOnce();
  expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(true);
  expect(screen.getByLabelText('Call issue')).toHaveTextContent('');
  expect(errorLog).not.toHaveBeenCalled();
});
/* VIVENTIUM END */

/* VIVENTIUM START: True unmount still rejects obsolete browser capture after effect replay. */
it('cancels pending capture on real unmount and neutralizes a late browser grant', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  let grant!: () => void;
  const pending = new Promise<void>((resolve) => { grant = resolve; });
  state.setMicrophoneEnabled.mockImplementation((enabled: boolean) => enabled ? pending : Promise.resolve());
  vi.stubGlobal('navigator', { permissions: { query: vi.fn().mockResolvedValue({ state: 'prompt' }) } });
  const { unmount } = openCall(true);
  await waitFor(() => expect(state.setMicrophoneEnabled).toHaveBeenCalledWith(true));
  await act(async () => { unmount(); });
  expect(state.setMicrophoneEnabled.mock.calls.filter(([enabled]) => !enabled)).toHaveLength(1);
  await act(async () => { grant(); });
  expect(state.setMicrophoneEnabled.mock.calls.filter(([enabled]) => !enabled)).toHaveLength(2);
  expect(state.startAudio).not.toHaveBeenCalled();
  expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
});
/* VIVENTIUM END */
