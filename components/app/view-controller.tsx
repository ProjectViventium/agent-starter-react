'use client';

import { ConnectionState } from 'livekit-client';
import { AnimatePresence, motion } from 'motion/react';
import { useSessionContext } from '@livekit/components-react';
import type { AppConfig } from '@/app-config';
import { SessionView } from '@/components/app/session-view';
import { WelcomeView } from '@/components/app/welcome-view';
import type { AssistantRouteInfo } from '@/hooks/useCallSessionVoiceSettings';
import type { VoiceRouteMetadata, VoiceRouteState } from '@/hooks/useVoiceRoute';

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
  wingModeEnabled?: boolean;
  wingModePending?: boolean;
  onWingModeChange?: (enabled: boolean) => void;
  assistantRoute?: AssistantRouteInfo | null;
  voiceRoute: VoiceRouteMetadata;
  requestedVoiceRoute: VoiceRouteState;
  onRequestedVoiceRouteChange: (nextState: VoiceRouteState) => Promise<boolean> | void;
  voiceRouteLoading?: boolean;
  voiceRouteSaving?: boolean;
  voiceRouteError?: string | null;
  voiceRouteNotice?: string | null;
}

export function ViewController({
  appConfig,
  canStartCall,
  startHint,
  startButtonText,
  onStartCall,
  wingModeEnabled,
  wingModePending,
  onWingModeChange,
  assistantRoute,
  voiceRoute,
  requestedVoiceRoute,
  onRequestedVoiceRouteChange,
  voiceRouteLoading,
  voiceRouteSaving,
  voiceRouteError,
  voiceRouteNotice,
}: ViewControllerProps) {
  const { isConnected, connectionState } = useSessionContext();
  const showSessionView = isConnected || connectionState !== ConnectionState.Disconnected;

  return (
    <AnimatePresence mode="wait">
      {/* Welcome view */}
      {!showSessionView && (
        <MotionWelcomeView
          key="welcome"
          {...VIEW_MOTION_PROPS}
          startButtonText={
            startButtonText ?? (canStartCall ? appConfig.startButtonText : 'Open from Viventium')
          }
          onStartCall={onStartCall}
          startDisabled={!canStartCall}
          helperText={startHint}
          voiceRoute={voiceRoute}
          requestedVoiceRoute={requestedVoiceRoute}
          onRequestedVoiceRouteChange={onRequestedVoiceRouteChange}
          voiceRouteLoading={voiceRouteLoading}
          voiceRouteSaving={voiceRouteSaving}
          voiceRouteError={voiceRouteError}
          voiceRouteNotice={voiceRouteNotice}
        />
      )}
      {/* Session view */}
      {showSessionView && (
        <MotionSessionView
          key="session-view"
          {...VIEW_MOTION_PROPS}
          appConfig={appConfig}
          wingModeEnabled={wingModeEnabled}
          wingModePending={wingModePending}
          onWingModeChange={onWingModeChange}
          assistantRoute={assistantRoute}
          requestedVoiceRoute={requestedVoiceRoute}
          onRequestedVoiceRouteChange={onRequestedVoiceRouteChange}
          voiceRouteLoading={voiceRouteLoading}
          voiceRouteSaving={voiceRouteSaving}
          voiceRouteError={voiceRouteError}
        />
      )}
    </AnimatePresence>
  );
}
