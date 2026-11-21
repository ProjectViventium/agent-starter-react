import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReceivedMessage } from '@livekit/components-react';
import { render, screen } from '@testing-library/react';
import {
  CallTranscript,
  transcriptDisplayText,
  transcriptMessages,
} from '@/components/app/call-transcript';
import type { SpeakerSegmentV1 } from '@/lib/voice-events';

// The scroller needs a real layout; here it is replaced by plain containers that report
// where the reader is.
const scrollable = vi.hoisted(() => ({ start: true, end: true }));
vi.mock('@/components/ui/message-scroller', () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    MessageScrollerProvider: Box,
    MessageScroller: Box,
    MessageScrollerViewport: Box,
    MessageScrollerContent: Box,
    MessageScrollerItem: Box,
    MessageScrollerButton: () => null,
    useMessageScrollerScrollable: () => scrollable,
  };
});
vi.mock('@/components/agents-ui/agent-chat-indicator', () => ({ AgentChatIndicator: () => null }));

function message(changed: Partial<ReceivedMessage> & { local?: boolean }): ReceivedMessage {
  const { local = false, ...rest } = changed;
  return {
    id: 'message-1',
    timestamp: 0,
    type: local ? 'userTranscript' : 'agentTranscript',
    message: 'Hello.',
    from: { isLocal: local, identity: local ? 'owner' : 'agent' },
    ...rest,
  } as ReceivedMessage;
}

function segment(changed: Partial<SpeakerSegmentV1> = {}): SpeakerSegmentV1 {
  return {
    version: 1,
    segmentId: 'segment-1',
    callSessionId: 'call-1',
    turnId: 'turn-1',
    sequence: 1,
    revision: 1,
    text: 'We should ship this carefully.',
    isFinal: true,
    speaker: {
      key: 'speaker-1',
      label: 'Speaker 1',
      source: 'provider_diarization',
      attribution: 'unverified',
      actorTrust: 'shared_mic_unverified',
    },
    ...changed,
  };
}

function paging(changed = {}) {
  return {
    hasOlder: false,
    loadingOlder: false,
    onLoadOlder: vi.fn(),
    hasNewer: false,
    loadingNewer: false,
    onLoadNewer: vi.fn(),
    ...changed,
  };
}

afterEach(() => {
  scrollable.start = true;
  scrollable.end = true;
});

describe('text cleaning', () => {
  it('removes citation markers from every message', () => {
    const text = 'The price rose \\ue202turn0search0 today.';
    expect(transcriptDisplayText(message({ local: true, message: text }))).not.toContain('turn0');
    expect(transcriptDisplayText(message({ message: text }))).not.toContain('turn0');
  });

  it('removes voice-control tags from the assistant only', () => {
    const text = '[laughs] That is funny.';
    expect(transcriptDisplayText(message({ message: text })).trim()).toBe('That is funny.');
    expect(transcriptDisplayText(message({ local: true, message: text }))).toBe(text);
  });
});

describe('which messages are listed', () => {
  const all = [
    message({ id: 'user-speech', local: true }),
    message({ id: 'user-typed', local: true, type: 'chatMessage' }),
    message({ id: 'assistant' }),
  ];

  it('lists everything while there is no speaker transcript', () => {
    expect(transcriptMessages(all, false)).toHaveLength(3);
  });

  it("leaves the user's own speech to the speaker transcript once there is one", () => {
    expect(transcriptMessages(all, true).map((item) => item.id)).toEqual([
      'user-typed',
      'assistant',
    ]);
  });
});

describe('CallTranscript', () => {
  it('shows cleaned messages with safe links, then who said what', () => {
    const { container } = render(
      <CallTranscript
        messages={[
          message({
            message: '[whispers] See [the report](https://docs.example.test/report) <img src=x>',
          }),
          message({ id: 'user-speech', local: true, message: 'This line is in the speaker list.' }),
        ]}
        speakerSegments={[segment()]}
      />
    );
    expect(screen.getByRole('link', { name: 'the report' })).toHaveAttribute(
      'href',
      'https://docs.example.test/report'
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).not.toContain('[whispers]');
    expect(screen.queryByText('This line is in the speaker list.')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Speaker transcript' })).toHaveTextContent(
      'We should ship this carefully.'
    );
  });

  it('shows the Thinking marker while the assistant thinks', () => {
    render(<CallTranscript agentState="thinking" messages={[]} speakerSegments={[]} />);
    expect(screen.getByRole('status')).toHaveTextContent('Thinking...');
  });

  it('asks for earlier speech at the top and later speech at the bottom', () => {
    scrollable.start = false;
    scrollable.end = true;
    const top = paging({ hasOlder: true, hasNewer: true });
    const { unmount } = render(
      <CallTranscript messages={[]} speakerSegments={[segment()]} speakerPaging={top} />
    );
    expect(top.onLoadOlder).toHaveBeenCalledOnce();
    expect(top.onLoadNewer).not.toHaveBeenCalled();
    unmount();

    scrollable.start = true;
    scrollable.end = false;
    const bottom = paging({ hasOlder: true, hasNewer: true });
    render(<CallTranscript messages={[]} speakerSegments={[segment()]} speakerPaging={bottom} />);
    expect(bottom.onLoadNewer).toHaveBeenCalledOnce();
    expect(bottom.onLoadOlder).not.toHaveBeenCalled();
  });

  it('does not ask again while a page is loading or when there is nothing more', () => {
    scrollable.start = false;
    scrollable.end = false;
    const loading = paging({ hasOlder: true, loadingOlder: true, hasNewer: false });
    render(<CallTranscript messages={[]} speakerSegments={[segment()]} speakerPaging={loading} />);
    expect(loading.onLoadOlder).not.toHaveBeenCalled();
    expect(loading.onLoadNewer).not.toHaveBeenCalled();
    expect(screen.getByText('Loading earlier speakers…')).toBeInTheDocument();
  });
});
