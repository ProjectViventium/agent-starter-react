import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CallControlBar, type CallControlBarProps } from '@/components/app/call-control-bar';

const mocks = vi.hoisted(() => ({
  send: vi.fn<(message: string) => Promise<undefined>>(async () => undefined),
  sessionEnd: vi.fn(),
  inputControls: vi.fn(),
  toggleMicrophone: vi.fn(),
}));

vi.mock('@livekit/components-react', () => ({
  useChat: () => ({ send: mocks.send }),
  useSessionContext: () => ({ end: mocks.sessionEnd }),
}));
vi.mock('@/hooks/agents-ui/use-agent-control-bar', () => ({
  usePublishPermissions: () => ({ microphone: true, camera: true, screenShare: true, data: true }),
}));
vi.mock('@/hooks/useCallInputControls', () => ({
  useCallInputControls: (props: unknown) => {
    mocks.inputControls(props);
    const toggle = { enabled: true, pending: false, toggle: mocks.toggleMicrophone };
    return {
      microphoneTrack: undefined,
      microphoneToggle: toggle,
      cameraToggle: { ...toggle, enabled: false },
      screenShareToggle: { ...toggle, enabled: false },
      handleAudioDeviceChange: vi.fn(),
      handleVideoDeviceChange: vi.fn(),
      handleMicrophoneDeviceSelectError: vi.fn(),
      handleCameraDeviceSelectError: vi.fn(),
    };
  },
}));
vi.mock('@/components/agents-ui/agent-track-control', () => ({
  AgentTrackControl: ({
    'aria-label': label,
    disabled,
    pressed,
    onPressedChange,
  }: {
    'aria-label': string;
    disabled?: boolean;
    pressed?: boolean;
    onPressedChange?: (pressed: boolean) => void;
  }) => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={() => onPressedChange?.(!pressed)}
    />
  ),
}));
vi.mock('@/components/agents-ui/agent-track-toggle', () => ({
  AgentTrackToggle: ({ 'aria-label': label }: { 'aria-label': string }) => (
    <button type="button" aria-label={label} />
  ),
  agentTrackToggleVariants: () => '',
}));

function renderBar(changed: Partial<CallControlBarProps> = {}) {
  const props: CallControlBarProps = {
    callSessionId: 'call-1',
    isConnected: true,
    isAgentAvailable: true,
    isChatOpen: true,
    onIsChatOpenChange: vi.fn(),
    mode: 'call',
    modePending: false,
    onModeChange: vi.fn(),
    onDisconnect: vi.fn(),
    ...changed,
  };
  return { props, ...render(<CallControlBar {...props} />) };
}

afterEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockClear());
});

describe('CallControlBar', () => {
  it('has the mode switch, the device buttons, the transcript button and End', () => {
    renderBar();
    expect(screen.getByRole('group', { name: 'Call mode' })).toBeInTheDocument();
    for (const name of ['Toggle microphone', 'Toggle camera', 'Toggle screen share']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'Toggle transcript' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'End call' })).toBeEnabled();
  });

  it('remembers the microphone choice for this call', () => {
    renderBar({ callSessionId: 'call-7' });
    expect(mocks.inputControls).toHaveBeenLastCalledWith(
      expect.objectContaining({ callSessionId: 'call-7' })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Toggle microphone' }));
    expect(mocks.toggleMicrophone).toHaveBeenCalledWith(false);
  });

  it('locks the microphone button while the call is still starting', () => {
    renderBar({ startupPending: true });
    expect(screen.getByRole('button', { name: 'Toggle microphone' })).toBeDisabled();
  });

  it('changes the mode with one press', () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Wing' }));
    expect(props.onModeChange).toHaveBeenCalledWith('wing');
  });

  it('sends a typed message once the assistant has joined', async () => {
    renderBar();
    const input = screen.getByRole('textbox', { name: 'Message' });
    fireEvent.change(input, { target: { value: '  hello  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.send).toHaveBeenCalledWith('hello'));
  });

  it('does not accept typing before the assistant has joined', () => {
    renderBar({ isAgentAvailable: false });
    const input = screen.getByRole('textbox', { name: 'Message' });
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('placeholder', 'Waiting for Viventium...');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('has no text box in Listen-Only, but keeps the transcript button', () => {
    const { props } = renderBar({ mode: 'listen_only' });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle transcript' }));
    expect(props.onIsChatOpenChange).toHaveBeenCalledWith(false);
  });

  it('can leave out camera and screen share', () => {
    renderBar({ controls: { camera: false, screenShare: false } });
    expect(screen.queryByRole('button', { name: 'Toggle camera' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Toggle screen share' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle microphone' })).toBeInTheDocument();
  });

  it('only reports End: the call screen ends the call, so the room is not closed twice', () => {
    const { props } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'End call' }));
    expect(props.onDisconnect).toHaveBeenCalledOnce();
    expect(mocks.sessionEnd).not.toHaveBeenCalled();
  });

  it('cannot end a call that is not connected', () => {
    renderBar({ isConnected: false });
    expect(screen.getByRole('button', { name: 'End call' })).toBeDisabled();
  });
});
