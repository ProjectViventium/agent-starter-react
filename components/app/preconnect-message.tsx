'use client';

import { AnimatePresence, motion } from 'motion/react';
import { type ReceivedMessage } from '@livekit/components-react';
import { ShimmerText } from '@/components/livekit/shimmer-text';
import { cn } from '@/lib/utils';

const MotionMessage = motion.create('p');

const VIEW_MOTION_PROPS = {
  variants: {
    visible: {
      opacity: 1,
      transition: {
        ease: 'easeIn',
        duration: 0.5,
        delay: 0.8,
      },
    },
    hidden: {
      opacity: 0,
      transition: {
        ease: 'easeIn',
        duration: 0.5,
        delay: 0,
      },
    },
  },
  initial: 'hidden',
  animate: 'visible',
  exit: 'hidden',
};

interface PreConnectMessageProps {
  messages?: ReceivedMessage[];
  className?: string;
  message?: string;
}

export function resolvePreConnectMessage(message?: string | null) {
  const trimmed = typeof message === 'string' ? message.trim() : '';
  if (trimmed) {
    return trimmed;
  }
  return 'Agent is listening, ask it a question';
}

export function PreConnectMessage({ className, message, messages = [] }: PreConnectMessageProps) {
  return (
    <AnimatePresence>
      {messages.length === 0 && (
        <MotionMessage
          {...VIEW_MOTION_PROPS}
          aria-hidden={messages.length > 0}
          className={cn('pointer-events-none text-center', className)}
        >
          <ShimmerText className="text-sm font-semibold">
            {resolvePreConnectMessage(message)}
          </ShimmerText>
        </MotionMessage>
      )}
    </AnimatePresence>
  );
}
