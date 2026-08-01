'use client';

import React, { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { useRemoteParticipants, useSessionContext } from '@livekit/components-react';
import type { AppConfig } from '@/app-config';
import { ChatTranscript } from '@/components/app/chat-transcript';
import { PreConnectMessage } from '@/components/app/preconnect-message';
import { TileLayout } from '@/components/app/tile-layout';
import {
  AgentControlBar,
  type ControlBarControls,
} from '@/components/livekit/agent-control-bar/agent-control-bar';
import type { AssistantRouteInfo } from '@/hooks/useCallSessionVoiceSettings';
import { useMicrophoneHealth } from '@/hooks/useMicrophoneHealth';
import { useViventiumSessionMessages } from '@/hooks/useViventiumSessionMessages';
import type { VoiceRouteState } from '@/hooks/useVoiceRoute';
import { cn } from '@/lib/utils';
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
  onEndCall: () => void;
  wingModeEnabled?: boolean;
  wingModePending?: boolean;
  onWingModeChange?: (enabled: boolean) => void;
  listenOnlyModeEnabled?: boolean;
  listenOnlyModePending?: boolean;
  onListenOnlyModeChange?: (enabled: boolean) => void;
  assistantRoute?: AssistantRouteInfo | null;
  requestedVoiceRoute: VoiceRouteState;
  onRequestedVoiceRouteChange: (nextState: VoiceRouteState) => Promise<boolean> | void;
  voiceRouteLoading?: boolean;
  voiceRouteSaving?: boolean;
  voiceRouteError?: string | null;
}

export const SessionView = ({
  appConfig,
  onEndCall,
  wingModeEnabled = false,
  wingModePending = false,
  onWingModeChange,
  listenOnlyModeEnabled = false,
  listenOnlyModePending = false,
  onListenOnlyModeChange,
  assistantRoute,
  requestedVoiceRoute,
  onRequestedVoiceRouteChange,
  voiceRouteLoading,
  voiceRouteSaving,
  voiceRouteError,
  ...props
}: React.ComponentProps<'section'> & SessionViewProps) => {
  const session = useSessionContext();
  const { messages } = useViventiumSessionMessages(session);
  const participants = useRemoteParticipants();
  const [chatOpen, setChatOpen] = useState(false);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const { isInputBlocked } = useMicrophoneHealth();
  const isAgentAvailable = participants.some((participant) => participant.isAgent);

  const controls: ControlBarControls = {
    leave: true,
    microphone: true,
    chat: appConfig.supportsChatInput,
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
    ? listenOnlyModeEnabled
      ? 'Viventium is here with you, just listening and remembering alongside you.'
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
        <ScrollArea ref={scrollAreaRef} className="px-4 pt-40 pb-[150px] md:px-6 md:pb-[200px]">
          <ChatTranscript
            hidden={!chatOpen}
            messages={messages}
            className="mx-auto max-w-2xl space-y-3 transition-opacity duration-300 ease-out"
          />
        </ScrollArea>
      </div>

      {/* Tile Layout */}
      <TileLayout chatOpen={chatOpen} />

      {/* Bottom */}
      <MotionBottom
        {...BOTTOM_VIEW_MOTION_PROPS}
        className="fixed inset-x-3 bottom-0 z-50 md:inset-x-12"
      >
        {appConfig.isPreConnectBufferEnabled && (
          <PreConnectMessage messages={messages} message={preConnectMessage} className="pb-4" />
        )}
        <div className="bg-background relative mx-auto max-w-2xl pb-3 md:pb-12">
          <Fade bottom className="absolute inset-x-0 top-0 h-4 -translate-y-full" />
          <AgentControlBar
            appConfig={appConfig}
            controls={controls}
            isConnected={session.isConnected}
            onDisconnect={onEndCall}
            onChatOpenChange={setChatOpen}
            wingModeEnabled={wingModeEnabled}
            wingModePending={wingModePending}
            onWingModeChange={onWingModeChange}
            listenOnlyModeEnabled={listenOnlyModeEnabled}
            listenOnlyModePending={listenOnlyModePending}
            onListenOnlyModeChange={onListenOnlyModeChange}
            assistantRoute={assistantRoute}
            requestedVoiceRoute={requestedVoiceRoute}
            onRequestedVoiceRouteChange={onRequestedVoiceRouteChange}
            voiceRouteEditingDisabled
            voiceRouteLoading={voiceRouteLoading}
            voiceRouteSaving={voiceRouteSaving}
            voiceRouteError={voiceRouteError}
          />
        </div>
      </MotionBottom>
    </section>
  );
};
