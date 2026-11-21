import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { type CallContextValue, CallProvider } from '@/components/app/call-context';
import { LinkedChatLink } from '@/components/app/linked-chat-link';
import { ViewController } from '@/components/app/view-controller';

const CAPABILITY = 'c'.repeat(43);
const state = vi.hoisted(() => ({
  connectionState: 'disconnected',
  reportChatHref: null as ((href: string | null) => void) | null,
}));

vi.mock('@livekit/components-react', () => ({
  useSessionContext: () => ({
    isConnected: state.connectionState === 'connected',
    connectionState: state.connectionState,
  }),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'light' }) }));
vi.mock('@/components/app/session-view', () => ({
  SessionView: ({
    onLinkedChatHrefChange,
  }: {
    onLinkedChatHrefChange?: (href: string | null) => void;
  }) => {
    state.reportChatHref = onLinkedChatHrefChange ?? null;
    return <p>Call screen</p>;
  },
}));

function openedFrom(callSessionId: string, origin = 'https://chat.example.test') {
  window.sessionStorage.setItem(`viventium.call.capability.v1:${callSessionId}`, CAPABILITY);
  window.sessionStorage.setItem(`viventium.call.opener-origin.v1:${callSessionId}`, origin);
}

function renderPage(call: Partial<CallContextValue>) {
  const value: CallContextValue = {
    callSessionId: 'call-1',
    conversationId: 'chat-1',
    mode: 'call',
    modePending: false,
    setMode: vi.fn(),
    authoritativeStatus: null,
    callStateError: null,
    lastKeepalive: null,
    ...call,
  };
  const page = (current: CallContextValue) => (
    <CallProvider value={current}>
      <ViewController
        start={{ buttonText: 'Start chat', disabled: false, ended: false }}
        startupPending={false}
        onStartCall={vi.fn()}
        onRetry={vi.fn()}
        onCallEnding={vi.fn()}
        onCallEnded={vi.fn()}
        isVideoInputSupported={false}
      />
    </CallProvider>
  );
  const view = render(page(value));
  return {
    ...view,
    rerenderCall: (next: Partial<CallContextValue>) => view.rerender(page({ ...value, ...next })),
  };
}

afterEach(() => {
  window.sessionStorage.clear();
  state.connectionState = 'disconnected';
  state.reportChatHref = null;
});

describe('"Open in chat"', () => {
  it('opens the chat this call belongs to, in a new tab', () => {
    openedFrom('call-1');
    render(<LinkedChatLink callSessionId="call-1" conversationId="chat-1" />);
    const link = screen.getByRole('link', { name: 'Open in chat' });
    expect(link).toHaveAttribute('href', 'https://chat.example.test/c/chat-1');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it.each([
    ['no call', null, 'chat-1'],
    ['a call from a new chat', 'call-1', 'new'],
    ['no chat', 'call-1', null],
    ['a hostile chat id', 'call-1', '../admin'],
  ])('is absent with %s: no invented destination', (_name, callSessionId, conversationId) => {
    openedFrom('call-1');
    render(<LinkedChatLink callSessionId={callSessionId} conversationId={conversationId} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('is absent when the page does not know who opened it', () => {
    window.sessionStorage.setItem('viventium.call.capability.v1:call-1', CAPABILITY);
    render(<LinkedChatLink callSessionId="call-1" conversationId="chat-1" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('keeps the page usable when browser storage is blocked', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Storage blocked');
    });
    render(<LinkedChatLink callSessionId="call-1" conversationId="chat-1" />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    getItem.mockRestore();
  });
});

describe('the link across the call', () => {
  it('is there before, during and after the call', () => {
    openedFrom('call-1');
    const { rerenderCall } = renderPage({});
    expect(screen.getByRole('link', { name: 'Open in chat' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start chat' })).toBeInTheDocument();

    state.connectionState = 'connecting';
    rerenderCall({});
    expect(screen.getByRole('link', { name: 'Open in chat' })).toBeInTheDocument();
  });

  it('shows the call screen as soon as connecting begins', () => {
    state.connectionState = 'connecting';
    renderPage({});
    expect(screen.getByText('Call screen')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start chat' })).not.toBeInTheDocument();
  });

  it('learns the chat of a call from a new chat from its first result and keeps it after a reload', () => {
    openedFrom('call-1');
    state.connectionState = 'connected';
    const { unmount } = renderPage({ conversationId: null });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();

    act(() => state.reportChatHref?.('https://chat.example.test/c/chat-new'));
    expect(screen.getByRole('link', { name: 'Open in chat' })).toHaveAttribute(
      'href',
      'https://chat.example.test/c/chat-new'
    );

    // Reload after End: React state and the opener are gone, the tab still knows the chat.
    unmount();
    window.sessionStorage.removeItem('viventium.call.opener-origin.v1:call-1');
    state.connectionState = 'disconnected';
    renderPage({ conversationId: null });
    expect(screen.getByRole('link', { name: 'Open in chat' })).toHaveAttribute(
      'href',
      'https://chat.example.test/c/chat-new'
    );
  });

  it('never shows the chat of another call', () => {
    openedFrom('call-1');
    state.connectionState = 'connected';
    const { rerenderCall } = renderPage({ conversationId: null });
    act(() => state.reportChatHref?.('https://chat.example.test/c/chat-new'));
    expect(screen.getByRole('link')).toBeInTheDocument();

    rerenderCall({ callSessionId: 'call-2', conversationId: null });
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});
