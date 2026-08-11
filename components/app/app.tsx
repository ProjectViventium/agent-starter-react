'use client';

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ConnectionState,
  TokenSource,
  type TokenSourceConfigurable,
  type TokenSourceFetchOptions,
  type TokenSourceFixed,
} from 'livekit-client';
import { RoomAudioRenderer, SessionProvider, useSession } from '@livekit/components-react';
import type { AppConfig } from '@/app-config';
import { ViewController } from '@/components/app/view-controller';
import { WelcomeView } from '@/components/app/welcome-view';
import { Toaster } from '@/components/livekit/toaster';
import { useAgentErrors } from '@/hooks/useAgentErrors';
import { useCallSessionState } from '@/hooks/useCallSessionState';
import { useCallSessionVoiceSettings } from '@/hooks/useCallSessionVoiceSettings';
import { useConnectionRecovery } from '@/hooks/useConnectionRecovery';
import { useDebugMode } from '@/hooks/useDebug';
import { buildFallbackVoiceRoute } from '@/hooks/useVoiceRoute';
import { useWakeLock } from '@/hooks/useWakeLock';
import {
  callBrowserCapabilityHeaders,
  captureCallBrowserCapability,
} from '@/lib/call-browser-capability';
import {
  type CallIssue,
  CallRequestError,
  callIssueFromResponse,
  classifyCallIssue,
  readCallDeepLink,
} from '@/lib/call-start';
import { publishVoiceCallState } from '@/lib/call-state';
import { enableCallMicrophone, queryMicrophonePermissionState } from '@/lib/microphone-start';
import { getSandboxTokenSource, shouldUseSandboxTokenSource } from '@/lib/utils';

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
const canonicalConnectionDetails = new Map<
  string,
  Pick<ConnectionDetails, 'roomName' | 'participantIdentity'>
>();
const MAX_CANONICAL_CONNECTION_SESSIONS = 128;

type ConnectionDetails = {
  serverUrl: string;
  roomName: string;
  participantToken: string;
  participantName?: string;
  participantIdentity?: string;
};

function callSessionIdFromOptions(options: AgentTokenOptions): string | null {
  if (typeof options.agentMetadata !== 'string') {
    return null;
  }
  try {
    const metadata = JSON.parse(options.agentMetadata) as { callSessionId?: unknown };
    return typeof metadata.callSessionId === 'string' && metadata.callSessionId.trim()
      ? metadata.callSessionId.trim()
      : null;
  } catch {
    return null;
  }
}

function validateConnectionDetails(
  payload: unknown,
  options: AgentTokenOptions
): ConnectionDetails {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new CallRequestError({
      kind: 'gateway_down',
      message: 'The voice runtime returned invalid connection details.',
    });
  }
  const value = payload as Record<string, unknown>;
  if (
    typeof value.serverUrl !== 'string' ||
    !value.serverUrl.trim() ||
    typeof value.roomName !== 'string' ||
    !value.roomName.trim() ||
    typeof value.participantToken !== 'string' ||
    !value.participantToken.trim()
  ) {
    throw new CallRequestError({
      kind: 'gateway_down',
      message: 'The voice runtime returned incomplete connection details.',
    });
  }
  const details: ConnectionDetails = {
    serverUrl: value.serverUrl,
    roomName: value.roomName,
    participantToken: value.participantToken,
    ...(typeof value.participantName === 'string'
      ? { participantName: value.participantName }
      : {}),
    ...(typeof value.participantIdentity === 'string'
      ? { participantIdentity: value.participantIdentity }
      : {}),
  };
  const callSessionId = callSessionIdFromOptions(options);
  if (!callSessionId) {
    return details;
  }
  if (options.roomName && options.roomName !== details.roomName) {
    throw new CallRequestError({
      kind: 'auth_expired',
      message: 'The signed call session does not match the connected room.',
    });
  }
  if (!details.participantIdentity) {
    throw new CallRequestError({
      kind: 'auth_expired',
      message: 'The signed call session returned no stable owner identity.',
    });
  }
  const prior = canonicalConnectionDetails.get(callSessionId);
  if (
    prior &&
    (prior.roomName !== details.roomName ||
      prior.participantIdentity !== details.participantIdentity)
  ) {
    throw new CallRequestError({
      kind: 'auth_expired',
      message: 'The signed call identity changed during reconnect.',
    });
  }
  canonicalConnectionDetails.delete(callSessionId);
  canonicalConnectionDetails.set(callSessionId, {
    roomName: details.roomName,
    participantIdentity: details.participantIdentity,
  });
  while (canonicalConnectionDetails.size > MAX_CANONICAL_CONNECTION_SESSIONS) {
    const oldest = canonicalConnectionDetails.keys().next();
    if (oldest.done) break;
    canonicalConnectionDetails.delete(oldest.value);
  }
  return details;
}

function isLoopbackHost(hostname: string | null | undefined): boolean {
  const normalized = (hostname ?? '')
    .trim()
    .replace(/^\[(.*)\]$/, '$1')
    .toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

function buildCallSessionMetadata(callSessionId: string) {
  return JSON.stringify({ callSessionId });
}

function parseCallSessionIdFromTokenOptions(options?: AgentTokenOptions): string | null {
  for (const candidate of [options?.agentMetadata, options?.participantMetadata]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    try {
      const parsed = JSON.parse(candidate) as { callSessionId?: unknown };
      if (
        typeof parsed.callSessionId === 'string' &&
        /^[A-Za-z0-9._:-]{1,160}$/.test(parsed.callSessionId)
      ) {
        return parsed.callSessionId;
      }
    } catch {
      // Structured metadata only; malformed values carry no call authority.
    }
  }
  return null;
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
              ...callBrowserCapabilityHeaders(
                parseCallSessionIdFromTokenOptions(mergedOptions) ?? ''
              ),
            },
            body: JSON.stringify(mergedOptions),
            cache: 'no-store',
          });
          break;
        } catch (error) {
          const shouldRetry =
            error instanceof TypeError && attempt + 1 < CONNECTION_DETAILS_MAX_ATTEMPTS;
          if (!shouldRetry) {
            throw new CallRequestError({
              kind: 'gateway_down',
              message: 'Viventium could not reach the voice runtime.',
            });
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
        const retryable = Boolean(
          payload &&
            typeof payload === 'object' &&
            'retryable' in payload &&
            payload.retryable === true
        );
        throw new CallRequestError(callIssueFromResponse(response.status, payload), retryable);
      }

      return validateConnectionDetails(payload, mergedOptions);
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
      ...callBrowserCapabilityHeaders(parseCallSessionIdFromTokenOptions(options) ?? ''),
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
  expectedConversationId: string | null;
  canStartCall: boolean;
  startHint?: string;
  startButtonText?: string;
  preflightIssue?: CallIssue | null;
  appConfig: AppConfig;
};

function AppSession({
  tokenSource,
  tokenOptions,
  autoConnect,
  expectedRoomName,
  expectedCallSessionId,
  expectedConversationId,
  canStartCall,
  startHint,
  startButtonText,
  preflightIssue,
  appConfig,
}: AppSessionProps) {
  const [hasAutoStarted, setHasAutoStarted] = useState(false);
  const [isStartInProgress, setIsStartInProgress] = useState(autoConnect && canStartCall);
  const [isMicrophoneStartupPending, setIsMicrophoneStartupPending] = useState(false);
  const [audioRecoveryRequired, setAudioRecoveryRequired] = useState(false);
  const [startError, setStartError] = useState<CallIssue | null>(null);
  const [hasEnded, setHasEnded] = useState(false);
  const startPromiseRef = useRef<Promise<boolean> | null>(null);
  const dispatchReclaimAttemptsRef = useRef(0);
  const publishedModeStateRef = useRef<{ callSessionId: string; revision: number } | null>(null);
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
      !hasEnded &&
      (session.isConnected || session.connectionState === ConnectionState.Connecting)
  );

  useEffect(() => {
    const transition = callSessionState.lastModeTransition;
    if (
      !transition ||
      !expectedCallSessionId ||
      transition.callSessionId !== expectedCallSessionId ||
      !session.isConnected
    ) {
      return;
    }
    const published = publishedModeStateRef.current;
    if (
      published?.callSessionId === transition.callSessionId &&
      published.revision >= transition.revision
    ) {
      return;
    }
    let cancelled = false;
    let retryTimer: number | null = null;
    const publish = (attempt: number) => {
      void publishVoiceCallState(session.room.localParticipant, transition)
        .then(() => {
          if (!cancelled) {
            publishedModeStateRef.current = {
              callSessionId: transition.callSessionId,
              revision: transition.revision,
            };
          }
        })
        .catch((error) => {
          if (cancelled) return;
          if (attempt < 2) {
            retryTimer = window.setTimeout(() => publish(attempt + 1), 250 * (attempt + 1));
          } else {
            console.warn('[Viventium] Authoritative call mode delivery failed:', error);
          }
        });
    };
    publish(0);
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [
    callSessionState.lastModeTransition,
    expectedCallSessionId,
    session.isConnected,
    session.room,
  ]);

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
  const startRoomAudio = useCallback(async () => {
    try {
      await session.room.startAudio();
      setAudioRecoveryRequired(false);
      return true;
    } catch {
      setAudioRecoveryRequired(true);
      return false;
    }
  }, [session.room]);
  const startSession = useCallback(async () => {
    if (!shouldDeferMicrophoneUntilConnected) {
      await session.start();
      await startRoomAudio();
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
      const permissionState = await queryMicrophonePermissionState();
      await enableCallMicrophone({
        permissionState,
        enable: () => session.room.localParticipant.setMicrophoneEnabled(true),
        disable: () => session.room.localParticipant.setMicrophoneEnabled(false),
        grantedTimeoutMs: MICROPHONE_START_TIMEOUT_MS,
      });
      await startRoomAudio();
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
  }, [session, shouldDeferMicrophoneUntilConnected, startRoomAudio]);

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
        const issue = classifyCallIssue(error);
        console.error('Call start failed:', error);
        setStartError(issue);
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
  const effectiveStartHint = hasEnded
    ? 'Call ended. Any active work is continuing in your linked Viventium chat.'
    : (callSessionState.callStateError ?? startInProgressHint ?? startHint);
  const effectiveCanStartCall = canStartCall && !isStartInProgress && !hasEnded;
  const effectiveStartButtonText = hasEnded
    ? 'Call ended'
    : isMicrophoneStartupPending
      ? 'Turning on mic...'
      : isStartInProgress
        ? 'Starting call...'
        : startButtonText;

  return (
    <SessionProvider session={session}>
      <AppSetup />
      <main className="grid min-h-svh grid-cols-1 place-content-center">
        <ViewController
          appConfig={appConfig}
          canStartCall={effectiveCanStartCall}
          startHint={effectiveStartHint ?? undefined}
          startButtonText={effectiveStartButtonText}
          onStartCall={() => {
            void startCall();
          }}
          callSessionId={expectedCallSessionId}
          conversationId={expectedConversationId}
          mode={callSessionState.mode}
          modePending={callSessionState.modePending}
          onModeChange={(mode) => void callSessionState.setMode(mode)}
          callStateError={callSessionState.callStateError}
          onCallEnded={() => setHasEnded(true)}
          callIssue={startError ?? callSessionState.callStateIssue ?? preflightIssue}
          onRetry={() => void startCall()}
          audioRecoveryRequired={audioRecoveryRequired}
          onAudioRecovery={() => void startRoomAudio()}
          callEnded={hasEnded}
        />
      </main>
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
  const [expectedConversationId, setExpectedConversationId] = useState<string | null>(null);
  const [remoteCallBlockedReason, setRemoteCallBlockedReason] = useState<string | null>(null);
  const fallbackVoiceRoute = useMemo(() => buildFallbackVoiceRoute(appConfig), [appConfig]);
  const voiceSettings = useCallSessionVoiceSettings(expectedCallSessionId, fallbackVoiceRoute);
  const effectiveTokenOptions = useMemo(() => {
    if (!expectedCallSessionId) {
      return tokenOptions;
    }

    const metadata = buildCallSessionMetadata(expectedCallSessionId);
    return {
      ...(tokenOptions ?? {}),
      agentMetadata: metadata,
      participantMetadata: metadata,
    };
  }, [expectedCallSessionId, tokenOptions]);
  const tokenSource = useMemo(() => {
    return shouldUseSandboxTokenSource(expectedCallSessionId)
      ? getSandboxTokenSource(appConfig)
      : getConnectionDetailsTokenSource(effectiveTokenOptions);
  }, [appConfig, effectiveTokenOptions, expectedCallSessionId]);

  useLayoutEffect(() => {
    captureCallBrowserCapability({
      search: window.location.search,
      hash: window.location.hash,
      pathname: window.location.pathname,
      storage: window.sessionStorage,
      replaceUrl: (url) => window.history.replaceState(window.history.state, '', url),
    });
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
    const deepLink = readCallDeepLink(window.location.search);
    if (deepLink.tokenOptions) {
      setTokenOptions((prev) => ({ ...(prev ?? {}), ...deepLink.tokenOptions }));
    }
    setExpectedRoomName(deepLink.expectedRoomName);
    setExpectedCallSessionId(deepLink.expectedCallSessionId);
    setExpectedConversationId(deepLink.expectedConversationId);
    if (deepLink.autoConnect) {
      setAutoConnect(true);
    }
    setDeepLinkReady(true);
  }, [clientReady]);

  if (!clientReady || !deepLinkReady) {
    return null;
  }

  const voiceSettingsStillLoading = Boolean(expectedCallSessionId) && voiceSettings.isLoading;
  const hasAuthoritativeRoute = Boolean(
    !expectedCallSessionId ||
      (voiceSettings.configuredVoiceRoute.stt.provider &&
        voiceSettings.configuredVoiceRoute.tts.provider)
  );
  const canStartCall =
    Boolean(expectedCallSessionId || appConfig.agentName) &&
    !remoteCallBlockedReason &&
    !voiceSettings.isSaving &&
    !voiceSettingsStillLoading &&
    !voiceSettings.error &&
    hasAuthoritativeRoute;
  let startHint: string | undefined;
  let startButtonText: string | undefined;
  let preflightIssue: CallIssue | null = null;
  if (remoteCallBlockedReason) {
    startHint = remoteCallBlockedReason;
    startButtonText = 'Secure setup required';
  } else if (voiceSettingsStillLoading) {
    startHint = 'Preparing your configured voice route...';
  } else if (voiceSettings.error) {
    startHint = voiceSettings.error;
    preflightIssue = voiceSettings.issue;
  } else if (!hasAuthoritativeRoute) {
    startHint = 'Voice is not configured. Viventium did not switch providers automatically.';
    preflightIssue = { kind: 'no_route', message: startHint };
  }

  if (!sessionRequested && !autoConnect) {
    return (
      <>
        <main className="grid min-h-svh grid-cols-1 place-content-center">
          <WelcomeView
            startButtonText={
              startButtonText ?? (canStartCall ? appConfig.startButtonText : 'Open from Viventium')
            }
            onStartCall={() => {
              setSessionRequested(true);
            }}
            startDisabled={!canStartCall}
            helperText={preflightIssue ? undefined : startHint}
            callIssue={preflightIssue}
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
      expectedConversationId={expectedConversationId}
      canStartCall={canStartCall}
      startHint={startHint}
      startButtonText={startButtonText}
      preflightIssue={preflightIssue}
      appConfig={appConfig}
    />
  );
}
