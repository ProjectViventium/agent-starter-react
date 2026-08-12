'use client';

import React, { useEffect, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { useAgent, useRemoteParticipants, useSessionContext } from '@livekit/components-react';
import type { AppConfig } from '@/app-config';
import {
  CallActivity,
  LatestSpeakerCaption,
  SpeakerTranscript,
} from '@/components/app/call-activity';
import { CallIssueNotice } from '@/components/app/call-issue-notice';
import {
  type AccessibleCallStatus,
  CallStatusIndicator,
  LISTEN_ONLY_PRECONNECT_MESSAGE,
} from '@/components/app/call-mode-control';
import { ChatTranscript } from '@/components/app/chat-transcript';
import { PreConnectMessage } from '@/components/app/preconnect-message';
import { TileLayout } from '@/components/app/tile-layout';
import {
  AgentControlBar,
  type ControlBarControls,
} from '@/components/livekit/agent-control-bar/agent-control-bar';
import { useCallEndLifecycle } from '@/hooks/useCallEndLifecycle';
import { useCallResultBridge } from '@/hooks/useCallResultBridge';
import type { VoiceCallMode } from '@/hooks/useCallSessionState';
import { useCallTaskActions } from '@/hooks/useCallTaskActions';
import { useMicrophoneHealth } from '@/hooks/useMicrophoneHealth';
import { useViventiumSessionMessages } from '@/hooks/useViventiumSessionMessages';
import { useViventiumVoiceEvents } from '@/hooks/useViventiumVoiceEvents';
import type { CallIssue } from '@/lib/call-start';
import { cn } from '@/lib/utils';
import { Button } from '../livekit/button';
import { ScrollArea } from '../livekit/scroll-area/scroll-area';

const MotionBottom = motion.create('div');

const BOTTOM_VIEW_MOTION_PROPS = {
  variants: {
    visible: {
      opacity: 1,
      translateY: '0%',
    },
    hidden: {
      opacity: 0,
      translateY: '100%',
    },
  },
  initial: 'hidden',
  animate: 'visible',
  exit: 'hidden',
  transition: {
    duration: 0.3,
    delay: 0.5,
    ease: 'easeOut',
  },
};

interface FadeProps {
  top?: boolean;
  bottom?: boolean;
  className?: string;
}

export function Fade({ top = false, bottom = false, className }: FadeProps) {
  return (
    <div
      className={cn(
        'from-background pointer-events-none h-4 bg-linear-to-b to-transparent',
        top && 'bg-linear-to-b',
        bottom && 'bg-linear-to-t',
        className
      )}
    />
  );
}

interface SessionViewProps {
  appConfig: AppConfig;
  callSessionId: string | null;
  conversationId?: string | null;
  mode?: VoiceCallMode;
  modePending?: boolean;
  onModeChange?: (mode: VoiceCallMode) => void;
  callStateError?: string | null;
  onCallEnded?: () => void;
  audioRecoveryRequired?: boolean;
  onAudioRecovery?: () => void;
  callIssue?: CallIssue | null;
  onIssueRetry?: () => void;
}

export const SessionView = ({
  appConfig,
  callSessionId,
  conversationId = null,
  mode = 'call',
  modePending = false,
  onModeChange,
  callStateError,
  onCallEnded,
  audioRecoveryRequired = false,
  onAudioRecovery,
  callIssue,
  onIssueRetry,
  ...props
}: React.ComponentProps<'section'> & SessionViewProps) => {
  const session = useSessionContext();
  const reducedMotion = useReducedMotion();
  const agent = useAgent(session);
  const { messages } = useViventiumSessionMessages(session);
  const agentIdentities = React.useMemo(
    () =>
      [
        agent.internal.agentParticipant?.identity,
        agent.internal.workerParticipant?.identity,
      ].filter((identity): identity is string => Boolean(identity)),
    [agent.internal.agentParticipant?.identity, agent.internal.workerParticipant?.identity]
  );
  const {
    tasks,
    speakerSegments,
    latestSpeakerSegment,
    recoveryIssue,
    recoveryRetryable,
    retryRecovery,
    applyAuthoritativeTaskEvent,
    hasOlderSpeakers,
    loadingOlderSpeakers,
    loadOlderSpeakers,
    hasNewerSpeakers,
    loadingNewerSpeakers,
    loadNewerSpeakers,
  } = useViventiumVoiceEvents(session, callSessionId, agentIdentities);
  const taskActions = useCallTaskActions(callSessionId, applyAuthoritativeTaskEvent);
  const notifyLinkedChat = useCallResultBridge({ callSessionId, conversationId, tasks });
  const handleEnded = React.useCallback(() => {
    notifyLinkedChat();
    onCallEnded?.();
  }, [notifyLinkedChat, onCallEnded]);
  const endCall = useCallEndLifecycle({ callSessionId, onEnded: handleEnded });
  const participants = useRemoteParticipants();
  const [chatOpen, setChatOpen] = useState(false);
  const visibleMessages = React.useMemo(
    () =>
      speakerSegments.length > 0
        ? messages.filter((message) => message.type !== 'userTranscript')
        : messages,
    [messages, speakerSegments.length]
  );
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const { isInputBlocked } = useMicrophoneHealth();
  const isAgentAvailable = participants.some((participant) => participant.isAgent);
  const activeTask = tasks.find((task) =>
    ['queued', 'running', 'recovering', 'cancelling', 'needs_input'].includes(task.state)
  );
  const callStatus: AccessibleCallStatus = callStateError
    ? 'degraded'
    : activeTask?.state === 'needs_input'
      ? 'needs input'
      : activeTask
        ? 'working'
        : agent.state === 'speaking'
          ? 'speaking'
          : agent.state === 'listening'
            ? 'listening'
            : agent.state === 'failed'
              ? 'failed'
              : 'connecting';

  const controls: ControlBarControls = {
    leave: true,
    microphone: true,
    chat: mode !== 'listen_only' && appConfig.supportsChatInput,
    camera: appConfig.supportsVideoInput,
    screenShare: appConfig.supportsScreenShare,
  };

  useEffect(() => {
    const lastMessage = messages.at(-1);
    const lastMessageIsLocal = lastMessage?.from?.isLocal === true;

    if (scrollAreaRef.current && lastMessageIsLocal) {
      scrollAreaRef.current.scrollTop = scrollAreaRef.current.scrollHeight;
    }
  }, [messages]);

  const preConnectMessage = isAgentAvailable
    ? mode === 'listen_only'
      ? LISTEN_ONLY_PRECONNECT_MESSAGE
      : 'Agent is listening, ask it a question'
    : isInputBlocked
      ? 'Turn on your microphone to bring Viventium into the room'
      : 'Connecting Viventium to the room...';

  return (
    <section className="bg-background relative z-10 h-full w-full overflow-hidden" {...props}>
      {/* Chat Transcript */}
      <div
        className={cn(
          'fixed inset-0 grid grid-cols-1 grid-rows-1',
          !chatOpen && 'pointer-events-none'
        )}
      >
        <Fade top className="absolute inset-x-4 top-0 h-40" />
        <ScrollArea
          ref={scrollAreaRef}
          className="px-4 pt-40 pb-[min(60svh,28rem)] md:px-6 md:pb-[200px]"
        >
          <ChatTranscript
            hidden={!chatOpen}
            messages={visibleMessages}
            className="mx-auto max-w-2xl space-y-3 transition-opacity duration-300 ease-out motion-reduce:transition-none"
          />
          {!chatOpen ? null : (
            <SpeakerTranscript
              segments={speakerSegments}
              scrollContainerRef={scrollAreaRef}
              hasOlder={hasOlderSpeakers}
              loadingOlder={loadingOlderSpeakers}
              onLoadOlder={loadOlderSpeakers}
              hasNewer={hasNewerSpeakers}
              loadingNewer={loadingNewerSpeakers}
              onLoadNewer={loadNewerSpeakers}
              className="mx-auto mt-3 max-w-2xl transition-opacity duration-300 ease-out motion-reduce:transition-none"
            />
          )}
        </ScrollArea>
      </div>

      {/* Tile Layout */}
      <TileLayout chatOpen={chatOpen} />

      {/* Bottom */}
      <MotionBottom
        {...(reducedMotion
          ? { initial: false, animate: 'visible', exit: 'visible', transition: { duration: 0 } }
          : BOTTOM_VIEW_MOTION_PROPS)}
        className="fixed inset-x-3 bottom-0 z-50 max-h-[58svh] overflow-y-auto overscroll-contain md:inset-x-12 md:max-h-none md:overflow-visible"
      >
        <div className="mx-auto mb-2 flex max-w-2xl justify-center px-2">
          <CallStatusIndicator status={callStatus} mode={mode} />
        </div>
        <LatestSpeakerCaption
          segments={latestSpeakerSegment ? [latestSpeakerSegment] : []}
          hidden={chatOpen}
          className="mb-2 w-full"
        />
        {(callIssue ?? recoveryIssue) ? (
          <div className="mx-auto mb-2 max-w-2xl">
            <CallIssueNotice
              issue={(callIssue ?? recoveryIssue)!}
              showRetry={!callIssue && recoveryRetryable}
              onRetry={callIssue ? onIssueRetry : recoveryRetryable ? retryRecovery : undefined}
            />
          </div>
        ) : null}
        {audioRecoveryRequired && onAudioRecovery ? (
          <div className="bg-background/95 border-border mx-auto mb-2 flex max-w-2xl items-center justify-between gap-3 rounded-xl border px-3 py-2 text-xs shadow-sm">
            <span role="alert">Your browser paused call audio.</span>
            <Button type="button" size="sm" variant="outline" onClick={onAudioRecovery}>
              Enable audio
            </Button>
          </div>
        ) : null}
        <CallActivity
          mode={mode}
          tasks={tasks}
          onCancel={(taskId) => void taskActions.cancel(taskId)}
          onRetry={(taskId) => void taskActions.retry(taskId)}
          onInput={(taskId, input) => void taskActions.submitInput(taskId, input)}
          actionError={taskActions.actionError}
          pendingTaskIds={taskActions.pendingTaskIds}
          className="mb-2 max-h-52 overflow-y-auto"
        />
        {appConfig.isPreConnectBufferEnabled && (
          <PreConnectMessage messages={messages} message={preConnectMessage} className="pb-4" />
        )}
        <div className="bg-background relative mx-auto max-w-2xl pb-3 md:pb-12">
          <Fade bottom className="absolute inset-x-0 top-0 h-4 -translate-y-full" />
          <AgentControlBar
            appConfig={appConfig}
            controls={controls}
            isConnected={session.isConnected}
            onDisconnect={() => {
              endCall(() => session.end());
            }}
            onChatOpenChange={setChatOpen}
            mode={mode}
            modePending={modePending}
            onModeChange={onModeChange}
          />
        </div>
      </MotionBottom>
    </section>
  );
};
