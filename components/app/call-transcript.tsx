'use client';

/*
 * The transcript of a Viventium call (CP-CMP-029, 031, 032, 033).
 *
 * A Viventium variant of the base's `AgentChatTranscript` (same scroller, message and bubble
 * primitives; scrolling, "scroll to end" and the Thinking marker are the base's). What differs:
 * - message text is cleaned for display (citation markers; for the assistant also internal
 *   artefacts and voice-control tags) and shown as safe text with links (`TranscriptText`),
 *   not through the markdown renderer;
 * - the speaker transcript (who said what) follows the messages, and reaching either end of the
 *   transcript asks for earlier or later speech.
 */
import { useEffect } from 'react';
import { type AgentState, type ReceivedMessage } from '@livekit/components-react';
import { AgentChatIndicator } from '@/components/agents-ui/agent-chat-indicator';
import { SpeakerTranscript } from '@/components/app/speaker-transcript';
import { TranscriptText } from '@/components/app/transcript-text';
import { Bubble, BubbleContent } from '@/components/ui/bubble';
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker';
import { Message, MessageContent } from '@/components/ui/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScrollerScrollable,
} from '@/components/ui/message-scroller';
import {
  stripCitations,
  stripInternalArtifactsForDisplay,
  stripVoiceControlTagsForDisplay,
} from '@/lib/citations';
import type { SpeakerSegmentV1 } from '@/lib/voice-events';

/** The text of a message as the transcript shows it. */
export function transcriptDisplayText(message: ReceivedMessage): string {
  return message.from?.isLocal
    ? stripCitations(message.message)
    : stripVoiceControlTagsForDisplay(
        stripInternalArtifactsForDisplay(stripCitations(message.message))
      );
}

/**
 * The messages the transcript lists. Once the call has a speaker transcript, the user's own
 * speech is shown there (with the speaker's name), so it is left out here to avoid showing it
 * twice.
 */
export function transcriptMessages(
  messages: ReceivedMessage[],
  hasSpeakerTranscript: boolean
): ReceivedMessage[] {
  return hasSpeakerTranscript
    ? messages.filter((message) => message.type !== 'userTranscript')
    : messages;
}

export type SpeakerPaging = {
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  hasNewer: boolean;
  loadingNewer: boolean;
  onLoadNewer: () => void;
};

/** Asks for earlier or later speech when the reader is at the top or bottom of the transcript. */
function SpeakerPagingAtEdges({
  hasOlder,
  loadingOlder,
  onLoadOlder,
  hasNewer,
  loadingNewer,
  onLoadNewer,
}: SpeakerPaging) {
  const scrollable = useMessageScrollerScrollable();
  useEffect(() => {
    if (!scrollable.start && hasOlder && !loadingOlder) onLoadOlder();
  }, [scrollable.start, hasOlder, loadingOlder, onLoadOlder]);
  useEffect(() => {
    if (!scrollable.end && hasNewer && !loadingNewer) onLoadNewer();
  }, [scrollable.end, hasNewer, loadingNewer, onLoadNewer]);
  return null;
}

function TranscriptMessage({ message }: { message: ReceivedMessage }) {
  const isUser = message.from?.isLocal === true;
  const locale = typeof navigator !== 'undefined' ? navigator.language : 'en-US';
  const title = new Date(message.timestamp).toLocaleTimeString(locale, { timeStyle: 'full' });
  return (
    <Message align={isUser ? 'end' : 'start'} title={title}>
      <MessageContent>
        <Bubble align={isUser ? 'end' : 'start'} variant={isUser ? 'secondary' : 'ghost'}>
          <BubbleContent className="whitespace-pre-line">
            <TranscriptText text={transcriptDisplayText(message)} />
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  );
}

export interface CallTranscriptProps {
  agentState?: AgentState;
  messages: ReceivedMessage[];
  speakerSegments: SpeakerSegmentV1[];
  speakerPaging?: SpeakerPaging;
  className?: string;
}

export function CallTranscript({
  agentState,
  messages,
  speakerSegments,
  speakerPaging,
  className,
}: CallTranscriptProps) {
  const visibleMessages = transcriptMessages(messages, speakerSegments.length > 0);
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
      {speakerPaging ? <SpeakerPagingAtEdges {...speakerPaging} /> : null}
      <MessageScroller className={className}>
        <MessageScrollerViewport preserveScrollOnPrepend>
          <MessageScrollerContent aria-busy={agentState === 'thinking'} className="gap-3">
            {visibleMessages.map((message) => (
              <MessageScrollerItem key={message.id} messageId={message.id}>
                <TranscriptMessage message={message} />
              </MessageScrollerItem>
            ))}

            <SpeakerTranscript
              segments={speakerSegments}
              loadingOlder={speakerPaging?.loadingOlder}
              loadingNewer={speakerPaging?.loadingNewer}
            />

            {agentState === 'thinking' && (
              <MessageScrollerItem>
                <Marker role="status">
                  <MarkerIcon>
                    <AgentChatIndicator size="sm" />
                  </MarkerIcon>
                  <MarkerContent className="shimmer">Thinking...</MarkerContent>
                </Marker>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>

        <MessageScrollerButton variant="outline" className="rounded-full" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}
