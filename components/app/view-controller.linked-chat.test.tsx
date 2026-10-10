import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { AppConfig } from '@/app-config';
import { ViewController } from '@/components/app/view-controller';

const state = vi.hoisted(() => ({
  connected: true,
  href: 'https://chat.example.test/c/conversation-1' as string | null,
  realBridge: false,
}));
vi.mock('@livekit/components-react', () => ({
  useSessionContext: () => ({
    isConnected: state.connected,
    connectionState: state.connected ? 'connected' : 'disconnected',
  }),
}));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
  motion: { create: (component: unknown) => component },
  useReducedMotion: () => true,
}));
vi.mock('@/components/app/session-view', async () => {
  const { useCallResultBridge } = await import('@/hooks/useCallResultBridge');
  return {
    SessionView: ({
      onLinkedChatHrefChange,
      callSessionId,
      conversationId,
    }: {
      onLinkedChatHrefChange?: (href: string | null) => void;
      callSessionId: string | null;
      conversationId: string | null;
    }) => {
      useCallResultBridge({
        callSessionId: state.realBridge ? callSessionId : null,
        conversationId,
        tasks: [],
        onLinkedChatHrefChange: state.realBridge ? onLinkedChatHrefChange : undefined,
      });
      React.useEffect(() => {
        if (!state.realBridge) onLinkedChatHrefChange?.(state.href);
      }, [onLinkedChatHrefChange]);
      return <div>Current call</div>;
    },
  };
});
vi.mock('@/components/app/welcome-view', () => ({
  WelcomeView: () => <div>Call ended</div>,
}));
const appConfig = { startButtonText: 'Start call' } as AppConfig;
afterEach(() => {
  state.connected = true;
  state.realBridge = false;
  state.href = 'https://chat.example.test/c/conversation-1';
  window.sessionStorage.clear();
});
const props = {
  appConfig,
  canStartCall: true,
  onStartCall: vi.fn(),
  callSessionId: 'call-1',
  conversationId: 'conversation-1',
};
describe('linked chat user action', () => {
  it('opens the normal authenticated chat during and after the call without disconnecting it', async () => {
    const { rerender } = render(<ViewController {...props} />);
    const link = await screen.findByRole('link', { name: 'Open in chat' });
    expect(link).toHaveAttribute('href', state.href);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByText('Current call')).toBeInTheDocument();
    state.connected = false;
    rerender(<ViewController {...props} canStartCall={false} callEnded />);
    expect(screen.getByText('Call ended')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in chat' })).toHaveAttribute('href', state.href);
  });
  it('does not retain a previous call address when the current call changes', async () => {
    const { rerender } = render(<ViewController {...props} />);
    await screen.findByRole('link', { name: 'Open in chat' });
    state.connected = false;
    rerender(<ViewController {...props} callSessionId="call-2" conversationId={null} />);
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Open in chat' })).not.toBeInTheDocument()
    );
  });
  it('shows no invented destination when the trusted bridge has no address', () => {
    state.href = null;
    render(<ViewController {...props} />);
    expect(screen.queryByRole('link', { name: 'Open in chat' })).not.toBeInTheDocument();
  });
  it('keeps the normal chat route on an ended-page reload using the retained opener', () => {
    state.connected = false;
    window.sessionStorage.setItem(
      'viventium.call.opener-origin.v1:call-1',
      'https://chat.example.test'
    );
    render(<ViewController {...props} canStartCall={false} callEnded />);
    expect(screen.getByText('Call ended')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in chat' })).toHaveAttribute(
      'href',
      'https://chat.example.test/c/conversation-1'
    );
  });
});

describe('new-chat ended reload', () => {
  it('retains the canonical conversation after React state, opener and call capability are gone', async () => {
    state.href = 'https://chat.example.test/c/canonical-final';
    const { unmount } = render(<ViewController {...props} conversationId="new" />);
    expect(await screen.findByRole('link', { name: 'Open in chat' })).toHaveAttribute(
      'href',
      state.href
    );
    unmount();
    state.connected = false;
    window.sessionStorage.removeItem('viventium.call.capability.v1:call-1');
    window.sessionStorage.removeItem('viventium.call.opener-origin.v1:call-1');
    render(<ViewController {...props} conversationId="new" canStartCall={false} callEnded />);
    expect(screen.getByRole('link', { name: 'Open in chat' })).toHaveAttribute('href', state.href);
    expect(screen.getByText('Call ended')).toBeInTheDocument();
  });
});

describe('call navigation when browser storage is blocked', () => {
  it('keeps the ended view usable without inventing a chat destination', () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('Storage blocked', 'SecurityError');
      },
    });
    try {
      state.connected = false;
      state.href = null;
      render(<ViewController {...props} conversationId="new" canStartCall={false} callEnded />);
      expect(screen.getByText('Call ended')).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Open in chat' })).not.toBeInTheDocument();
    } finally {
      if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
    }
  });
});

describe('existing chat remains available without a generated turn', () => {
  it('retains the source chat before End clears capability and opener, then reloads it with no tasks', async () => {
    state.realBridge = true;
    state.href = null;
    window.sessionStorage.setItem(
      'viventium.call.opener-origin.v1:call-1',
      'https://chat.example.test'
    );
    const { unmount } = render(<ViewController {...props} />);
    expect(await screen.findByRole('link', { name: 'Open in chat' })).toHaveAttribute(
      'href',
      'https://chat.example.test/c/conversation-1'
    );
    await waitFor(() =>
      expect(window.sessionStorage.getItem('viventium.call.linked-chat.v1:call-1')).toBe(
        'https://chat.example.test/c/conversation-1'
      )
    );
    unmount();
    state.connected = false;
    window.sessionStorage.removeItem('viventium.call.capability.v1:call-1');
    window.sessionStorage.removeItem('viventium.call.opener-origin.v1:call-1');
    render(<ViewController {...props} conversationId={null} canStartCall={false} callEnded />);
    expect(screen.getByRole('link', { name: 'Open in chat' })).toHaveAttribute(
      'href',
      'https://chat.example.test/c/conversation-1'
    );
    expect(screen.getByText('Call ended')).toBeInTheDocument();
  });

  it('does not invent an existing chat for a no-turn new call', async () => {
    state.realBridge = true;
    state.href = null;
    window.sessionStorage.setItem(
      'viventium.call.opener-origin.v1:call-1',
      'https://chat.example.test'
    );
    render(<ViewController {...props} conversationId="new" />);
    await waitFor(() => expect(screen.getByText('Current call')).toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Open in chat' })).not.toBeInTheDocument();
    expect(window.sessionStorage.getItem('viventium.call.linked-chat.v1:call-1')).toBeNull();
  });
});
