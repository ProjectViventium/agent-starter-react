import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AppConfig } from '@/app-config';
import { SessionView } from '@/components/app/session-view';
import type { SpeakerSegmentV1, VoiceTaskView } from '@/lib/voice-events';

const livekitState = vi.hoisted(() => ({
  agentState: 'listening',
  latestSpeakerSegment: null as SpeakerSegmentV1 | null,
  tasks: [] as VoiceTaskView[],
}));
const useWingEngagementMock = vi.hoisted(() => vi.fn());
const endCallMock = vi.hoisted(() => vi.fn());
const stopRecoveryMock = vi.hoisted(() => vi.fn());

vi.mock('@livekit/components-react', () => ({
  useSessionContext: () => ({
    isConnected: true,
    end: vi.fn(),
    room: { remoteParticipants: new Map(), localParticipant: {} },
  }),
  useAgent: () => ({
    state: livekitState.agentState,
    internal: {
      agentParticipant: { identity: 'agent-1' },
      workerParticipant: null,
    },
  }),
  useRemoteParticipants: () => [],
}));
vi.mock('@/components/app/tile-layout', () => ({ TileLayout: () => null }));
vi.mock('@/components/app/chat-transcript', () => ({ ChatTranscript: () => null }));
vi.mock('@/components/app/preconnect-message', () => ({ PreConnectMessage: () => null }));
vi.mock('@/components/livekit/scroll-area/scroll-area', () => {
  const ScrollArea = React.forwardRef<HTMLDivElement, React.ComponentProps<'div'>>(
    function MockScrollArea({ children, ...props }, ref) {
      return (
        <div ref={ref} {...props}>
          {children}
        </div>
      );
    }
  );
  return { ScrollArea };
});
vi.mock('@/components/livekit/agent-control-bar/agent-control-bar', () => ({
  AgentControlBar: ({
    controls,
    onDisconnect,
  }: {
    controls: { chat: boolean };
    onDisconnect: () => void;
  }) => (
    <>
      <output aria-label="Chat control enabled">{String(controls.chat)}</output>
      <button type="button" onClick={onDisconnect}>
        Test end call
      </button>
    </>
  ),
}));
vi.mock('@/hooks/useViventiumSessionMessages', () => ({
  useViventiumSessionMessages: () => ({ messages: [] }),
}));
vi.mock('@/hooks/useViventiumVoiceEvents', () => ({
  useViventiumVoiceEvents: () => ({
    tasks: livekitState.tasks,
    speakerSegments: [],
    latestSpeakerSegment: livekitState.latestSpeakerSegment,
    recoveryIssue: null,
    recoveryRetryable: false,
    retryRecovery: vi.fn(),
    stopRecovery: stopRecoveryMock,
  }),
}));
vi.mock('@/hooks/useWingEngagement', () => ({ useWingEngagement: useWingEngagementMock }));
vi.mock('@/hooks/useCallTaskActions', () => ({
  useCallTaskActions: () => ({
    cancel: vi.fn(),
    retry: vi.fn(),
    submitInput: vi.fn(),
    actionError: null,
    pendingTaskIds: new Set(),
  }),
}));
vi.mock('@/hooks/useCallResultBridge', () => ({ useCallResultBridge: () => vi.fn() }));
vi.mock('@/hooks/useCallEndLifecycle', () => ({ useCallEndLifecycle: () => endCallMock }));
vi.mock('@/hooks/useMicrophoneHealth', () => ({
  useMicrophoneHealth: () => ({ isInputBlocked: false }),
}));

const appConfig = {
  supportsChatInput: true,
  supportsVideoInput: false,
  supportsScreenShare: false,
  isPreConnectBufferEnabled: false,
} as AppConfig;

afterEach(() => {
  livekitState.agentState = 'listening';
  livekitState.latestSpeakerSegment = null;
  livekitState.tasks = [];
  useWingEngagementMock.mockClear();
  endCallMock.mockClear();
  stopRecoveryMock.mockClear();
});

describe('SessionView call hardening', () => {
  it('renders a structured issue during an active call and suppresses new chat in Listen-Only', () => {
    const { container } = render(
      <SessionView
        appConfig={appConfig}
        callSessionId="call-1"
        mode="listen_only"
        callIssue={{ kind: 'provider_failure', message: 'Configured provider failed.' }}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent(
      'The configured voice provider is unavailable'
    );
    expect(screen.getByLabelText('Chat control enabled')).toHaveTextContent('false');
    expect(container.querySelector('[class*="max-h-[58svh]"]')).toBeInTheDocument();
    expect(container.querySelector('[class*="pb-[min(60svh,28rem)]"]')).toBeInTheDocument();
  });

  it('uses the durable call state when an early mode switch precedes agent-state metadata', () => {
    livekitState.agentState = 'connecting';
    render(
      <SessionView
        appConfig={appConfig}
        callSessionId="call-early-switch"
        mode="listen_only"
        authoritativeStatus="listening"
      />
    );

    expect(screen.getByRole('status', { name: 'Call status: listening' })).toBeInTheDocument();
  });

  it('announces audible speaking while the durable task is still active', () => {
    livekitState.agentState = 'speaking';
    livekitState.tasks = [
      {
        version: 1,
        eventId: 'event-speaking',
        sequence: 1,
        emittedAt: '2026-08-27T08:00:00.000Z',
        callSessionId: 'call-speaking',
        taskId: 'task-speaking',
        type: 'state',
        state: 'running',
        cancellable: true,
        retryable: false,
        firstEmittedAt: '2026-08-27T08:00:00.000Z',
        sources: [],
      },
    ];

    render(
      <SessionView
        appConfig={appConfig}
        callSessionId="call-speaking"
        authoritativeStatus="working"
      />
    );

    expect(screen.getByRole('status', { name: 'Call status: speaking' })).toBeInTheDocument();
  });

  it('announces audible speaking during a transient call-state refresh failure', () => {
    livekitState.agentState = 'speaking';
    render(
      <SessionView
        appConfig={appConfig}
        callSessionId="call-speaking-during-refresh"
        authoritativeStatus="listening"
        callStateError="The durable call state could not be refreshed."
      />
    );

    expect(screen.getByRole('status', { name: 'Call status: speaking' })).toBeInTheDocument();
  });

  it.each(['degraded', 'failed', 'ended'] as const)(
    'lets durable %s state replace stale local listening and work state',
    (authoritativeStatus) => {
      livekitState.agentState = 'listening';
      livekitState.tasks = [
        {
          version: 1,
          eventId: `event-${authoritativeStatus}`,
          sequence: 1,
          emittedAt: '2026-08-27T08:00:00.000Z',
          callSessionId: `call-${authoritativeStatus}`,
          taskId: `task-${authoritativeStatus}`,
          type: 'state',
          state: 'running',
          cancellable: true,
          retryable: false,
          firstEmittedAt: '2026-08-27T08:00:00.000Z',
          sources: [],
        },
      ];

      render(
        <SessionView
          appConfig={appConfig}
          callSessionId={`call-${authoritativeStatus}`}
          authoritativeStatus={authoritativeStatus}
        />
      );

      expect(
        screen.getByRole('status', { name: `Call status: ${authoritativeStatus}` })
      ).toBeInTheDocument();
    }
  );

  it('mounts the trusted Wing producer on the current speaker event and exact mode state', () => {
    const segment: SpeakerSegmentV1 = {
      version: 1,
      segmentId: 'segment-owner-1',
      callSessionId: 'call-owner-1',
      turnId: 'turn-owner-1',
      sequence: 1,
      revision: 1,
      text: 'Synthetic owner speech.',
      isFinal: true,
      speaker: {
        key: 'participant:owner-participant',
        label: 'You',
        source: 'hybrid',
        attribution: 'verified',
        actorTrust: 'owner_participant',
        participantIdentity: 'owner-participant',
      },
    };
    livekitState.latestSpeakerSegment = segment;

    const { rerender } = render(
      <SessionView appConfig={appConfig} callSessionId="call-owner-1" mode="wing" />
    );
    expect(useWingEngagementMock).toHaveBeenLastCalledWith({
      session: expect.objectContaining({ isConnected: true }),
      callSessionId: 'call-owner-1',
      mode: 'wing',
      modePending: false,
      speakerSegment: segment,
    });

    rerender(
      <SessionView
        appConfig={appConfig}
        callSessionId="call-owner-1"
        mode="listen_only"
        modePending
      />
    );
    expect(useWingEngagementMock).toHaveBeenLastCalledWith({
      session: expect.objectContaining({ isConnected: true }),
      callSessionId: 'call-owner-1',
      mode: 'listen_only',
      modePending: true,
      speakerSegment: segment,
    });
  });

  it('marks the local token source as ending before disconnecting the LiveKit session', () => {
    const onCallEnding = vi.fn();
    render(
      <SessionView
        appConfig={appConfig}
        callSessionId="call-end-order"
        onCallEnding={onCallEnding}
      />
    );

    screen.getByRole('button', { name: 'Test end call' }).click();

    expect(onCallEnding).toHaveBeenCalledTimes(1);
    expect(stopRecoveryMock).toHaveBeenCalledTimes(1);
    expect(endCallMock).toHaveBeenCalledTimes(1);
    expect(onCallEnding.mock.invocationCallOrder[0]).toBeLessThan(
      stopRecoveryMock.mock.invocationCallOrder[0]
    );
    expect(stopRecoveryMock.mock.invocationCallOrder[0]).toBeLessThan(
      endCallMock.mock.invocationCallOrder[0]
    );
  });
});
