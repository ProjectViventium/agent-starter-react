'use client';

import { ConnectionState } from 'livekit-client';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useSessionContext } from '@livekit/components-react';
import type { AppConfig } from '@/app-config';
import { SessionView } from '@/components/app/session-view';
import { WelcomeView } from '@/components/app/welcome-view';
import type { VoiceCallMode } from '@/hooks/useCallSessionState';
import type { CallIssue } from '@/lib/call-start';
import type { VoiceCallStatus } from '@/lib/call-state';

// VIVENTIUM START
// Purpose: Viventium agent-starter customization.
// Details: docs/requirements_and_learnings/05_Open_Source_Modifications.md#agent-starter-react
// VIVENTIUM END

const MotionWelcomeView = motion.create(WelcomeView);
const MotionSessionView = motion.create(SessionView);

const VIEW_MOTION_PROPS = {
  variants: {
    visible: {
      opacity: 1,
    },
    hidden: {
      opacity: 0,
    },
  },
  initial: 'hidden',
  animate: 'visible',
  exit: 'hidden',
  transition: {
    duration: 0.5,
    ease: 'linear',
  },
};

interface ViewControllerProps {
  appConfig: AppConfig;
  canStartCall: boolean;
  startHint?: string;
  startButtonText?: string;
  onStartCall: () => void;
  callSessionId: string | null;
  conversationId?: string | null;
  mode?: VoiceCallMode;
  authoritativeStatus?: VoiceCallStatus | null;
  modePending?: boolean;
  onModeChange?: (mode: VoiceCallMode) => void;
  callStateError?: string | null;
  onCallEnded?: () => void;
  onCallEnding?: () => void;
  callIssue?: CallIssue | null;
  onRetry?: () => void;
  audioRecoveryRequired?: boolean;
  onAudioRecovery?: () => void;
  callEnded?: boolean;
}

export function ViewController({
  appConfig,
  canStartCall,
  startHint,
  startButtonText,
  onStartCall,
  callSessionId,
  conversationId,
  mode,
  authoritativeStatus,
  modePending,
  onModeChange,
  callStateError,
  onCallEnded,
  onCallEnding,
  callIssue,
  onRetry,
  audioRecoveryRequired,
  onAudioRecovery,
  callEnded = false,
}: ViewControllerProps) {
  const { isConnected, connectionState } = useSessionContext();
  const reducedMotion = useReducedMotion();
  const showSessionView = isConnected || connectionState !== ConnectionState.Disconnected;
  const viewMotionProps = reducedMotion
    ? { initial: false as const, animate: 'visible', exit: 'visible', transition: { duration: 0 } }
    : VIEW_MOTION_PROPS;

  return (
    <AnimatePresence mode="wait">
      {/* Welcome view */}
      {!showSessionView && (
        <MotionWelcomeView
          key="welcome"
          {...viewMotionProps}
          startButtonText={
            startButtonText ?? (canStartCall ? appConfig.startButtonText : 'Open from Viventium')
          }
          onStartCall={onStartCall}
          startDisabled={!canStartCall}
          helperText={callIssue ? undefined : startHint}
          callIssue={callIssue}
          onRetry={onRetry}
          callEnded={callEnded}
          mode={mode}
        />
      )}
      {/* Session view */}
      {showSessionView && (
        <MotionSessionView
          key="session-view"
          {...viewMotionProps}
          appConfig={appConfig}
          callSessionId={callSessionId}
          conversationId={conversationId}
          mode={mode}
          authoritativeStatus={authoritativeStatus}
          modePending={modePending}
          onModeChange={onModeChange}
          callStateError={callStateError}
          onCallEnded={onCallEnded}
          onCallEnding={onCallEnding}
          callIssue={callIssue}
          onIssueRetry={onRetry}
          audioRecoveryRequired={audioRecoveryRequired}
          onAudioRecovery={onAudioRecovery}
        />
      )}
    </AnimatePresence>
  );
}
