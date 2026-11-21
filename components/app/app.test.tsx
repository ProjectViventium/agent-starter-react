import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App, deriveStartScreen } from '@/components/app/app';

const CAPABILITY = 'c'.repeat(43);

const state = vi.hoisted(() => ({
  sessionMounts: 0,
  authoritativeStatus: null as string | null,
  callStateIssue: null as { kind: string; message: string } | null,
  settingsIssue: null as { kind: string; message: string } | null,
  settingsLoading: false,
  keepAlive: [] as boolean[],
}));
const mocks = vi.hoisted(() => ({
  callState: vi.fn(),
  voiceSettings: vi.fn(),
  createTokenSource: vi.fn(),
  viewController: vi.fn(),
  callStart: vi.fn(),
  picker: vi.fn(),
  callPicker: vi.fn(),
}));

vi.mock('@livekit/components-react', () => ({
  useSession: () => {
    state.sessionMounts += 1;
    return {
      room: { on: vi.fn(), off: vi.fn() },
      isConnected: false,
      connectionState: 'disconnected',
      end: vi.fn(async () => undefined),
    };
  },
}));
vi.mock('@/components/agents-ui/agent-session-provider', () => ({
  AgentSessionProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => null }));
vi.mock('@/components/app/voice-picker', () => ({
  VoicePicker: (props: unknown) => {
    mocks.picker(props);
    return <button>Voice</button>;
  },
  CallVoicePicker: (props: unknown) => {
    mocks.callPicker(props);
    return <button>Voice</button>;
  },
}));
vi.mock('@/components/app/view-controller', () => ({
  ViewController: (props: { start: { buttonText: string }; picker: React.ReactNode }) => {
    mocks.viewController(props);
    return (
      <>
        <p>Call session: {props.start.buttonText}</p>
        {props.picker}
      </>
    );
  },
}));
vi.mock('@/hooks/useAgentErrors', () => ({ useAgentErrors: vi.fn() }));
vi.mock('@/hooks/useDebug', () => ({ useDebugMode: vi.fn() }));
vi.mock('@/hooks/useWakeLock', () => ({ useWakeLock: vi.fn() }));
vi.mock('@/hooks/useConnectionRecovery', () => ({ useConnectionRecovery: vi.fn() }));
vi.mock('@/hooks/useCallStatePublish', () => ({ useCallStatePublish: vi.fn() }));
vi.mock('@/hooks/useDeviceSoundMode', () => ({
  useDeviceSoundMode: () => ({ mode: 'standard', ready: true, notice: null, selectMode: vi.fn() }),
}));
vi.mock('@/hooks/useCallStart', () => ({
  CALL_AGENT_CONNECT_TIMEOUT_MS: 90_000,
  useCallStart: (options: unknown) => {
    mocks.callStart(options);
    return {
      startCall: vi.fn(async () => true),
      abortStart: vi.fn(),
      isStarting: false,
      isMicrophoneStarting: false,
      startError: null,
      activeSoundMode: null,
    };
  },
}));
vi.mock('@/hooks/useCallSessionState', () => ({
  useCallSessionState: (callSessionId: string | null, keepAlive: boolean) => {
    mocks.callState(callSessionId, keepAlive);
    return {
      mode: 'call',
      modePending: false,
      setMode: vi.fn(),
      authoritativeStatus: state.authoritativeStatus,
      callStateError: null,
      callStateIssue: state.callStateIssue,
      callStateRetryable: false,
      lastModeTransition: null,
      lastKeepalive: null,
    };
  },
}));
vi.mock('@/hooks/useCallSessionVoiceSettings', () => ({
  useCallSessionVoiceSettings: (callSessionId: string | null) => {
    mocks.voiceSettings(callSessionId);
    return {
      isLoading: state.settingsLoading,
      isSaving: false,
      issue: state.settingsIssue,
      error: state.settingsIssue?.message ?? null,
    };
  },
}));
vi.mock('@/lib/call-token-source', () => ({
  createCallTokenSource: (endpoint: string, options: unknown) => {
    mocks.createTokenSource(endpoint, options);
    return { tokenSource: {}, markEnding: vi.fn(), isEnding: () => false };
  },
}));

function openPage(search: string, hash = '') {
  window.history.replaceState(null, '', `/${search}${hash}`);
}

beforeEach(() => {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  state.authoritativeStatus = 'connecting';
});

afterEach(() => {
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  state.sessionMounts = 0;
  state.authoritativeStatus = null;
  state.callStateIssue = null;
  state.settingsIssue = null;
  state.settingsLoading = false;
  Object.values(mocks).forEach((mock) => mock.mockClear());
});

describe('opening the page from a call link', () => {
  it('takes the call capability out of the address and keeps it for this tab only', () => {
    openPage('?callSessionId=call-1&autoConnect=0', `#viventiumCallCapability=${CAPABILITY}`);
    render(<App isVideoInputSupported />);
    expect(window.location.hash).toBe('');
    expect(window.location.search).toBe('?callSessionId=call-1&autoConnect=0');
    expect(window.sessionStorage.getItem('viventium.call.capability.v1:call-1')).toBe(CAPABILITY);
  });

  it('reads which call and chat it was opened for and asks the token route for exactly that call', () => {
    openPage('?callSessionId=call-1&autoConnect=0&conversationId=chat-9');
    render(<App isVideoInputSupported />);
    expect(mocks.callState).toHaveBeenLastCalledWith('call-1', false);
    expect(mocks.voiceSettings).toHaveBeenLastCalledWith('call-1');
    const metadata = JSON.stringify({ callSessionId: 'call-1' });
    expect(mocks.createTokenSource).toHaveBeenLastCalledWith('/api/token', {
      agentMetadata: metadata,
      participantMetadata: metadata,
    });
  });

  it('with a manual-start link shows Start and does not create the session before it is pressed', () => {
    openPage('?callSessionId=call-1&autoConnect=0');
    render(<App isVideoInputSupported />);
    expect(screen.getByRole('button', { name: 'Start chat' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Voice' })).toBeInTheDocument();
    expect(state.sessionMounts).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    expect(state.sessionMounts).toBeGreaterThan(0);
    expect(mocks.callStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ callSessionId: 'call-1', autoStart: true, ended: false })
    );
  });

  it('with an auto-connect link goes straight to the call session', () => {
    openPage('?callSessionId=call-1&autoConnect=1');
    render(<App isVideoInputSupported />);
    expect(screen.getByText(/^Call session:/)).toBeInTheDocument();
    expect(mocks.callStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ callSessionId: 'call-1', autoStart: true })
    );
  });

  it('never starts a call the server already reports as ended, also with an auto-connect link', () => {
    state.authoritativeStatus = 'ended';
    openPage('?callSessionId=call-1&autoConnect=1');
    render(<App isVideoInputSupported />);
    expect(mocks.callStart).not.toHaveBeenCalled();
    expect(state.sessionMounts).toBe(0);
    expect(screen.getByRole('button', { name: 'Call ended' })).toBeDisabled();
  });

  it('shows an ended call as ended before Start, without a session', () => {
    state.authoritativeStatus = 'ended';
    state.settingsIssue = { kind: 'gateway_down', message: 'Settings failed.' };
    openPage('?callSessionId=call-1&autoConnect=0');
    render(<App isVideoInputSupported />);
    expect(screen.getByRole('button', { name: 'Call ended' })).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Call status: ended' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(state.sessionMounts).toBe(0);
  });

  it('says "Open from Viventium" when the page was opened without a call', () => {
    openPage('');
    render(<App isVideoInputSupported />);
    expect(screen.getByRole('button', { name: 'Open from Viventium' })).toBeDisabled();
    // No call, so no voice settings to choose from: the picker offers the sound choice only.
    expect(mocks.picker).toHaveBeenLastCalledWith(expect.objectContaining({ settings: null }));
  });

  it("puts the voice picker on the start screen and in the call, fed by this call's settings", () => {
    openPage('?callSessionId=call-1&autoConnect=0');
    render(<App isVideoInputSupported />);
    expect(mocks.picker).toHaveBeenLastCalledWith(
      expect.objectContaining({
        phase: 'before',
        settings: expect.objectContaining({ isSaving: false }),
      })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    expect(mocks.callPicker).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ended: false,
        settings: expect.objectContaining({ isSaving: false }),
      })
    );
  });

  it('refuses to start over plain http on another machine and says why', () => {
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    const hostname = vi.spyOn(window, 'location', 'get').mockReturnValue({
      ...window.location,
      hostname: '192.168.1.20',
      search: '?callSessionId=call-1&autoConnect=1',
      hash: '',
      pathname: '/',
    } as Location);
    render(<App isVideoInputSupported />);
    hostname.mockRestore();
    expect(screen.getByRole('button', { name: 'Secure setup required' })).toBeDisabled();
    expect(screen.getByText(/secure \(https\) address/)).toBeInTheDocument();
    expect(state.sessionMounts).toBe(0);
  });

  it('turns the keepalive of the call record on only from the live session', async () => {
    openPage('?callSessionId=call-1&autoConnect=1');
    await act(async () => {
      render(<App isVideoInputSupported />);
    });
    // Not connecting or connected in this test: the keepalive stays off.
    expect(mocks.callState.mock.calls.every(([, keepAlive]) => keepAlive === false)).toBe(true);
  });
});

describe('start screen states', () => {
  const idle = {
    hasCall: true,
    hasAgent: false,
    insecurePage: false,
    settings: { isLoading: false, isSaving: false, issue: null },
    callState: {
      authoritativeStatus: 'connecting' as const,
      callStateIssue: null,
      callStateError: null,
    },
  };

  it('offers Start for a call', () => {
    expect(deriveStartScreen(idle)).toMatchObject({
      canStart: true,
      buttonText: 'Start chat',
      disabled: false,
      ended: false,
    });
  });

  it('does not wait for voice settings: loading shows a hint, an error shows a notice, Start stays', () => {
    expect(
      deriveStartScreen({ ...idle, settings: { ...idle.settings, isLoading: true } })
    ).toMatchObject({
      canStart: true,
      disabled: false,
      helperText: 'Preparing your configured voice route...',
    });
    const issue = { kind: 'no_route' as const, message: 'No route.' };
    expect(deriveStartScreen({ ...idle, settings: { ...idle.settings, issue } })).toMatchObject({
      canStart: true,
      disabled: false,
      issue,
    });
  });

  it('holds Start while a voice choice is being saved', () => {
    expect(
      deriveStartScreen({ ...idle, settings: { ...idle.settings, isSaving: true } })
    ).toMatchObject({ canStart: false, disabled: true });
  });

  it('keeps an expired link distinct from an ended call', () => {
    const expired = { kind: 'auth_expired' as const, message: 'Expired.' };
    expect(
      deriveStartScreen({ ...idle, callState: { ...idle.callState, callStateIssue: expired } })
    ).toMatchObject({ canStart: false, disabled: true, ended: false, issue: expired });
    expect(deriveStartScreen({ ...idle, startError: expired })).toMatchObject({
      canStart: false,
      issue: expired,
    });
  });

  it('shows an ended call as ended, whoever ended it, with no stale problem on top', () => {
    const ended = {
      buttonText: 'Call ended',
      disabled: true,
      ended: true,
      helperText: 'Call ended. Any active work is continuing in your linked Viventium chat.',
    };
    expect(
      deriveStartScreen({
        ...idle,
        callState: {
          ...idle.callState,
          authoritativeStatus: 'ended',
          callStateIssue: { kind: 'auth_expired', message: 'Expired.' },
        },
      })
    ).toMatchObject(ended);
    const endedHere = deriveStartScreen({ ...idle, endedHere: true });
    expect(endedHere).toMatchObject(ended);
    expect(endedHere.issue).toBeUndefined();
  });

  it('says what it is doing while starting', () => {
    expect(deriveStartScreen({ ...idle, starting: true, microphoneStarting: true })).toMatchObject({
      buttonText: 'Turning on mic...',
      helperText: 'Turning on your microphone...',
      disabled: true,
    });
    expect(deriveStartScreen({ ...idle, starting: true })).toMatchObject({
      buttonText: 'Starting call...',
      helperText: 'Connecting Viventium to the room...',
      disabled: true,
    });
  });

  it('shows a start failure and lets the user try again', () => {
    const failure = { kind: 'gateway_down' as const, message: 'No worker.', retryable: true };
    expect(deriveStartScreen({ ...idle, startError: failure })).toMatchObject({
      canStart: true,
      disabled: false,
      issue: failure,
    });
  });

  it('allows an unsigned development call only when an agent is configured', () => {
    expect(deriveStartScreen({ ...idle, hasCall: false })).toMatchObject({
      canStart: false,
      buttonText: 'Open from Viventium',
    });
    expect(deriveStartScreen({ ...idle, hasCall: false, hasAgent: true })).toMatchObject({
      canStart: true,
      buttonText: 'Start chat',
    });
  });
});

describe('signed call preflight before SDK preparation', () => {
  it('does not mount the SDK while authority is pending, then autostarts once without a click', () => {
    state.authoritativeStatus = null;
    openPage('?callSessionId=call-1&autoConnect=1');
    const { rerender } = render(<App isVideoInputSupported />);
    expect(state.sessionMounts).toBe(0);
    expect(mocks.callStart).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Checking call...' })).toBeDisabled();
    state.authoritativeStatus = 'connecting';
    rerender(<App isVideoInputSupported />);
    expect(state.sessionMounts).toBeGreaterThan(0);
    expect(mocks.callStart).toHaveBeenLastCalledWith(expect.objectContaining({ autoStart: true }));
  });

  it.each(['missing', 'expired'])(
    'does not mount the SDK or start device acquisition for %s capability',
    (kind) => {
      state.authoritativeStatus = null;
      state.callStateIssue = { kind: 'auth_expired', message: `Synthetic ${kind} capability.` };
      openPage('?callSessionId=call-1&autoConnect=1');
      render(<App isVideoInputSupported />);
      expect(state.sessionMounts).toBe(0);
      expect(mocks.callStart).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Call link expired' })).toBeDisabled();
      expect(screen.queryByText('Turning on your microphone...')).not.toBeInTheDocument();
    }
  );
});
