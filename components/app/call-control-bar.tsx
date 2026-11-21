'use client';

/*
 * The control bar of a Viventium call (CP-CMP-037, 034, 019, 024).
 *
 * A Viventium variant of the base's `AgentControlBar` in its "livekit" look, built from the same
 * parts (`AgentTrackControl`, `AgentTrackToggle`, `Toggle`, `Button`). The base's bar has no
 * place for extra controls, so this copy adds what a Viventium call needs:
 * - the Call / Wing / Listen-Only switch;
 * - the microphone choice is remembered for this call (`useCallInputControls`);
 * - the microphone button is locked while the call is still starting;
 * - typing is offered only once the assistant has joined, and not at all in Listen-Only;
 * - the transcript button is always there (Listen-Only shows who said what);
 * - End only reports the click: the call screen ends the call on the server first.
 */
import { type ComponentProps, type ReactNode, useEffect, useRef, useState } from 'react';
import { Track } from 'livekit-client';
import { Loader, MessageSquareTextIcon, PhoneOffIcon, SendHorizontal } from 'lucide-react';
import { type MotionProps, motion } from 'motion/react';
import { useChat } from '@livekit/components-react';
import { AgentTrackControl } from '@/components/agents-ui/agent-track-control';
import {
  AgentTrackToggle,
  agentTrackToggleVariants,
} from '@/components/agents-ui/agent-track-toggle';
import { CallModeControl } from '@/components/app/call-mode-control';
import { Button } from '@/components/ui/button';
import { Toggle } from '@/components/ui/toggle';
import { usePublishPermissions } from '@/hooks/agents-ui/use-agent-control-bar';
import { useCallInputControls } from '@/hooks/useCallInputControls';
import type { VoiceCallMode } from '@/hooks/useCallSessionState';
import { cn } from '@/lib/shadcn/utils';

// The base's "livekit" look for the device buttons (same classes as `AgentControlBar`).
const TRACK_CONTROL_LOOK = [
  'data-[state=off]:bg-accent data-[state=off]:hover:bg-foreground/10',
  'data-[state=off]:[&_~_button]:bg-accent data-[state=off]:[&_~_button]:hover:bg-foreground/10',
  'data-[state=off]:border-border data-[state=off]:hover:border-foreground/12',
  'data-[state=off]:[&_~_button]:border-border data-[state=off]:[&_~_button]:hover:border-foreground/12',
  'data-[state=off]:text-destructive data-[state=off]:hover:text-destructive data-[state=off]:focus:text-destructive',
  'data-[state=off]:focus-visible:ring-foreground/12 data-[state=off]:focus-visible:border-ring',
  'dark:data-[state=off]:[&_~_button]:bg-accent dark:data-[state=off]:[&_~_button]:hover:bg-foreground/10',
  'rounded-full [&_button:first-child]:rounded-l-full [&_button:last-child]:rounded-r-full',
];

const TOGGLE_LOOK = [
  'data-[state=off]:bg-accent data-[state=off]:hover:bg-foreground/10',
  'data-[state=off]:border-border data-[state=off]:hover:border-foreground/12',
  'data-[state=off]:focus-visible:border-ring data-[state=off]:focus-visible:ring-foreground/12',
  'data-[state=off]:text-foreground data-[state=off]:hover:text-foreground data-[state=off]:focus:text-foreground',
  'data-[state=on]:bg-blue-500/20 data-[state=on]:hover:bg-blue-500/30',
  'data-[state=on]:border-blue-700/10 data-[state=on]:text-blue-700 data-[state=on]:ring-blue-700/30',
  'data-[state=on]:focus-visible:border-blue-700/50',
  'dark:data-[state=on]:bg-blue-500/20 dark:data-[state=on]:text-blue-300',
  'rounded-full',
];

const CHAT_ROW_MOTION: MotionProps = {
  variants: {
    hidden: { height: 0, opacity: 0, marginBottom: 0 },
    visible: { height: 'auto', opacity: 1, marginBottom: 12 },
  },
  initial: 'hidden',
  transition: { duration: 0.3, ease: 'easeOut' },
};

function CallChatInput({
  open,
  disabled,
  onSend,
}: {
  open: boolean;
  /** The assistant has not joined yet. */
  disabled: boolean;
  onSend: (message: string) => Promise<unknown>;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [isSending, setIsSending] = useState(false);
  const [message, setMessage] = useState('');
  const cannotSend = disabled || isSending || message.trim().length === 0;

  const send = async () => {
    if (cannotSend) return;
    try {
      setIsSending(true);
      await onSend(message.trim());
      setMessage('');
    } catch (error) {
      console.error(error);
    } finally {
      setIsSending(false);
    }
  };

  useEffect(() => {
    if (open && !disabled) inputRef.current?.focus();
  }, [open, disabled]);

  return (
    <div className="mb-3 flex grow items-end gap-2 rounded-md pl-1 text-sm">
      <textarea
        ref={inputRef}
        value={message}
        aria-label="Message"
        disabled={!open || disabled || isSending}
        placeholder={disabled ? 'Waiting for Viventium...' : 'Type something...'}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void send();
          }
        }}
        onChange={(event) => setMessage(event.target.value)}
        // 16 px text on phones, so iOS does not zoom into the field.
        className="field-sizing-content max-h-16 min-h-8 min-w-0 flex-1 resize-none [scrollbar-width:thin] py-2 text-base focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
      />
      <Button
        size="icon"
        type="button"
        disabled={cannotSend}
        variant={cannotSend ? 'secondary' : 'default'}
        aria-label={isSending ? 'Sending' : 'Send'}
        onClick={() => void send()}
        className="self-end rounded-full disabled:cursor-not-allowed"
      >
        {isSending ? (
          <Loader className="animate-spin motion-reduce:animate-none" />
        ) : (
          <SendHorizontal />
        )}
      </Button>
    </div>
  );
}

export interface CallControlBarControls {
  microphone?: boolean;
  camera?: boolean;
  screenShare?: boolean;
  /** Typed messages. The transcript button does not depend on it. */
  chat?: boolean;
  leave?: boolean;
}

export interface CallControlBarProps {
  callSessionId: string | null;
  controls?: CallControlBarControls;
  isConnected: boolean;
  /** The assistant is in the room. */
  isAgentAvailable: boolean;
  /** The call is still starting: the microphone button waits. */
  startupPending?: boolean;
  isChatOpen: boolean;
  onIsChatOpenChange: (open: boolean) => void;
  mode: VoiceCallMode;
  modePending: boolean;
  onModeChange?: (mode: VoiceCallMode) => void;
  /** Extra controls shown beside the device buttons (the provider picker button). */
  trailing?: ReactNode;
  onDisconnect: () => void;
  onDeviceError?: (error: { source: Track.Source; error: Error }) => void;
}

export function CallControlBar({
  callSessionId,
  controls,
  isConnected,
  isAgentAvailable,
  startupPending = false,
  isChatOpen,
  onIsChatOpenChange,
  mode,
  modePending,
  onModeChange,
  trailing,
  onDisconnect,
  onDeviceError,
  className,
  ...props
}: CallControlBarProps & Omit<ComponentProps<'div'>, 'children'>) {
  const { send } = useChat();
  const publishPermissions = usePublishPermissions();
  const {
    microphoneTrack,
    cameraToggle,
    microphoneToggle,
    screenShareToggle,
    handleAudioDeviceChange,
    handleVideoDeviceChange,
    handleMicrophoneDeviceSelectError,
    handleCameraDeviceSelectError,
  } = useCallInputControls({ onDeviceError, callSessionId });

  const listenOnly = mode === 'listen_only';
  const visible = {
    leave: controls?.leave ?? true,
    microphone: controls?.microphone ?? publishPermissions.microphone,
    screenShare: controls?.screenShare ?? publishPermissions.screenShare,
    camera: controls?.camera ?? publishPermissions.camera,
    chat: (controls?.chat ?? publishPermissions.data) && !listenOnly,
  };

  return (
    <div
      aria-label="Voice assistant controls"
      className={cn(
        'bg-background border-input/50 dark:border-muted flex flex-col rounded-[31px] border p-3 drop-shadow-md/3',
        className
      )}
      {...props}
    >
      {visible.chat && (
        <motion.div
          {...CHAT_ROW_MOTION}
          inert={!isChatOpen}
          animate={isChatOpen ? 'visible' : 'hidden'}
          className="border-input/50 flex w-full items-start overflow-hidden border-b"
        >
          <CallChatInput
            open={isChatOpen}
            disabled={!isAgentAvailable}
            onSend={(message) => send(message)}
          />
        </motion.div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {onModeChange ? (
          <CallModeControl
            mode={mode}
            pending={modePending}
            onModeChange={onModeChange}
            className="w-full"
          />
        ) : null}

        <div className="flex min-w-0 grow flex-wrap items-center gap-1">
          {visible.microphone && (
            <AgentTrackControl
              kind="audioinput"
              aria-label="Toggle microphone"
              source={Track.Source.Microphone}
              pressed={microphoneToggle.enabled}
              disabled={startupPending || microphoneToggle.pending}
              audioTrack={microphoneTrack}
              onPressedChange={microphoneToggle.toggle}
              onActiveDeviceChange={handleAudioDeviceChange}
              onMediaDeviceError={handleMicrophoneDeviceSelectError}
              className={cn(TRACK_CONTROL_LOOK)}
            />
          )}

          {visible.camera && (
            <AgentTrackControl
              kind="videoinput"
              aria-label="Toggle camera"
              source={Track.Source.Camera}
              pressed={cameraToggle.enabled}
              pending={cameraToggle.pending}
              disabled={cameraToggle.pending}
              onPressedChange={cameraToggle.toggle}
              onMediaDeviceError={handleCameraDeviceSelectError}
              onActiveDeviceChange={handleVideoDeviceChange}
              className={cn(TRACK_CONTROL_LOOK)}
            />
          )}

          {visible.screenShare && (
            <AgentTrackToggle
              aria-label="Toggle screen share"
              source={Track.Source.ScreenShare}
              pressed={screenShareToggle.enabled}
              disabled={screenShareToggle.pending}
              onPressedChange={screenShareToggle.toggle}
              className={cn(TOGGLE_LOOK)}
            />
          )}

          <Toggle
            pressed={isChatOpen}
            aria-label="Toggle transcript"
            onPressedChange={onIsChatOpenChange}
            className={agentTrackToggleVariants({ variant: 'default', className: cn(TOGGLE_LOOK) })}
          >
            <MessageSquareTextIcon />
          </Toggle>

          {trailing}
        </div>

        {visible.leave && (
          <Button
            variant="destructive"
            aria-label="End call"
            onClick={onDisconnect}
            disabled={!isConnected}
            className="bg-destructive/10 dark:bg-destructive/10 text-destructive hover:bg-destructive/20 dark:hover:bg-destructive/20 focus:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/4 ml-auto rounded-full font-mono text-xs font-bold tracking-wider"
          >
            <PhoneOffIcon />
            <span className="hidden uppercase md:inline">End call</span>
          </Button>
        )}
      </div>
    </div>
  );
}
