import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AppConfig } from '@/app-config';
import { SessionView } from '@/components/app/session-view';

vi.mock('@livekit/components-react', () => ({
  useSessionContext: () => ({
    isConnected: true,
    end: vi.fn(),
    room: { remoteParticipants: new Map(), localParticipant: {} },
  }),
  useAgent: () => ({
    state: 'listening',
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
  AgentControlBar: ({ controls }: { controls: { chat: boolean } }) => (
    <output aria-label="Chat control enabled">{String(controls.chat)}</output>
  ),
}));
vi.mock('@/hooks/useViventiumSessionMessages', () => ({
  useViventiumSessionMessages: () => ({ messages: [] }),
}));
vi.mock('@/hooks/useViventiumVoiceEvents', () => ({
  useViventiumVoiceEvents: () => ({
    tasks: [],
    speakerSegments: [],
    recoveryIssue: null,
    recoveryRetryable: false,
    retryRecovery: vi.fn(),
  }),
}));
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
vi.mock('@/hooks/useCallEndLifecycle', () => ({ useCallEndLifecycle: () => vi.fn() }));
vi.mock('@/hooks/useMicrophoneHealth', () => ({
  useMicrophoneHealth: () => ({ isInputBlocked: false }),
}));

const appConfig = {
  supportsChatInput: true,
  supportsVideoInput: false,
  supportsScreenShare: false,
  isPreConnectBufferEnabled: false,
} as AppConfig;

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
});
