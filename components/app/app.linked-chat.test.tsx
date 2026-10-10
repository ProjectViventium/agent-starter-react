/* VIVENTIUM START
 * Purpose: Keep authenticated chat navigation on the full App's manual and ended-reload path.
 * VIVENTIUM END */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AppConfig } from '@/app-config';
import { clearCallBrowserCapability } from '@/lib/call-browser-capability';
import { retainedLinkedChatHref } from '@/lib/call-handoff';

let App: typeof import('@/components/app/app').App;
const state = vi.hoisted(() => ({
  responseStatus: 200,
  payload: {} as Record<string, unknown>,
  settingsBlocked: false,
  nativeSession: vi.fn(),
  start: vi.fn(),
  end: vi.fn(),
  startAudio: vi.fn(),
  setMicrophoneEnabled: vi.fn(),
}));
vi.mock('@livekit/components-react', () => ({
  useSession: state.nativeSession,
  useSessionContext: () => ({ isConnected: false, connectionState: 'disconnected' }),
  SessionProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  RoomAudioRenderer: () => null,
}));
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
  motion: { create: (component: unknown) => component },
  useReducedMotion: () => true,
}));
vi.mock('@/components/app/session-view', () => ({ SessionView: () => <div>Current call</div> }));
vi.mock('@/hooks/useCallSessionVoiceSettings', () => ({
  useCallSessionVoiceSettings: () => ({
    configuredVoiceRoute: {
      stt: { provider: 'synthetic-stt' },
      tts: { provider: 'synthetic-tts' },
    },
    isLoading: false,
    isSaving: false,
    error: state.settingsBlocked ? 'Call capability is unavailable.' : null,
    issue: state.settingsBlocked
      ? { kind: 'auth_expired', message: 'Call capability is unavailable.' }
      : null,
  }),
}));
vi.mock('@/components/app/advanced-voice-settings', () => ({
  AdvancedVoiceSettings: ({ readOnly }: { readOnly: boolean }) => (
    <output aria-label="Settings read only">{String(readOnly)}</output>
  ),
  ConnectedAdvancedVoiceSettings: () => null,
}));
vi.mock('@/components/livekit/voice-audio-playback-evidence', () => ({
  VoiceAudioPlaybackEvidence: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));
vi.mock('@/components/livekit/toaster', () => ({ Toaster: () => null }));
vi.mock('@/hooks/useConnectionRecovery', () => ({ useConnectionRecovery: () => undefined }));
vi.mock('@/hooks/useWakeLock', () => ({ useWakeLock: () => undefined }));
vi.mock('@/hooks/useAgentErrors', () => ({ useAgentErrors: () => undefined }));
vi.mock('@/hooks/useDebug', () => ({ useDebugMode: () => undefined }));

const appConfig = { agentName: 'synthetic-agent', startButtonText: 'Start call' } as AppConfig;
function openCall(callSessionId = 'call-current', conversationId = 'new') {
  window.history.replaceState(
    null,
    '',
    `/?callSessionId=${callSessionId}&conversationId=${conversationId}&roomName=room-current&autoConnect=0`
  );
  return render(<App appConfig={appConfig} />);
}
function expectNoNativeCall() {
  expect(state.nativeSession).not.toHaveBeenCalled();
  expect(state.start).not.toHaveBeenCalled();
  expect(state.end).not.toHaveBeenCalled();
  expect(state.setMicrophoneEnabled).not.toHaveBeenCalled();
  expect(state.startAudio).not.toHaveBeenCalled();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(
        ([url, init]) =>
          String(url).startsWith('/api/call-session-state?') && init?.method === 'GET'
      )
  ).toBe(true);
}
beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('React', React);
  window.sessionStorage.clear();
  state.responseStatus = 200;
  state.settingsBlocked = false;
  state.payload = {
    version: 1,
    callSessionId: 'call-current',
    mode: 'call',
    status: 'ended',
    revision: 1,
    updatedAt: '2026-10-05T12:00:00.000Z',
  };
  state.nativeSession.mockReset().mockReturnValue({
    isConnected: false,
    connectionState: 'disconnected',
    start: state.start,
    end: state.end,
    room: {
      on: vi.fn(),
      off: vi.fn(),
      startAudio: state.startAudio,
      remoteParticipants: new Map(),
      localParticipant: { setMicrophoneEnabled: state.setMicrophoneEnabled },
    },
  });
  state.start.mockReset();
  state.end.mockReset();
  state.startAudio.mockReset();
  state.setMicrophoneEnabled.mockReset();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(
      async () =>
        new Response(JSON.stringify(state.payload), {
          status: state.responseStatus,
          headers: { 'Content-Type': 'application/json' },
        })
    )
  );
  ({ App } = await import('@/components/app/app'));
});
afterEach(() => vi.unstubAllGlobals());

describe('full App chat navigation before a native call mounts', () => {
  it('reloads an ended new-chat call with its canonical chat after End clears call access', async () => {
    state.settingsBlocked = true;
    state.payload.error = { code: 'provider_failure', message: 'Stale error', retryable: true };
    window.sessionStorage.setItem('viventium.call.capability.v1:call-current', 'A'.repeat(43));
    window.sessionStorage.setItem(
      'viventium.call.opener-origin.v1:call-current',
      'https://chat.example.test'
    );
    retainedLinkedChatHref('call-current', 'https://chat.example.test/c/canonical-result');
    clearCallBrowserCapability('call-current');

    const first = openCall();
    expect(await screen.findByRole('button', { name: 'Call ended' })).toBeDisabled();
    expect(screen.getByRole('status', { name: 'Call status: ended' })).toHaveTextContent(
      'Call · ended'
    );
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Settings read only')).toHaveTextContent('true');
    const link = screen.getByRole('link', { name: 'Open in chat' });
    expect(link).toHaveAttribute('href', 'https://chat.example.test/c/canonical-result');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    fireEvent.click(link);
    fireEvent.click(screen.getByRole('button', { name: 'Call ended' }));
    expectNoNativeCall();
    expect(window.sessionStorage.getItem('viventium.call.capability.v1:call-current')).toBeNull();
    expect(
      window.sessionStorage.getItem('viventium.call.opener-origin.v1:call-current')
    ).toBeNull();
    first.unmount();

    openCall();
    expect(await screen.findByRole('button', { name: 'Call ended' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Open in chat' })).toHaveAttribute(
      'href',
      'https://chat.example.test/c/canonical-result'
    );
    expectNoNativeCall();
  });

  it.each(['created', 'ended'])(
    'uses the verified source chat for a %s manual call',
    async (status) => {
      state.payload.status = status;
      window.sessionStorage.setItem(
        'viventium.call.opener-origin.v1:call-current',
        'https://chat.example.test'
      );
      openCall('call-current', 'source-conversation');
      await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      expect(screen.getByRole('link', { name: 'Open in chat' })).toHaveAttribute(
        'href',
        'https://chat.example.test/c/source-conversation'
      );
      const button = screen.getByRole('button', {
        name: status === 'ended' ? 'Call ended' : 'Start call',
      });
      if (status === 'ended') expect(button).toBeDisabled();
      else expect(button).toBeEnabled();
      expectNoNativeCall();
    }
  );

  it.each(['expired', 'wrong-call'])(
    'keeps %s authority distinct from Ended while chat access stays normal',
    async (condition) => {
      retainedLinkedChatHref('call-current', 'https://chat.example.test/c/canonical-result');
      if (condition === 'expired') {
        state.responseStatus = 410;
        state.payload = { code: 'auth_expired', message: 'Synthetic call rejected.' };
      } else {
        state.payload.callSessionId = 'call-foreign';
      }
      openCall();
      expect(await screen.findByRole('alert')).toHaveTextContent('This call link has expired');
      expect(screen.queryByRole('status', { name: 'Call status: ended' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Open from Viventium' })).toBeDisabled();
      expect(screen.getByRole('link', { name: 'Open in chat' })).toHaveAttribute(
        'href',
        'https://chat.example.test/c/canonical-result'
      );
      expectNoNativeCall();
    }
  );

  it.each(['no-result', 'other-call', 'invalid-target'])(
    'does not invent chat navigation for %s',
    async (condition) => {
      window.sessionStorage.setItem(
        'viventium.call.opener-origin.v1:call-current',
        'https://chat.example.test'
      );
      if (condition === 'other-call') {
        retainedLinkedChatHref('call-previous', 'https://chat.example.test/c/previous-result');
      } else if (condition === 'invalid-target') {
        window.sessionStorage.setItem(
          'viventium.call.linked-chat.v1:call-current',
          'javascript:alert(1)'
        );
      }
      openCall();
      expect(await screen.findByRole('button', { name: 'Call ended' })).toBeDisabled();
      expect(screen.queryByRole('link', { name: 'Open in chat' })).not.toBeInTheDocument();
      expectNoNativeCall();
    }
  );

  it('keeps the ended full App usable when session storage is denied', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get: () => {
        throw new DOMException('Storage blocked', 'SecurityError');
      },
    });
    try {
      openCall();
      expect(await screen.findByRole('button', { name: 'Call ended' })).toBeDisabled();
      expect(screen.getByRole('status', { name: 'Call status: ended' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Open in chat' })).not.toBeInTheDocument();
      expectNoNativeCall();
    } finally {
      if (descriptor) Object.defineProperty(window, 'sessionStorage', descriptor);
    }
  });
});
