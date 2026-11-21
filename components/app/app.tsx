'use client';

/*
 * The Viventium call page (CP-CMP-001 … 010).
 *
 * Upstream's `App` with what a Viventium call needs around it:
 * - the page is opened for one call: the link is read and cleaned before anything is shown;
 * - the token comes from the page's own server with the per-call capability (`lib/call-token-source`);
 * - the session is created only once a start is asked for. `useSession` fetches a token as soon
 *   as it mounts, and for a signed call that already attaches a voice worker, so a page that is
 *   merely open (manual start) must not mount it;
 * - one owner of the server's call record (mode, ended) for the start screen and the live call.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ConnectionState } from 'livekit-client';
import { MotionConfig } from 'motion/react';
import { useSession } from '@livekit/components-react';
import { WarningIcon } from '@phosphor-icons/react/dist/ssr';
import { AgentSessionProvider } from '@/components/agents-ui/agent-session-provider';
import { VoiceAudioPlaybackEvidence } from '@/components/app/audio-playback-evidence';
import { type CallContextValue, CallProvider } from '@/components/app/call-context';
import { LinkedChatLink } from '@/components/app/linked-chat-link';
import { type StartScreenState, ViewController } from '@/components/app/view-controller';
import { CallVoicePicker, VoicePicker } from '@/components/app/voice-picker';
import { WelcomeView } from '@/components/app/welcome-view';
import { Toaster } from '@/components/ui/sonner';
import { useAgentErrors } from '@/hooks/useAgentErrors';
import { type UseCallSessionStateResult, useCallSessionState } from '@/hooks/useCallSessionState';
import {
  type UseCallSessionVoiceSettingsResult,
  useCallSessionVoiceSettings,
} from '@/hooks/useCallSessionVoiceSettings';
import { CALL_AGENT_CONNECT_TIMEOUT_MS, useCallStart } from '@/hooks/useCallStart';
import { useCallStatePublish } from '@/hooks/useCallStatePublish';
import { useConnectionRecovery } from '@/hooks/useConnectionRecovery';
import { useDebugMode } from '@/hooks/useDebug';
import { type DeviceSoundSettings, useDeviceSoundMode } from '@/hooks/useDeviceSoundMode';
import { useWakeLock } from '@/hooks/useWakeLock';
import { captureCallBrowserCapability } from '@/lib/call-browser-capability';
import { type CallDeepLink, type CallIssue, readCallDeepLink } from '@/lib/call-start';
import { type CallTokenSource, createCallTokenSource } from '@/lib/call-token-source';
import { VIVENTIUM_CONFIG } from '@/lib/viventium/config';

const IN_DEVELOPMENT = process.env.NODE_ENV !== 'production';

const ENDED_TEXT = 'Call ended. Any active work is continuing in your linked Viventium chat.';
const INSECURE_PAGE_TEXT =
  'This address cannot be used for a call. Open Viventium on this Mac (localhost), or use a secure (https) address.';

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

/**
 * What the start screen shows (CP-CMP-009), from everything known about the call. Voice
 * settings that are still loading or failed to load never block Start: the server decides.
 */
export function deriveStartScreen({
  hasCall,
  hasAgent,
  insecurePage,
  settings,
  callState,
  starting = false,
  microphoneStarting = false,
  startError = null,
  endedHere = false,
}: {
  hasCall: boolean;
  hasAgent: boolean;
  insecurePage: boolean;
  settings: Pick<UseCallSessionVoiceSettingsResult, 'isLoading' | 'isSaving' | 'issue'>;
  callState: Pick<
    UseCallSessionStateResult,
    'authoritativeStatus' | 'callStateIssue' | 'callStateError'
  >;
  starting?: boolean;
  microphoneStarting?: boolean;
  startError?: CallIssue | null;
  endedHere?: boolean;
}): StartScreenState & { canStart: boolean } {
  const ended = endedHere || (hasCall && callState.authoritativeStatus === 'ended');
  if (ended) {
    return {
      canStart: false,
      buttonText: 'Call ended',
      disabled: true,
      helperText: ENDED_TEXT,
      ended,
    };
  }
  if (insecurePage) {
    return {
      canStart: false,
      buttonText: 'Secure setup required',
      disabled: true,
      helperText: INSECURE_PAGE_TEXT,
      ended,
    };
  }
  const linkExpired =
    startError?.kind === 'auth_expired' ||
    (hasCall && callState.callStateIssue?.kind === 'auth_expired');
  if (linkExpired) {
    return {
      canStart: false,
      buttonText: 'Call link expired',
      disabled: true,
      issue: startError ?? callState.callStateIssue,
      ended,
    };
  }
  // A signed call must pass Core's existing state check before the SDK or microphone starts.
  if (hasCall && callState.authoritativeStatus === null) {
    return {
      canStart: false,
      buttonText: 'Checking call...',
      disabled: true,
      helperText: callState.callStateError ?? 'Checking this call with Viventium...',
      issue: callState.callStateIssue,
      ended,
    };
  }
  const canStart = (hasCall || hasAgent) && !settings.isSaving;
  return {
    canStart,
    buttonText: microphoneStarting
      ? 'Turning on mic...'
      : starting
        ? 'Starting call...'
        : canStart
          ? VIVENTIUM_CONFIG.startButtonText
          : 'Open from Viventium',
    disabled: !canStart || starting,
    helperText:
      callState.callStateError ??
      (microphoneStarting
        ? 'Turning on your microphone...'
        : starting
          ? 'Connecting Viventium to the room...'
          : hasCall && settings.isLoading
            ? 'Preparing your configured voice route...'
            : undefined),
    issue: startError ?? callState.callStateIssue ?? (hasCall ? settings.issue : null),
    ended,
  };
}

function AppSetup({ onSessionFailure }: { onSessionFailure: () => void }) {
  useDebugMode({ enabled: IN_DEVELOPMENT });
  useAgentErrors(onSessionFailure);
  return null;
}

function AppToaster() {
  return (
    <Toaster
      icons={{ warning: <WarningIcon weight="bold" /> }}
      position="top-center"
      className="toaster group"
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
        } as React.CSSProperties
      }
    />
  );
}

type CallPageState = {
  link: CallDeepLink;
  /** Opened over plain http on another machine: the browser will not give a microphone. */
  insecurePage: boolean;
};

interface CallSessionProps {
  tokens: CallTokenSource;
  link: CallDeepLink;
  hasAgent: boolean;
  isVideoInputSupported: boolean;
  voiceSettings: UseCallSessionVoiceSettingsResult;
  deviceSound: DeviceSoundSettings;
  callSessionState: UseCallSessionStateResult;
  callContext: CallContextValue;
  onKeepAliveChange: (enabled: boolean) => void;
}

/** The part of the page that owns the LiveKit session. Mounted once a start is asked for. */
function CallSession({
  tokens,
  link,
  hasAgent,
  isVideoInputSupported,
  voiceSettings,
  deviceSound,
  callSessionState,
  callContext,
  onKeepAliveChange,
}: CallSessionProps) {
  const callSessionId = link.expectedCallSessionId;
  const [endedHere, setEndedHere] = useState(false);
  const session = useSession(
    tokens.tokenSource,
    callSessionId ? { agentConnectTimeoutMilliseconds: CALL_AGENT_CONNECT_TIMEOUT_MS } : undefined
  );
  const endedOnServer = callSessionState.authoritativeStatus === 'ended';
  const preflight = deriveStartScreen({
    hasCall: Boolean(callSessionId),
    hasAgent,
    insecurePage: false,
    settings: voiceSettings,
    callState: callSessionState,
    endedHere,
  });
  const { startCall, abortStart, isStarting, isMicrophoneStarting, startError, activeSoundMode } =
    useCallStart({
      session,
      tokens,
      callSessionId,
      soundMode: deviceSound.mode,
      ended: endedHere || endedOnServer,
      authorityIssue: callSessionState.callStateIssue,
      autoStart: preflight.canStart,
    });
  const start = deriveStartScreen({
    hasCall: Boolean(callSessionId),
    hasAgent,
    insecurePage: false,
    settings: voiceSettings,
    callState: callSessionState,
    starting: isStarting,
    microphoneStarting: isMicrophoneStarting,
    startError,
    endedHere,
  });

  // The server's call record is kept alive only while the call is connecting or connected.
  const isConnecting = session.connectionState === ConnectionState.Connecting;
  useEffect(() => {
    onKeepAliveChange(
      Boolean(callSessionId) && !endedHere && (session.isConnected || isConnecting)
    );
    return () => onKeepAliveChange(false);
  }, [callSessionId, endedHere, session.isConnected, isConnecting, onKeepAliveChange]);

  // The call ended somewhere else (the server says so): stop starting, leave the room.
  const { end, connectionState } = session;
  useEffect(() => {
    if (!endedOnServer || endedHere) return;
    setEndedHere(true);
    abortStart();
    if (connectionState !== ConnectionState.Disconnected) {
      tokens.markEnding();
      end().catch(() => console.warn('[Viventium] Failed to disconnect an ended call.'));
    }
  }, [abortStart, connectionState, end, endedHere, endedOnServer, tokens]);

  useCallStatePublish(session, callSessionId, callSessionState.lastModeTransition);
  useWakeLock(session.isConnected);
  const recoverCall = useCallback(async () => {
    if (!(await startCall())) throw new Error('Viventium call recovery failed.');
  }, [startCall]);
  useConnectionRecovery({
    connectionState: session.connectionState,
    isConnected: session.isConnected,
    start: recoverCall,
  });

  const onCallEnding = useCallback(() => tokens.markEnding(), [tokens]);
  const onCallEnded = useCallback(() => setEndedHere(true), []);
  const onStart = useCallback(() => void startCall(), [startCall]);

  return (
    <VoiceAudioPlaybackEvidence resetKey={callSessionId ?? ''}>
      <AgentSessionProvider session={session}>
        <CallProvider value={callContext}>
          <AppSetup onSessionFailure={abortStart} />
          <main className="grid min-h-svh grid-cols-1 place-content-center">
            <ViewController
              start={start}
              startupPending={isStarting}
              onStartCall={onStart}
              onRetry={onStart}
              onCallEnding={onCallEnding}
              onCallEnded={onCallEnded}
              isVideoInputSupported={isVideoInputSupported}
              picker={
                <CallVoicePicker
                  settings={callSessionId ? voiceSettings : null}
                  ended={endedHere || endedOnServer}
                  deviceSound={deviceSound}
                  activeSoundMode={activeSoundMode}
                />
              }
            />
          </main>
          <AppToaster />
        </CallProvider>
      </AgentSessionProvider>
    </VoiceAudioPlaybackEvidence>
  );
}

interface AppProps {
  /** Agent for unsigned development calls; a signed call gets its agent from the server. */
  agentName?: string;
  isVideoInputSupported: boolean;
}

export function App({ agentName, isVideoInputSupported }: AppProps) {
  const [page, setPage] = useState<CallPageState | null>(null);
  const [startRequested, setStartRequested] = useState(false);
  const [keepAlive, setKeepAlive] = useState(false);

  // Before first paint: take the call capability out of the address, then read which call this
  // page was opened for.
  useLayoutEffect(() => {
    captureCallBrowserCapability({
      search: window.location.search,
      hash: window.location.hash,
      pathname: window.location.pathname,
      replaceUrl: (url) => window.history.replaceState(window.history.state, '', url),
    });
    const insecurePage = !window.isSecureContext && !isLoopbackHost(window.location.hostname);
    setPage({
      link: insecurePage ? readCallDeepLink('') : readCallDeepLink(window.location.search),
      insecurePage,
    });
  }, []);

  const callSessionId = page?.link.expectedCallSessionId ?? null;
  const conversationId = page?.link.expectedConversationId ?? null;
  const voiceSettings = useCallSessionVoiceSettings(callSessionId);
  const deviceSound = useDeviceSoundMode();
  const callSessionState = useCallSessionState(callSessionId, keepAlive);

  const linkTokenOptions = page?.link.tokenOptions;
  const tokens = useMemo(
    () =>
      createCallTokenSource(VIVENTIUM_CONFIG.tokenEndpoint, {
        ...(agentName ? { agentName } : {}),
        ...linkTokenOptions,
      }),
    [agentName, linkTokenOptions]
  );

  const { mode, modePending, setMode, authoritativeStatus, callStateError, lastKeepalive } =
    callSessionState;
  const callContext = useMemo<CallContextValue>(
    () => ({
      callSessionId,
      conversationId,
      mode,
      modePending,
      setMode: (next) => void setMode(next),
      authoritativeStatus,
      callStateError,
      lastKeepalive,
    }),
    [
      callSessionId,
      conversationId,
      mode,
      modePending,
      setMode,
      authoritativeStatus,
      callStateError,
      lastKeepalive,
    ]
  );

  const start = deriveStartScreen({
    hasCall: Boolean(callSessionId),
    hasAgent: Boolean(agentName),
    insecurePage: page?.insecurePage ?? false,
    settings: voiceSettings,
    callState: callSessionState,
  });
  useEffect(() => {
    if (page?.link.autoConnect && deviceSound.ready && start.canStart) setStartRequested(true);
  }, [page?.link.autoConnect, deviceSound.ready, start.canStart]);

  if (!page || !deviceSound.ready) {
    return null;
  }

  if (startRequested) {
    return (
      <MotionConfig reducedMotion="user">
        <CallSession
          tokens={tokens}
          link={page.link}
          hasAgent={Boolean(agentName)}
          isVideoInputSupported={isVideoInputSupported}
          voiceSettings={voiceSettings}
          deviceSound={deviceSound}
          callSessionState={callSessionState}
          callContext={callContext}
          onKeepAliveChange={setKeepAlive}
        />
      </MotionConfig>
    );
  }

  // Manual start: the call is prepared on the server only when Start is pressed.
  return (
    <MotionConfig reducedMotion="user">
      <main className="grid min-h-svh grid-cols-1 place-content-center">
        <LinkedChatLink callSessionId={callSessionId} conversationId={conversationId} />
        <WelcomeView
          startButtonText={start.buttonText}
          onStartCall={() => {
            if (start.canStart) setStartRequested(true);
          }}
          startDisabled={start.disabled}
          onRetry={() => void callSessionState.refreshState()}
          helperText={start.issue ? undefined : start.helperText}
          callIssue={
            start.issue && callSessionState.callStateRetryable
              ? { ...start.issue, retryable: true }
              : start.issue
          }
          callEnded={start.ended}
          mode={mode}
          picker={
            <VoicePicker
              settings={callSessionId ? voiceSettings : null}
              phase={start.ended ? 'ended' : 'before'}
              deviceSound={deviceSound}
            />
          }
        />
      </main>
      <AppToaster />
    </MotionConfig>
  );
}
