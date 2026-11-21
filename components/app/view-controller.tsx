'use client';

/*
 * Start screen or call screen (CP-CMP-012, 013). Upstream's view controller with three
 * Viventium rules: the call screen shows as soon as connecting begins, the "Open in chat" link
 * stays on top of both screens, and with "reduce motion" the switch is instant.
 */
import { type ReactNode, useCallback, useState } from 'react';
import { useTheme } from 'next-themes';
import { ConnectionState } from 'livekit-client';
import { AnimatePresence, type MotionProps, motion, useReducedMotion } from 'motion/react';
import { useSessionContext } from '@livekit/components-react';
import { useCall } from '@/components/app/call-context';
import { LinkedChatLink } from '@/components/app/linked-chat-link';
import { SessionView } from '@/components/app/session-view';
import { WelcomeView } from '@/components/app/welcome-view';
import { retainedLinkedChatHref } from '@/lib/call-handoff';
import type { CallIssue } from '@/lib/call-start';

const MotionWelcomeView = motion.create(WelcomeView);
const MotionSessionView = motion.create(SessionView);

const VIEW_MOTION: MotionProps = {
  variants: { visible: { opacity: 1 }, hidden: { opacity: 0 } },
  initial: 'hidden',
  animate: 'visible',
  exit: 'hidden',
  transition: { duration: 0.5, ease: 'linear' },
};

const INSTANT_MOTION: MotionProps = {
  variants: VIEW_MOTION.variants,
  initial: false,
  animate: 'visible',
  exit: 'visible',
  transition: { duration: 0 },
};

/** What the start screen shows; derived in one place (`App`). */
export type StartScreenState = {
  buttonText: string;
  disabled: boolean;
  helperText?: string;
  issue?: CallIssue | null;
  ended: boolean;
};

interface ViewControllerProps {
  start: StartScreenState;
  startupPending: boolean;
  onStartCall: () => void;
  onRetry: () => void;
  onCallEnding: () => void;
  onCallEnded: () => void;
  isVideoInputSupported: boolean;
  /** The voice picker button: on the start screen and in the call's control bar. */
  picker?: ReactNode;
}

export function ViewController({
  start,
  startupPending,
  onStartCall,
  onRetry,
  onCallEnding,
  onCallEnded,
  isVideoInputSupported,
  picker,
}: ViewControllerProps) {
  const { callSessionId, conversationId, mode } = useCall();
  const { isConnected, connectionState } = useSessionContext();
  const { resolvedTheme } = useTheme();
  const reducedMotion = useReducedMotion();
  const viewMotion = reducedMotion ? INSTANT_MOTION : VIEW_MOTION;

  // A finished result can tell the page which chat the call belongs to (a call from a new chat).
  const [linkedChat, setLinkedChat] = useState<{
    callSessionId: string | null;
    href: string | null;
  } | null>(null);
  const onLinkedChatHrefChange = useCallback(
    (href: string | null) => {
      if (callSessionId && href) retainedLinkedChatHref(callSessionId, href);
      setLinkedChat((current) =>
        current?.callSessionId === callSessionId && current.href === href
          ? current
          : { callSessionId, href }
      );
    },
    [callSessionId]
  );
  const linkedChatHref = linkedChat?.callSessionId === callSessionId ? linkedChat.href : null;
  const showSessionView = isConnected || connectionState !== ConnectionState.Disconnected;

  return (
    <>
      <LinkedChatLink
        callSessionId={callSessionId}
        conversationId={conversationId}
        href={linkedChatHref}
      />
      <AnimatePresence mode="wait">
        {!showSessionView && (
          <MotionWelcomeView
            key="welcome"
            {...viewMotion}
            startButtonText={start.buttonText}
            onStartCall={onStartCall}
            startDisabled={start.disabled}
            helperText={start.issue ? undefined : start.helperText}
            callIssue={start.issue}
            onRetry={onRetry}
            callEnded={start.ended}
            mode={mode}
            picker={picker}
          />
        )}
        {showSessionView && (
          <MotionSessionView
            key="session-view"
            {...viewMotion}
            startupPending={startupPending}
            callIssue={start.issue}
            onIssueRetry={onRetry}
            onCallEnding={onCallEnding}
            onCallEnded={onCallEnded}
            onLinkedChatHrefChange={onLinkedChatHrefChange}
            supportsVideoInput={isVideoInputSupported}
            themeMode={resolvedTheme === 'dark' ? 'dark' : 'light'}
            controlBarTrailing={picker}
            className="fixed inset-0"
          />
        )}
      </AnimatePresence>
    </>
  );
}
