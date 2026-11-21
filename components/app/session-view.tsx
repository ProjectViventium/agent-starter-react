'use client';

/*
 * The call screen (CP-CMP-015 … 024).
 *
 * A Viventium variant of the base's session block (`agents-ui/blocks/agent-session-view-01`):
 * same three layers (transcript, agent tile, bottom stack) and the base's tile and visualiser.
 * The base's block has no slots, so this copy adds the Viventium rows to the bottom stack, in
 * this order: status line, latest caption, problem notice, "browser paused audio" notice, work
 * cards, file cards, waiting line, control bar.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, type MotionProps, motion, useReducedMotion } from 'motion/react';
import {
  type AgentState,
  useAgent,
  useEnsureRoom,
  useRemoteParticipants,
  useSessionContext,
  useSessionMessages,
  useStartAudio,
} from '@livekit/components-react';
import { TileLayout } from '@/components/agents-ui/blocks/agent-session-view-01/components/tile-view';
import { CallActivity } from '@/components/app/call-activity';
import { CallButton } from '@/components/app/call-button';
import { useCall } from '@/components/app/call-context';
import { CallControlBar } from '@/components/app/call-control-bar';
import { CallIssueNotice } from '@/components/app/call-issue-notice';
import {
  type AccessibleCallStatus,
  CallStatusIndicator,
  LISTEN_ONLY_PRECONNECT_MESSAGE,
} from '@/components/app/call-mode-control';
import { CallResultFiles } from '@/components/app/call-result-files';
import { CallTranscript } from '@/components/app/call-transcript';
import { LatestSpeakerCaption } from '@/components/app/speaker-transcript';
import { useCallEndLifecycle } from '@/hooks/useCallEndLifecycle';
import { useCallResultBridge } from '@/hooks/useCallResultBridge';
import type { VoiceCallMode } from '@/hooks/useCallSessionState';
import { useCallTaskActions } from '@/hooks/useCallTaskActions';
import { useMicrophoneHealth } from '@/hooks/useMicrophoneHealth';
import { useViventiumVoiceEvents } from '@/hooks/useViventiumVoiceEvents';
import { useWingEngagement } from '@/hooks/useWingEngagement';
import type { CallIssue } from '@/lib/call-start';
import type { VoiceCallStatus } from '@/lib/call-state';
import { cn } from '@/lib/shadcn/utils';
import type { VoiceTaskState } from '@/lib/voice-events';

const BOTTOM_MOTION: MotionProps = {
  variants: {
    visible: { opacity: 1, translateY: '0%' },
    hidden: { opacity: 0, translateY: '100%' },
  },
  initial: 'hidden',
  animate: 'visible',
  exit: 'hidden',
  transition: { duration: 0.3, delay: 0.5, ease: 'easeOut' },
};

const TRANSCRIPT_MOTION: MotionProps = {
  variants: {
    hidden: { opacity: 0, transition: { ease: 'easeOut', duration: 0.3 } },
    visible: { opacity: 1, transition: { delay: 0.2, ease: 'easeOut', duration: 0.3 } },
  },
  initial: 'hidden',
  animate: 'visible',
  exit: 'hidden',
};

const WAITING_LINE_MOTION: MotionProps = {
  variants: {
    visible: { opacity: 1, transition: { ease: 'easeIn', duration: 0.5, delay: 0.8 } },
    hidden: { opacity: 0, transition: { ease: 'easeIn', duration: 0.5, delay: 0 } },
  },
  initial: 'hidden',
  animate: 'visible',
  exit: 'hidden',
};

const INSTANT_MOTION: MotionProps = {
  initial: false,
  animate: 'visible',
  exit: 'visible',
  transition: { duration: 0 },
};

const ACTIVE_TASK_STATES: VoiceTaskState[] = [
  'queued',
  'running',
  'recovering',
  'cancelling',
  'needs_input',
];

/** Height the transcript keeps free at the bottom before the bottom stack has been measured. */
const DEFAULT_BOTTOM_STACK_PX = 170;

/**
 * The one status the status line shows. What the server confirmed as degraded, failed or ended
 * wins over what the local assistant state says; audible speech wins over "working".
 */
export function deriveCallStatus({
  authoritativeStatus,
  agentState,
  activeTaskState,
  callStateError,
}: {
  authoritativeStatus: VoiceCallStatus | null;
  agentState: AgentState;
  activeTaskState: VoiceTaskState | null;
  callStateError: boolean;
}): AccessibleCallStatus {
  const fromServer: AccessibleCallStatus =
    authoritativeStatus === 'needs_input'
      ? 'needs input'
      : authoritativeStatus === 'listening' ||
          authoritativeStatus === 'speaking' ||
          authoritativeStatus === 'working' ||
          authoritativeStatus === 'degraded' ||
          authoritativeStatus === 'failed' ||
          authoritativeStatus === 'ended'
        ? authoritativeStatus
        : 'connecting';
  if (fromServer === 'degraded' || fromServer === 'failed' || fromServer === 'ended') {
    return fromServer;
  }
  if (agentState === 'speaking') return 'speaking';
  if (activeTaskState === 'needs_input' || fromServer === 'needs input') return 'needs input';
  if (callStateError) return 'degraded';
  if (activeTaskState || fromServer === 'working') return 'working';
  if (agentState === 'listening') return 'listening';
  if (agentState === 'failed') return 'failed';
  return fromServer;
}

/** The line shown above the controls until the first message. */
export function waitingLine({
  microphoneIssue,
  isInputBlocked,
  isAgentAvailable,
  mode,
}: {
  microphoneIssue: string | null;
  isInputBlocked: boolean;
  isAgentAvailable: boolean;
  mode: VoiceCallMode;
}): string {
  // An assistant that has joined still cannot hear a blocked microphone: say that first.
  if (isInputBlocked) {
    return microphoneIssue ?? 'Turn on your microphone to bring Viventium into the room';
  }
  if (!isAgentAvailable) return 'Connecting Viventium to the room...';
  return mode === 'listen_only'
    ? LISTEN_ONLY_PRECONNECT_MESSAGE
    : 'Agent is listening, ask it a question';
}

/** Shown only when the browser refuses to play sound (CP-CMP-023). */
function AudioBlockedNotice() {
  const room = useEnsureRoom();
  const { mergedProps, canPlayAudio } = useStartAudio({ room, props: {} });
  if (canPlayAudio) return null;
  return (
    <div className="bg-background/95 border-border mx-auto mb-2 flex max-w-2xl items-center justify-between gap-3 rounded-xl border px-3 py-2 text-xs shadow-sm">
      <span role="alert">Your browser paused call audio.</span>
      <CallButton type="button" size="sm" variant="outline" onClick={mergedProps.onClick}>
        Enable audio
      </CallButton>
    </div>
  );
}

function Fade({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'from-background pointer-events-none h-4 bg-linear-to-b to-transparent',
        className
      )}
    />
  );
}

export interface SessionViewProps {
  /** The call is still starting (microphone, connection). */
  startupPending?: boolean;
  /** A problem with starting or with the server's call record. */
  callIssue?: CallIssue | null;
  onIssueRetry?: () => void;
  /** The user pressed End: called before anything is torn down. */
  onCallEnding?: () => void;
  onCallEnded?: () => void;
  onLinkedChatHrefChange?: (href: string | null) => void;
  supportsVideoInput?: boolean;
  themeMode?: 'dark' | 'light';
  /** Extra control in the control bar (the provider picker button). */
  controlBarTrailing?: React.ReactNode;
}

export function SessionView({
  startupPending = false,
  callIssue,
  onIssueRetry,
  onCallEnding,
  onCallEnded,
  onLinkedChatHrefChange,
  supportsVideoInput = true,
  themeMode,
  controlBarTrailing,
  ref,
  className,
  ...props
}: React.ComponentProps<'section'> & SessionViewProps) {
  const {
    callSessionId,
    conversationId,
    mode,
    modePending,
    setMode,
    authoritativeStatus,
    callStateError,
    lastKeepalive,
  } = useCall();
  const session = useSessionContext();
  const agent = useAgent(session);
  const { messages } = useSessionMessages(session);
  const reducedMotion = useReducedMotion();
  const [isChatOpen, setIsChatOpen] = useState(false);

  const agentIdentities = useMemo(
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
    stopRecovery,
  } = useViventiumVoiceEvents(session, callSessionId, agentIdentities, lastKeepalive);
  // Wing: hands the newest speech and the current mode to the logic that decides when the
  // assistant is being addressed.
  useWingEngagement({
    session,
    callSessionId,
    mode,
    modePending,
    speakerSegment: latestSpeakerSegment,
  });
  const taskActions = useCallTaskActions(callSessionId, applyAuthoritativeTaskEvent);
  const notifyLinkedChat = useCallResultBridge({
    callSessionId,
    conversationId,
    tasks,
    onLinkedChatHrefChange,
  });
  const handleEnded = useCallback(() => {
    notifyLinkedChat();
    onCallEnded?.();
  }, [notifyLinkedChat, onCallEnded]);
  const endCall = useCallEndLifecycle({ callSessionId, onEnded: handleEnded });
  const { issue: microphoneIssue, isInputBlocked } = useMicrophoneHealth();
  const isAgentAvailable = useRemoteParticipants().some((participant) => participant.isAgent);

  const activeTask = tasks.find((task) => ACTIVE_TASK_STATES.includes(task.state));
  const callStatus = deriveCallStatus({
    authoritativeStatus,
    agentState: agent.state,
    activeTaskState: activeTask?.state ?? null,
    callStateError: Boolean(callStateError),
  });
  const callHasStopped =
    callStatus === 'degraded' || callStatus === 'failed' || callStatus === 'ended';
  const listenOnly = mode === 'listen_only';
  const issue = callIssue ?? recoveryIssue;

  // The transcript ends where the bottom stack begins, whatever the stack holds.
  const bottomRef = useRef<HTMLDivElement>(null);
  const [bottomStackPx, setBottomStackPx] = useState(DEFAULT_BOTTOM_STACK_PX);
  useEffect(() => {
    const element = bottomRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setBottomStackPx(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const speakerPaging = useMemo(
    () => ({
      hasOlder: hasOlderSpeakers,
      loadingOlder: loadingOlderSpeakers,
      onLoadOlder: loadOlderSpeakers,
      hasNewer: hasNewerSpeakers,
      loadingNewer: loadingNewerSpeakers,
      onLoadNewer: loadNewerSpeakers,
    }),
    [
      hasOlderSpeakers,
      loadingOlderSpeakers,
      loadOlderSpeakers,
      hasNewerSpeakers,
      loadingNewerSpeakers,
      loadNewerSpeakers,
    ]
  );

  return (
    <section
      ref={ref}
      className={cn('bg-background relative z-10 h-full w-full overflow-hidden', className)}
      {...props}
    >
      <Fade className="absolute inset-x-4 top-0 z-10 h-40" />

      {/* Transcript */}
      <AnimatePresence>
        {isChatOpen && (
          <motion.div
            {...(reducedMotion ? INSTANT_MOTION : TRANSCRIPT_MOTION)}
            style={{ bottom: bottomStackPx }}
            className="absolute inset-x-0 top-0 overflow-hidden"
          >
            <CallTranscript
              agentState={agent.state}
              messages={messages}
              speakerSegments={speakerSegments}
              speakerPaging={speakerPaging}
              className="mx-auto max-w-2xl **:data-[slot=message-scroller-content]:p-4 **:data-[slot=message-scroller-content]:pt-40! md:**:data-[slot=message-scroller-content]:p-6"
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Agent tile */}
      <TileLayout isChatOpen={isChatOpen} themeMode={themeMode} />

      {/* Bottom stack */}
      <motion.div
        ref={bottomRef}
        {...(reducedMotion ? INSTANT_MOTION : BOTTOM_MOTION)}
        className="absolute inset-x-3 bottom-0 z-50 max-h-[58svh] overflow-y-auto overscroll-contain md:inset-x-12 md:max-h-none md:overflow-visible"
      >
        <div className="mx-auto mb-2 flex max-w-2xl justify-center px-2">
          <CallStatusIndicator status={callStatus} mode={mode} />
        </div>
        <LatestSpeakerCaption
          segments={latestSpeakerSegment ? [latestSpeakerSegment] : []}
          hidden={isChatOpen}
          className="mb-2 w-full"
        />
        {issue ? (
          <div className="mx-auto mb-2 max-w-2xl">
            <CallIssueNotice
              issue={issue}
              showRetry={!callIssue && recoveryRetryable}
              onRetry={callIssue ? onIssueRetry : recoveryRetryable ? retryRecovery : undefined}
            />
          </div>
        ) : null}
        <AudioBlockedNotice />
        <CallActivity
          mode={mode}
          isAgentSpeaking={agent.state === 'speaking' && !callHasStopped && !listenOnly}
          tasks={tasks}
          onCancel={(taskId, presentationRef) => void taskActions.cancel(taskId, presentationRef)}
          onRetry={(taskId) => void taskActions.retry(taskId)}
          onInput={(taskId, input) => void taskActions.submitInput(taskId, input)}
          actionError={taskActions.actionError}
          pendingTaskIds={taskActions.pendingTaskIds}
          className="mb-2 max-h-52 overflow-y-auto"
        />
        <CallResultFiles callSessionId={callSessionId} tasks={tasks} />
        <AnimatePresence>
          {messages.length === 0 && (
            <motion.p
              key="waiting-line"
              {...(reducedMotion ? INSTANT_MOTION : WAITING_LINE_MOTION)}
              className="shimmer shimmer-duration-2000 pointer-events-none mx-auto block w-full max-w-2xl pb-4 text-center text-sm font-semibold"
            >
              {waitingLine({ microphoneIssue, isInputBlocked, isAgentAvailable, mode })}
            </motion.p>
          )}
        </AnimatePresence>
        <div className="bg-background relative mx-auto max-w-2xl pb-3 md:pb-12">
          <CallControlBar
            callSessionId={callSessionId}
            controls={{
              leave: true,
              microphone: true,
              chat: true,
              camera: supportsVideoInput,
              screenShare: supportsVideoInput,
            }}
            isConnected={session.isConnected}
            isAgentAvailable={isAgentAvailable}
            startupPending={startupPending}
            isChatOpen={isChatOpen}
            onIsChatOpenChange={setIsChatOpen}
            mode={mode}
            modePending={modePending}
            onModeChange={setMode}
            trailing={controlBarTrailing}
            onDisconnect={() => {
              // The server learns the call ended before the room closes; work goes on in chat.
              onCallEnding?.();
              stopRecovery();
              endCall(() => session.end());
            }}
          />
        </div>
      </motion.div>
    </section>
  );
}
