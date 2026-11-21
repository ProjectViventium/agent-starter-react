import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { type CallContextValue, CallProvider } from '@/components/app/call-context';
import { SessionView, deriveCallStatus, waitingLine } from '@/components/app/session-view';
import type { SpeakerSegmentV1, VoiceTaskView } from '@/lib/voice-events';

const state = vi.hoisted(() => ({
  agentState: 'listening',
  agentAvailable: false,
  canPlayAudio: true,
  microphoneIssue: null as string | null,
  latestSpeakerSegment: null as unknown,
  tasks: [] as unknown[],
  recoveryIssue: null as unknown,
  order: [] as string[],
}));
const mocks = vi.hoisted(() => ({
  wing: vi.fn(),
  sessionEnd: vi.fn(async () => undefined),
  stopRecovery: vi.fn(),
  retryRecovery: vi.fn(),
  resultBridge: vi.fn<(options: unknown) => () => unknown>(() => vi.fn()),
  startAudio: vi.fn(),
  voiceEvents: vi.fn(),
}));

vi.mock('@livekit/components-react', () => ({
  useSessionContext: () => ({ isConnected: true, end: mocks.sessionEnd, room: {} }),
  useAgent: () => ({
    state: state.agentState,
    internal: { agentParticipant: { identity: 'agent-1' }, workerParticipant: null },
  }),
  useSessionMessages: () => ({ messages: [] }),
  useRemoteParticipants: () => (state.agentAvailable ? [{ isAgent: true }] : []),
  useEnsureRoom: () => ({}),
  useStartAudio: () => ({
    canPlayAudio: state.canPlayAudio,
    mergedProps: { onClick: mocks.startAudio },
  }),
}));
vi.mock('@/components/agents-ui/blocks/agent-session-view-01/components/tile-view', () => ({
  TileLayout: () => null,
}));
vi.mock('@/components/app/call-transcript', () => ({
  CallTranscript: () => <div data-testid="transcript" />,
}));
vi.mock('@/components/app/call-control-bar', () => ({
  CallControlBar: (props: {
    callSessionId: string | null;
    mode: string;
    startupPending: boolean;
    isAgentAvailable: boolean;
    isChatOpen: boolean;
    onIsChatOpenChange: (open: boolean) => void;
    onDisconnect: () => void;
    trailing?: ReactNode;
  }) => (
    <>
      <output aria-label="Microphone call scope">{props.callSessionId}</output>
      <output aria-label="Bar mode">{props.mode}</output>
      <output aria-label="Bar startup pending">{String(props.startupPending)}</output>
      <button type="button" onClick={() => props.onIsChatOpenChange(!props.isChatOpen)}>
        Test transcript
      </button>
      <button type="button" onClick={props.onDisconnect}>
        Test end call
      </button>
      {props.trailing}
    </>
  ),
}));
vi.mock('@/hooks/useViventiumVoiceEvents', () => ({
  useViventiumVoiceEvents: (...args: unknown[]) => {
    mocks.voiceEvents(...args);
    return {
      tasks: state.tasks,
      speakerSegments: [],
      latestSpeakerSegment: state.latestSpeakerSegment,
      recoveryIssue: state.recoveryIssue,
      recoveryRetryable: Boolean(state.recoveryIssue),
      retryRecovery: mocks.retryRecovery,
      applyAuthoritativeTaskEvent: vi.fn(),
      hasOlderSpeakers: false,
      loadingOlderSpeakers: false,
      loadOlderSpeakers: vi.fn(),
      hasNewerSpeakers: false,
      loadingNewerSpeakers: false,
      loadNewerSpeakers: vi.fn(),
      stopRecovery: () => {
        state.order.push('recovery stopped');
        mocks.stopRecovery();
      },
    };
  },
}));
vi.mock('@/hooks/useWingEngagement', () => ({ useWingEngagement: mocks.wing }));
vi.mock('@/hooks/useCallTaskActions', () => ({
  useCallTaskActions: () => ({
    cancel: vi.fn(),
    retry: vi.fn(),
    submitInput: vi.fn(),
    actionError: null,
    pendingTaskIds: new Set(),
  }),
}));
vi.mock('@/hooks/useCallResultBridge', () => ({ useCallResultBridge: mocks.resultBridge }));
vi.mock('@/hooks/useCallEndLifecycle', () => ({
  useCallEndLifecycle:
    ({ onEnded }: { onEnded: () => void }) =>
    (endAudio: () => Promise<unknown>) => {
      state.order.push('server told');
      onEnded();
      void endAudio();
    },
}));
vi.mock('@/hooks/useMicrophoneHealth', () => ({
  useMicrophoneHealth: () => ({
    issue: state.microphoneIssue,
    isInputBlocked: Boolean(state.microphoneIssue),
  }),
}));

function renderCall(
  call: Partial<CallContextValue> = {},
  props: Parameters<typeof SessionView>[0] = {}
) {
  const value: CallContextValue = {
    callSessionId: 'call-1',
    conversationId: 'chat-1',
    mode: 'call',
    modePending: false,
    setMode: vi.fn(),
    authoritativeStatus: null,
    callStateError: null,
    lastKeepalive: null,
    ...call,
  };
  return render(
    <CallProvider value={value}>
      <SessionView {...props} />
    </CallProvider>
  );
}

function workingTask(changed: Partial<VoiceTaskView> = {}): VoiceTaskView {
  return {
    version: 1,
    eventId: 'event-1',
    sequence: 1,
    emittedAt: '2026-08-09T12:00:00.000Z',
    firstEmittedAt: '2026-08-09T12:00:00.000Z',
    callSessionId: 'call-1',
    taskId: 'task-1',
    type: 'progress',
    state: 'running',
    label: 'Market lookup',
    cancellable: true,
    retryable: false,
    sources: [],
    ...changed,
  };
}

afterEach(() => {
  state.agentState = 'listening';
  state.agentAvailable = false;
  state.canPlayAudio = true;
  state.microphoneIssue = null;
  state.latestSpeakerSegment = null;
  state.tasks = [];
  state.recoveryIssue = null;
  state.order = [];
  Object.values(mocks).forEach((mock) => mock.mockClear());
});

describe('call status', () => {
  it.each([
    ['call', 'Call · listening'],
    ['wing', 'Wing · listening'],
    ['listen_only', 'Listen-Only · listening'],
  ] as const)('states the %s mode and what the call is doing', (mode, text) => {
    renderCall({ mode });
    expect(screen.getByRole('status', { name: 'Call status: listening' })).toHaveTextContent(text);
  });

  it('lets what the server confirmed as ended, failed or degraded win over the local state', () => {
    for (const authoritativeStatus of ['ended', 'failed', 'degraded'] as const) {
      expect(
        deriveCallStatus({
          authoritativeStatus,
          agentState: 'speaking',
          activeTaskState: 'running',
          callStateError: false,
        })
      ).toBe(authoritativeStatus);
    }
  });

  it('uses the server state when an early mode switch arrives before the assistant reports its own', () => {
    expect(
      deriveCallStatus({
        authoritativeStatus: 'listening',
        agentState: 'connecting',
        activeTaskState: null,
        callStateError: false,
      })
    ).toBe('listening');
  });

  it('says speaking while the assistant is audible, even with work running or a failed state refresh', () => {
    expect(
      deriveCallStatus({
        authoritativeStatus: 'working',
        agentState: 'speaking',
        activeTaskState: 'running',
        callStateError: true,
      })
    ).toBe('speaking');
  });

  it('orders the rest: needs input, degraded, working, listening, failed, connecting', () => {
    const base = {
      authoritativeStatus: null,
      agentState: 'listening',
      activeTaskState: null,
      callStateError: false,
    } as const;
    expect(deriveCallStatus({ ...base, activeTaskState: 'needs_input' })).toBe('needs input');
    expect(deriveCallStatus({ ...base, authoritativeStatus: 'needs_input' })).toBe('needs input');
    expect(deriveCallStatus({ ...base, callStateError: true, activeTaskState: 'running' })).toBe(
      'degraded'
    );
    expect(deriveCallStatus({ ...base, activeTaskState: 'queued' })).toBe('working');
    expect(deriveCallStatus(base)).toBe('listening');
    expect(deriveCallStatus({ ...base, agentState: 'failed' })).toBe('failed');
    expect(deriveCallStatus({ ...base, agentState: 'connecting' })).toBe('connecting');
  });

  it('shows working on the status line while a task runs', () => {
    state.tasks = [workingTask()];
    renderCall();
    expect(screen.getByRole('status', { name: 'Call status: working' })).toBeInTheDocument();
    expect(screen.getByText('Market lookup')).toBeInTheDocument();
  });
});

describe('waiting line', () => {
  it('says the microphone problem first, even when the assistant has joined', () => {
    expect(
      waitingLine({
        microphoneIssue: 'Microphone is muted.',
        isInputBlocked: true,
        isAgentAvailable: true,
        mode: 'call',
      })
    ).toBe('Microphone is muted.');
  });

  it('covers connecting, listening and Listen-Only', () => {
    const open = { microphoneIssue: null, isInputBlocked: false };
    expect(waitingLine({ ...open, isAgentAvailable: false, mode: 'call' })).toBe(
      'Connecting Viventium to the room...'
    );
    expect(waitingLine({ ...open, isAgentAvailable: true, mode: 'wing' })).toBe(
      'Agent is listening, ask it a question'
    );
    expect(waitingLine({ ...open, isAgentAvailable: true, mode: 'listen_only' })).toBe(
      'Viventium is here with you, just listening.'
    );
  });

  it('is on the call screen until the first message', () => {
    state.microphoneIssue = 'Permission denied.';
    state.agentAvailable = true;
    renderCall();
    expect(screen.getByText('Permission denied.')).toBeInTheDocument();
  });
});

describe('Wing and Listen-Only', () => {
  it('hands the newest speech and the exact mode to the Wing logic', () => {
    const segment = {
      segmentId: 'segment-1',
      text: 'Viventium, what do you think?',
      isFinal: true,
      revision: 1,
      speaker: { label: 'Speaker 1', attribution: 'unverified' },
    } as SpeakerSegmentV1;
    state.latestSpeakerSegment = segment;
    renderCall({ mode: 'wing', modePending: true });
    expect(mocks.wing).toHaveBeenLastCalledWith(
      expect.objectContaining({
        callSessionId: 'call-1',
        mode: 'wing',
        modePending: true,
        speakerSegment: segment,
      })
    );
    expect(mocks.voiceEvents).toHaveBeenLastCalledWith(
      expect.anything(),
      'call-1',
      ['agent-1'],
      null
    );
  });

  it('keeps Cancel but offers no Retry and never "Stop speech" in Listen-Only', () => {
    state.agentState = 'speaking';
    state.tasks = [
      workingTask({ retryable: true }),
      workingTask({
        taskId: 'task-2',
        label: 'Spoken result',
        state: 'completed',
        cancellable: false,
        presentation: { ref: 'presentation-1', state: 'speaking', startedAtMs: 1 },
      }),
    ];
    renderCall({ mode: 'listen_only' });
    expect(screen.getByRole('button', { name: 'Cancel Market lookup' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop speech/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Bar mode')).toHaveTextContent('listen_only');
  });

  it('offers "Stop speech" for the result being read aloud in a normal call', () => {
    state.agentState = 'speaking';
    state.tasks = [
      workingTask({
        label: 'Spoken result',
        state: 'completed',
        cancellable: false,
        presentation: { ref: 'presentation-1', state: 'speaking', startedAtMs: 1 },
      }),
    ];
    renderCall({ mode: 'call' });
    expect(
      screen.getByRole('button', { name: 'Stop speech for Spoken result' })
    ).toBeInTheDocument();
  });
});

describe('problems during a call', () => {
  it('shows a start problem with its retry', () => {
    const onIssueRetry = vi.fn();
    renderCall(
      {},
      {
        callIssue: { kind: 'mic_denied', message: 'Permission denied' },
        onIssueRetry,
      }
    );
    fireEvent.click(screen.getByRole('button', { name: 'Try microphone again' }));
    expect(onIssueRetry).toHaveBeenCalledOnce();
  });

  it('offers "Retry recovery" when loading work or speech history failed', () => {
    state.recoveryIssue = { kind: 'gateway_down', message: 'Snapshot failed.' };
    renderCall();
    fireEvent.click(screen.getByRole('button', { name: 'Retry recovery' }));
    expect(mocks.retryRecovery).toHaveBeenCalledOnce();
  });

  it('shows "Enable audio" only when the browser paused playback', () => {
    const { unmount } = renderCall();
    expect(screen.queryByText('Your browser paused call audio.')).not.toBeInTheDocument();
    unmount();
    state.canPlayAudio = false;
    renderCall();
    fireEvent.click(screen.getByRole('button', { name: 'Enable audio' }));
    expect(mocks.startAudio).toHaveBeenCalledOnce();
  });
});

describe('controls', () => {
  it('scopes the microphone memory to this call and passes the start lock on', () => {
    renderCall({ callSessionId: 'call-7' }, { startupPending: true });
    expect(screen.getByLabelText('Microphone call scope')).toHaveTextContent('call-7');
    expect(screen.getByLabelText('Bar startup pending')).toHaveTextContent('true');
  });

  it('opens the transcript and hides the latest caption while it is open', () => {
    state.latestSpeakerSegment = {
      segmentId: 'segment-1',
      text: 'Hello there.',
      isFinal: true,
      revision: 1,
      speaker: { label: 'Speaker 1', attribution: 'unverified' },
    };
    renderCall();
    expect(screen.getByText(/Hello there\./)).toBeInTheDocument();
    expect(screen.queryByTestId('transcript')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test transcript' }));
    expect(screen.getByTestId('transcript')).toBeInTheDocument();
    expect(screen.queryByText(/Hello there\./)).not.toBeInTheDocument();
  });

  it('on End: marks the call as ending, stops recovery, tells the server and the chat, then leaves the room', () => {
    const notifyChat = vi.fn(() => state.order.push('chat told'));
    mocks.resultBridge.mockReturnValue(notifyChat);
    mocks.sessionEnd.mockImplementation(async () => {
      state.order.push('room left');
    });
    const onCallEnding = vi.fn(() => state.order.push('token fenced'));
    const onCallEnded = vi.fn(() => state.order.push('page ended'));
    renderCall({}, { onCallEnding, onCallEnded });

    fireEvent.click(screen.getByRole('button', { name: 'Test end call' }));

    expect(state.order).toEqual([
      'token fenced',
      'recovery stopped',
      'server told',
      'chat told',
      'page ended',
      'room left',
    ]);
    expect(mocks.sessionEnd).toHaveBeenCalledOnce();
  });

  it('gives the result bridge this call, its chat and where to report the chat address', () => {
    const onLinkedChatHrefChange = vi.fn();
    renderCall({}, { onLinkedChatHrefChange });
    expect(mocks.resultBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        callSessionId: 'call-1',
        conversationId: 'chat-1',
        onLinkedChatHrefChange,
      })
    );
  });
});
