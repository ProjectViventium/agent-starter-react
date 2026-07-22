'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  reclaimDispatch?: boolean;
};

const VIVENTIUM_CALL_AGENT_CONNECT_TIMEOUT_MS = 90_000;
const CONNECTION_DETAILS_RETRY_MS = 1500;
const CONNECTION_DETAILS_MAX_ATTEMPTS = 2;
const CONNECTION_DETAILS_CACHE_MS = 2_000;
const START_LATCH_WATCHDOG_MS = 1_000;
const MICROPHONE_START_TIMEOUT_MS = 15_000;
const DISPATCH_RECLAIM_AFTER_MS = 8_000;
const DISPATCH_RECLAIM_RETRY_MS = 8_000;
const DISPATCH_RECLAIM_MAX_ATTEMPTS = 3;

type ConnectionDetailsCacheEntry = {
  promise?: Promise<ConnectionDetails>;
  value?: ConnectionDetails;
  createdAt: number;
};

const connectionDetailsCache = new Map<string, ConnectionDetailsCacheEntry>();

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
    const normalizedName = error.name.trim().toLowerCase();
    const normalizedMessage = message.toLowerCase();
    if (
      normalizedName === 'notallowederror' ||
      normalizedMessage.includes('permission denied') ||
      normalizedMessage.includes('permission was denied')
    ) {
      return 'Microphone permission was denied. Allow microphone access for this site and start the call again.';
    }
    if (
      normalizedName === 'notfounderror' ||
      normalizedMessage.includes('requested device not found') ||
      normalizedMessage.includes('no microphone')
    ) {
      return 'Viventium could not find a microphone. Connect or enable a microphone and start the call again.';
    }
    if (message) {
      return message;
    }
  }
  return 'Unable to start this call right now. Start a fresh call from Viventium or use /call in Telegram.';
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
}

function stableCacheStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableCacheStringify(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableCacheStringify(entryValue)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeoutId: number | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
  }
}

function getConnectionDetailsTokenSource(fallbackOptions?: AgentTokenOptions): TokenSourceFixed {
  return TokenSource.literal(async (options?: AgentTokenOptions): Promise<ConnectionDetails> => {
    const mergedOptions = {
      ...(fallbackOptions ?? {}),
      ...(options ?? {}),
    };
    const cacheKey = stableCacheStringify(mergedOptions);
    const cached = connectionDetailsCache.get(cacheKey);
    if (cached) {
      if (cached.promise) {
        return cached.promise;
      }
      if (cached.value && Date.now() - cached.createdAt < CONNECTION_DETAILS_CACHE_MS) {
        return cached.value;
      }
    }

    const connectionDetailsPromise = (async () => {
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
    })();

    connectionDetailsCache.set(cacheKey, {
      promise: connectionDetailsPromise,
      createdAt: Date.now(),
    });
    try {
      const connectionDetails = await connectionDetailsPromise;
      connectionDetailsCache.set(cacheKey, {
        value: connectionDetails,
        createdAt: Date.now(),
      });
      return connectionDetails;
    } catch (error) {
      if (connectionDetailsCache.get(cacheKey)?.promise === connectionDetailsPromise) {
        connectionDetailsCache.delete(cacheKey);
      }
      throw error;
    } finally {
      const latest = connectionDetailsCache.get(cacheKey);
      if (latest?.promise === connectionDetailsPromise) {
        connectionDetailsCache.delete(cacheKey);
      }
    }
  });
}

async function requestDispatchReclaim(options: AgentTokenOptions): Promise<void> {
  const response = await fetch('/api/connection-details', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...options,
      reclaimDispatch: true,
    }),
    cache: 'no-store',
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(text || `Dispatch reclaim failed (${response.status}).`);
  }
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
  const [isStartInProgress, setIsStartInProgress] = useState(autoConnect && canStartCall);
  const [isMicrophoneStartupPending, setIsMicrophoneStartupPending] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startPromiseRef = useRef<Promise<boolean> | null>(null);
  const dispatchReclaimAttemptsRef = useRef(0);
  useEffect(() => {
    if (!isStartInProgress || startPromiseRef.current) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      if (!startPromiseRef.current) {
        setIsStartInProgress(false);
      }
    }, START_LATCH_WATCHDOG_MS);
    return () => window.clearTimeout(timeoutId);
  }, [isStartInProgress]);
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
   * Feature: Cold-start dispatch self-healing.
   * Purpose: LiveKit can accept an explicit dispatch before the voice worker is registered, then
   * leave the room without an agent after the user publishes audio. If a call-session room is
   * connected but still has no agent participant, reclaim and recreate the explicit dispatch.
   * === VIVENTIUM END === */
  useEffect(() => {
    if (
      !expectedCallSessionId ||
      !session.isConnected ||
      !tokenOptions?.roomName ||
      !tokenOptions.agentName
    ) {
      dispatchReclaimAttemptsRef.current = 0;
      return;
    }

    let cancelled = false;
    let intervalId: number | null = null;
    const hasAgentParticipant = () =>
      Array.from(session.room.remoteParticipants.values()).some((participant) =>
        Boolean((participant as { isAgent?: boolean }).isAgent)
      );

    if (hasAgentParticipant()) {
      dispatchReclaimAttemptsRef.current = 0;
      return;
    }

    const timeoutId = window.setTimeout(() => {
      intervalId = window.setInterval(() => {
        if (cancelled || hasAgentParticipant()) {
          if (intervalId !== null) {
            window.clearInterval(intervalId);
          }
          return;
        }
        if (dispatchReclaimAttemptsRef.current >= DISPATCH_RECLAIM_MAX_ATTEMPTS) {
          if (intervalId !== null) {
            window.clearInterval(intervalId);
          }
          return;
        }
        dispatchReclaimAttemptsRef.current += 1;
        requestDispatchReclaim(tokenOptions).catch((error) => {
          console.warn('[Viventium] Voice dispatch reclaim failed:', error);
        });
      }, DISPATCH_RECLAIM_RETRY_MS);

      if (!cancelled && !hasAgentParticipant()) {
        dispatchReclaimAttemptsRef.current += 1;
        requestDispatchReclaim(tokenOptions).catch((error) => {
          console.warn('[Viventium] Voice dispatch reclaim failed:', error);
        });
      }
    }, DISPATCH_RECLAIM_AFTER_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [expectedCallSessionId, session, session.isConnected, tokenOptions]);

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
      setIsMicrophoneStartupPending(true);
      await withTimeout(
        session.room.localParticipant.setMicrophoneEnabled(true),
        MICROPHONE_START_TIMEOUT_MS,
        'Viventium could not turn on the microphone before the browser responded. Check microphone permission and try again.'
      );
    } catch (error) {
      await session.end().catch((disconnectError) => {
        console.warn(
          '[Viventium] Failed to disconnect after microphone startup error:',
          disconnectError
        );
      });
      throw error;
    } finally {
      setIsMicrophoneStartupPending(false);
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
    if (startPromiseRef.current) {
      return startPromiseRef.current;
    }
    setStartError(null);
    setIsStartInProgress(true);
    const startPromise = (async () => {
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
      } finally {
        startPromiseRef.current = null;
        setIsStartInProgress(false);
      }
    })();
    startPromiseRef.current = startPromise;
    return startPromise;
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

  const startInProgressHint = isMicrophoneStartupPending
    ? 'Turning on your microphone...'
    : isStartInProgress
      ? 'Connecting Viventium to the room...'
      : null;
  const effectiveStartHint =
    startError ?? callSessionState.callStateError ?? startInProgressHint ?? startHint;
  const effectiveCanStartCall = canStartCall && !isStartInProgress;
  const effectiveStartButtonText = isMicrophoneStartupPending
    ? 'Turning on mic...'
    : isStartInProgress
      ? 'Starting call...'
      : startButtonText;

  return (
    <SessionProvider session={session}>
      <AppSetup />
      {/* VIVENTIUM START: let content taller than the viewport grow downward instead of clipping. */}
      <main className="grid min-h-svh grid-cols-1 place-content-center">
        {/* VIVENTIUM END */}
        <ViewController
          appConfig={appConfig}
          canStartCall={effectiveCanStartCall}
          startHint={effectiveStartHint ?? undefined}
          startButtonText={effectiveStartButtonText}
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

  const voiceSettingsStillLoading = Boolean(expectedCallSessionId) && voiceSettings.isLoading;
  const canStartCall =
    Boolean(expectedCallSessionId || appConfig.agentName) &&
    !remoteCallBlockedReason &&
    !voiceSettings.isSaving;
  const requiresMicGesture = Boolean(expectedCallSessionId);
  let startHint: string | undefined;
  let startButtonText: string | undefined;
  if (remoteCallBlockedReason) {
    startHint = remoteCallBlockedReason;
    startButtonText = 'Secure setup required';
  } else if (voiceSettingsStillLoading) {
    startHint = 'Tap Start chat to turn on your mic. Voice settings are still loading.';
  } else if (requiresMicGesture) {
    startHint = 'Tap Start chat to turn on your mic. Viventium joins right after.';
    if (voiceSettings.error) {
      startHint = `${startHint} ${voiceSettings.error}`;
    }
  } else if (!canStartCall) {
    /* === VIVENTIUM START ===
     * Purpose: Explain the fail-closed direct-playground state to non-technical users.
     * === VIVENTIUM END === */
    startHint =
      'Open Voice from a Viventium conversation. This page joins that conversation securely.';
  }

  if (!sessionRequested && !autoConnect) {
    return (
      <>
        {/* VIVENTIUM START: preserve the top of the setup surface on narrow/zoomed viewports. */}
        <main className="grid min-h-svh grid-cols-1 place-content-center">
          {/* VIVENTIUM END */}
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
