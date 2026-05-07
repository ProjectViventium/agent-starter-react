'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ConnectionState,
  TokenSource,
  type TokenSourceConfigurable,
  type TokenSourceFetchOptions,
  type TokenSourceFixed,
} from 'livekit-client';
import {
  RoomAudioRenderer,
  SessionProvider,
  StartAudio,
  useSession,
} from '@livekit/components-react';
import type { AppConfig } from '@/app-config';
import { ViewController } from '@/components/app/view-controller';
import { WelcomeView } from '@/components/app/welcome-view';
import { toastAlert } from '@/components/livekit/alert-toast';
import { Toaster } from '@/components/livekit/toaster';
import { useAgentErrors } from '@/hooks/useAgentErrors';
import { useCallSessionState } from '@/hooks/useCallSessionState';
import {
  type AssistantRouteInfo,
  useCallSessionVoiceSettings,
} from '@/hooks/useCallSessionVoiceSettings';
import { useConnectionRecovery } from '@/hooks/useConnectionRecovery';
import { useDebugMode } from '@/hooks/useDebug';
import {
  type VoiceRouteMetadata,
  type VoiceRouteState,
  buildFallbackVoiceRoute,
} from '@/hooks/useVoiceRoute';
import { useWakeLock } from '@/hooks/useWakeLock';
import { getSandboxTokenSource } from '@/lib/utils';

const IN_DEVELOPMENT = process.env.NODE_ENV !== 'production';

function AppSetup() {
  useDebugMode({ enabled: IN_DEVELOPMENT });
  useAgentErrors();

  return null;
}

interface AppProps {
  appConfig: AppConfig;
}

type AgentTokenOptions = TokenSourceFetchOptions & {
  agentName?: string;
  agentMetadata?: string;
  participantMetadata?: string;
};

const VIVENTIUM_CALL_AGENT_CONNECT_TIMEOUT_MS = 90_000;
const CONNECTION_DETAILS_RETRY_MS = 1500;
const CONNECTION_DETAILS_MAX_ATTEMPTS = 2;

type DeepLinkState = {
  tokenOptions?: AgentTokenOptions;
  autoConnect: boolean;
  expectedRoomName: string | null;
  expectedCallSessionId: string | null;
};

type ConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantToken: string;
  participantName?: string;
  participantIdentity?: string;
};

function isLoopbackHost(hostname: string | null | undefined): boolean {
  const normalized = (hostname ?? '')
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function readDeepLinkState(): DeepLinkState {
  if (typeof window === 'undefined') {
    return {
      autoConnect: false,
      expectedRoomName: null,
      expectedCallSessionId: null,
    };
  }
  const params = new URLSearchParams(window.location.search);
  const roomName = params.get('roomName');
  const agentName = params.get('agentName');
  const callSessionId = params.get('callSessionId');
  const shouldAutoConnect = params.get('autoConnect') === '1';

  const tokenOptions: AgentTokenOptions = {};
  if (roomName) {
    tokenOptions.roomName = roomName;
  }
  if (agentName) {
    tokenOptions.agentName = agentName;
  }
  if (callSessionId) {
    tokenOptions.agentMetadata = JSON.stringify({ callSessionId });
    tokenOptions.participantMetadata = JSON.stringify({ callSessionId });
  }

  return {
    tokenOptions: Object.keys(tokenOptions).length > 0 ? tokenOptions : undefined,
    // Publisher-dispatch Viventium calls need a live microphone track before the agent can join.
    // Browsers generally require a user gesture before microphone publication, so deep links should
    // land on the pre-connect screen instead of auto-starting into an immediate timeout.
    autoConnect: shouldAutoConnect && !callSessionId,
    expectedRoomName: roomName ?? null,
    expectedCallSessionId: callSessionId ?? null,
  };
}

function buildCallSessionMetadata(callSessionId: string, requestedVoiceRoute: VoiceRouteState) {
  return JSON.stringify({
    callSessionId,
    requestedVoiceRoute,
  });
}

function isLikelyFetchNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.trim().toLowerCase();
  return (
    message === 'failed to fetch' ||
    message === 'fetch failed' ||
    message === 'load failed' ||
    message.includes('networkerror')
  );
}

function normalizeStartError(error: unknown): string {
  if (isLikelyFetchNetworkError(error)) {
    return 'Viventium could not reach the voice runtime. Check the connection and retry.';
  }
  if (error instanceof Error) {
    const message = error.message.trim();
    if (message) {
      return message;
    }
  }
  return 'Unable to start this call right now. Start a fresh call from Viventium or use /call in Telegram.';
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

function getConnectionDetailsTokenSource(fallbackOptions?: AgentTokenOptions): TokenSourceFixed {
  return TokenSource.literal(async (options?: AgentTokenOptions): Promise<ConnectionDetails> => {
    const mergedOptions = {
      ...(fallbackOptions ?? {}),
      ...(options ?? {}),
    };
    let response: Response;
    for (let attempt = 0; ; attempt += 1) {
      try {
        response = await fetch('/api/connection-details', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(mergedOptions),
          cache: 'no-store',
        });
        break;
      } catch (error) {
        const shouldRetry =
          isLikelyFetchNetworkError(error) && attempt + 1 < CONNECTION_DETAILS_MAX_ATTEMPTS;
        if (!shouldRetry) {
          throw new Error(normalizeStartError(error));
        }
        await wait(CONNECTION_DETAILS_RETRY_MS);
      }
    }

    let payload: unknown = null;
    const text = await response.text();
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const message =
        payload &&
        typeof payload === 'object' &&
        'message' in payload &&
        typeof payload.message === 'string' &&
        payload.message.trim()
          ? payload.message.trim()
          : `Unable to start this call (${response.status}).`;
      throw new Error(message);
    }

    return payload as ConnectionDetails;
  });
}

type AppSessionProps = {
  tokenSource: TokenSourceConfigurable | TokenSourceFixed;
  tokenOptions: AgentTokenOptions | undefined;
  autoConnect: boolean;
  expectedRoomName: string | null;
  expectedCallSessionId: string | null;
  canStartCall: boolean;
  startHint?: string;
  startButtonText?: string;
  appConfig: AppConfig;
  voiceRoute: VoiceRouteMetadata;
  requestedVoiceRoute: VoiceRouteState;
  assistantRoute?: AssistantRouteInfo | null;
  onRequestedVoiceRouteChange: (nextState: VoiceRouteState) => Promise<boolean>;
  voiceRouteLoading?: boolean;
  voiceRouteSaving?: boolean;
  voiceRouteError?: string | null;
  voiceRouteNotice?: string | null;
};

function AppSession({
  tokenSource,
  tokenOptions,
  autoConnect,
  expectedRoomName,
  expectedCallSessionId,
  canStartCall,
  startHint,
  startButtonText,
  appConfig,
  voiceRoute,
  requestedVoiceRoute,
  assistantRoute,
  onRequestedVoiceRouteChange,
  voiceRouteLoading,
  voiceRouteSaving,
  voiceRouteError,
  voiceRouteNotice,
}: AppSessionProps) {
  const [hasAutoStarted, setHasAutoStarted] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const sessionOptions = useMemo(
    () => ({
      ...(tokenOptions ?? {}),
      agentConnectTimeoutMilliseconds: expectedCallSessionId
        ? VIVENTIUM_CALL_AGENT_CONNECT_TIMEOUT_MS
        : undefined,
    }),
    [expectedCallSessionId, tokenOptions]
  );
  const session = useSession(tokenSource, sessionOptions);
  const callSessionState = useCallSessionState(
    expectedCallSessionId,
    Boolean(expectedCallSessionId) &&
      (session.isConnected || session.connectionState === ConnectionState.Connecting)
  );

  /* === VIVENTIUM START ===
   * Feature: Prevent screen sleep during active voice calls.
   * Purpose: Mobile browsers suspend WebRTC connections when the screen sleeps,
   * causing call disconnection. The Wake Lock API keeps the screen awake.
   * === VIVENTIUM END === */
  useWakeLock(session.isConnected);

  /* === VIVENTIUM START ===
   * Feature: Explicit-dispatch call startup hardening.
   * Purpose: Avoid LiveKit's 15s pre-connect mic publish timeout while /api/connection-details
   * performs dispatch work. Publisher-dispatch agents still join as soon as the connected room
   * publishes the microphone track.
   * === VIVENTIUM END === */
  const shouldDeferMicrophoneUntilConnected = Boolean(expectedCallSessionId || appConfig.agentName);
  const startSession = useCallback(async () => {
    if (!shouldDeferMicrophoneUntilConnected) {
      await session.start();
      return;
    }

    await session.start({
      tracks: {
        microphone: {
          enabled: false,
        },
      },
    });

    try {
      await session.room.localParticipant.setMicrophoneEnabled(true);
    } catch (error) {
      await session.end().catch((disconnectError) => {
        console.warn(
          '[Viventium] Failed to disconnect after microphone startup error:',
          disconnectError
        );
      });
      throw error;
    }
  }, [session, shouldDeferMicrophoneUntilConnected]);

  /* === VIVENTIUM START ===
   * Feature: Auto-reconnect after screen sleep / background return.
   * Purpose: If the wake lock fails (e.g., user manually locks phone), attempt
   * to restore the call when the page becomes visible again.
   * === VIVENTIUM END === */
  useConnectionRecovery({
    connectionState: session.connectionState,
    isConnected: session.isConnected,
    start: startSession,
  });

  const startCall = useCallback(async () => {
    setStartError(null);
    try {
      await startSession();
      return true;
    } catch (error) {
      const message = normalizeStartError(error);
      console.error('Call start failed:', error);
      setStartError(message);
      toastAlert({
        title: 'Call failed to start',
        description: <p>{message}</p>,
      });
      return false;
    }
  }, [startSession]);

  /* === VIVENTIUM START ===
   * Feature: LibreChat deep-link auto-connect
   * Purpose: Only auto-connect once token options include the expected room + callSessionId metadata.
   */
  useEffect(() => {
    if (!autoConnect || hasAutoStarted || !canStartCall) {
      return;
    }
    const needsRoomName = Boolean(expectedRoomName);
    const needsCallSessionId = Boolean(expectedCallSessionId);
    if (needsRoomName && !tokenOptions?.roomName) {
      return;
    }
    if (needsCallSessionId && !tokenOptions?.agentMetadata) {
      return;
    }
    if (session.isConnected || session.connectionState === ConnectionState.Connecting) {
      setHasAutoStarted(true);
      return;
    }
    startCall().finally(() => {
      setHasAutoStarted(true);
    });
  }, [
    autoConnect,
    canStartCall,
    expectedCallSessionId,
    expectedRoomName,
    hasAutoStarted,
    session,
    startCall,
    tokenOptions,
  ]);
  /* === VIVENTIUM END === */

  const effectiveStartHint = startError ?? callSessionState.callStateError ?? startHint;

  return (
    <SessionProvider session={session}>
      <AppSetup />
      <main className="grid h-svh grid-cols-1 place-content-center">
        <ViewController
          appConfig={appConfig}
          canStartCall={canStartCall}
          startHint={effectiveStartHint ?? undefined}
          startButtonText={startButtonText}
          onStartCall={() => {
            void startCall();
          }}
          wingModeEnabled={callSessionState.wingModeEnabled}
          wingModePending={callSessionState.wingModePending}
          onWingModeChange={(enabled) => {
            void callSessionState.setWingModeEnabled(enabled);
          }}
          listenOnlyModeEnabled={callSessionState.listenOnlyModeEnabled}
          listenOnlyModePending={callSessionState.listenOnlyModePending}
          onListenOnlyModeChange={(enabled) => {
            void callSessionState.setListenOnlyModeEnabled(enabled);
          }}
          assistantRoute={assistantRoute}
          voiceRoute={voiceRoute}
          requestedVoiceRoute={requestedVoiceRoute}
          onRequestedVoiceRouteChange={onRequestedVoiceRouteChange}
          voiceRouteLoading={voiceRouteLoading}
          voiceRouteSaving={voiceRouteSaving}
          voiceRouteError={voiceRouteError}
          voiceRouteNotice={voiceRouteNotice}
        />
      </main>
      <StartAudio label="Start Audio" />
      <RoomAudioRenderer />
      <Toaster />
    </SessionProvider>
  );
}

export function App({ appConfig }: AppProps) {
  const [clientReady, setClientReady] = useState(false);
  const [deepLinkReady, setDeepLinkReady] = useState(false);
  const [sessionRequested, setSessionRequested] = useState(false);
  const [tokenOptions, setTokenOptions] = useState<AgentTokenOptions | undefined>(() => {
    return appConfig.agentName ? { agentName: appConfig.agentName } : undefined;
  });
  const [autoConnect, setAutoConnect] = useState(false);
  const [expectedRoomName, setExpectedRoomName] = useState<string | null>(null);
  const [expectedCallSessionId, setExpectedCallSessionId] = useState<string | null>(null);
  const [remoteCallBlockedReason, setRemoteCallBlockedReason] = useState<string | null>(null);
  const fallbackVoiceRoute = useMemo(() => buildFallbackVoiceRoute(appConfig), [appConfig]);
  const voiceSettings = useCallSessionVoiceSettings(expectedCallSessionId, fallbackVoiceRoute);
  const selectionVoiceRoute = voiceSettings.selectionVoiceRoute ?? fallbackVoiceRoute;
  const effectiveTokenOptions = useMemo(() => {
    if (!expectedCallSessionId) {
      return tokenOptions;
    }

    const metadata = buildCallSessionMetadata(
      expectedCallSessionId,
      voiceSettings.requestedVoiceRoute
    );
    return {
      ...(tokenOptions ?? {}),
      agentMetadata: metadata,
      participantMetadata: metadata,
    };
  }, [expectedCallSessionId, tokenOptions, voiceSettings.requestedVoiceRoute]);
  const tokenSource = useMemo(() => {
    return typeof process.env.NEXT_PUBLIC_CONN_DETAILS_ENDPOINT === 'string'
      ? getSandboxTokenSource(appConfig)
      : getConnectionDetailsTokenSource(effectiveTokenOptions);
  }, [appConfig, effectiveTokenOptions]);

  useEffect(() => {
    setClientReady(true);
  }, []);

  useEffect(() => {
    if (!clientReady) {
      return;
    }
    if (!window.isSecureContext && !isLoopbackHost(window.location.hostname)) {
      setRemoteCallBlockedReason(
        'Raw LAN/IP or quick-tunnel links are not a supported browser-call topology for local installs. Use Viventium on this Mac via localhost, or deploy a real public HTTPS/WSS surface for both the playground and LiveKit media path.'
      );
      setDeepLinkReady(true);
      return;
    }
    const deepLink = readDeepLinkState();
    if (deepLink.tokenOptions) {
      setTokenOptions((prev) => ({ ...(prev ?? {}), ...deepLink.tokenOptions }));
    }
    setExpectedRoomName(deepLink.expectedRoomName);
    setExpectedCallSessionId(deepLink.expectedCallSessionId);
    if (deepLink.autoConnect) {
      setAutoConnect(true);
    }
    setDeepLinkReady(true);
  }, [clientReady]);

  if (!clientReady || !deepLinkReady) {
    return null;
  }

  const canStartCall =
    Boolean(expectedCallSessionId || appConfig.agentName) &&
    !remoteCallBlockedReason &&
    !(Boolean(expectedCallSessionId) && voiceSettings.isLoading) &&
    !voiceSettings.isSaving;
  const requiresMicGesture = Boolean(expectedCallSessionId);
  let startHint: string | undefined;
  let startButtonText: string | undefined;
  if (remoteCallBlockedReason) {
    startHint = remoteCallBlockedReason;
    startButtonText = 'Secure setup required';
  } else if (expectedCallSessionId && voiceSettings.isLoading) {
    startHint = 'Loading your voice settings…';
  } else if (requiresMicGesture) {
    startHint = 'Tap Start chat to turn on your mic. Viventium joins right after.';
    if (voiceSettings.error) {
      startHint = `${startHint} ${voiceSettings.error}`;
    }
  }

  if (!sessionRequested && !autoConnect) {
    return (
      <>
        <main className="grid h-svh grid-cols-1 place-content-center">
          <WelcomeView
            startButtonText={
              startButtonText ?? (canStartCall ? appConfig.startButtonText : 'Open from Viventium')
            }
            onStartCall={() => {
              setSessionRequested(true);
            }}
            startDisabled={!canStartCall}
            helperText={startHint}
            voiceRoute={selectionVoiceRoute}
            requestedVoiceRoute={voiceSettings.requestedVoiceRoute}
            onRequestedVoiceRouteChange={voiceSettings.setRequestedVoiceRoute}
            voiceRouteLoading={voiceSettings.isLoading}
            voiceRouteSaving={voiceSettings.isSaving}
            voiceRouteError={voiceSettings.error}
            voiceRouteNotice={voiceSettings.notice}
          />
        </main>
        <Toaster />
      </>
    );
  }

  return (
    <AppSession
      tokenSource={tokenSource}
      tokenOptions={effectiveTokenOptions}
      autoConnect={autoConnect || sessionRequested}
      expectedRoomName={expectedRoomName}
      expectedCallSessionId={expectedCallSessionId}
      canStartCall={canStartCall}
      startHint={startHint}
      startButtonText={startButtonText}
      appConfig={appConfig}
      voiceRoute={selectionVoiceRoute}
      requestedVoiceRoute={voiceSettings.requestedVoiceRoute}
      assistantRoute={voiceSettings.assistantRoute}
      onRequestedVoiceRouteChange={voiceSettings.setRequestedVoiceRoute}
      voiceRouteLoading={voiceSettings.isLoading}
      voiceRouteSaving={voiceSettings.isSaving}
      voiceRouteError={voiceSettings.error}
      voiceRouteNotice={voiceSettings.notice}
    />
  );
}
