'use client';

import { type HTMLAttributes, useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Track } from 'livekit-client';
import { useChat, useRemoteParticipants } from '@livekit/components-react';
import { ChatTextIcon, EarIcon, PhoneDisconnectIcon } from '@phosphor-icons/react/dist/ssr';
import type { AppConfig } from '@/app-config';
import { TrackToggle } from '@/components/livekit/agent-control-bar/track-toggle';
import { Button } from '@/components/livekit/button';
import { Toggle } from '@/components/livekit/toggle';
import { VoiceRouteControl } from '@/components/livekit/voice-route-control';
import type { AssistantRouteInfo } from '@/hooks/useCallSessionVoiceSettings';
import {
  type VoiceRouteMetadata,
  type VoiceRouteState,
  buildRouteDisplayLabel,
  normalizeProviderName,
  useVoiceRoute,
} from '@/hooks/useVoiceRoute';
import { cn } from '@/lib/utils';
import { ChatInput } from './chat-input';
import { UseInputControlsProps, useInputControls } from './hooks/use-input-controls';
import { usePublishPermissions } from './hooks/use-publish-permissions';
import { TrackSelector } from './track-selector';

export interface ControlBarControls {
  leave?: boolean;
  camera?: boolean;
  microphone?: boolean;
  screenShare?: boolean;
  chat?: boolean;
}

export interface AgentControlBarProps extends UseInputControlsProps {
  appConfig: AppConfig;
  controls?: ControlBarControls;
  isConnected?: boolean;
  onChatOpenChange?: (open: boolean) => void;
  onDeviceError?: (error: { source: Track.Source; error: Error }) => void;
  wingModeEnabled?: boolean;
  wingModePending?: boolean;
  onWingModeChange?: (enabled: boolean) => void;
  listenOnlyModeEnabled?: boolean;
  listenOnlyModePending?: boolean;
  onListenOnlyModeChange?: (enabled: boolean) => void;
  assistantRoute?: AssistantRouteInfo | null;
  requestedVoiceRoute: VoiceRouteState;
  onRequestedVoiceRouteChange: (nextState: VoiceRouteState) => Promise<boolean> | void;
  voiceRouteEditingDisabled?: boolean;
  voiceRouteLoading?: boolean;
  voiceRouteSaving?: boolean;
  voiceRouteError?: string | null;
}

const WING_MODE_DISCLAIMER_KEY = 'viventium-wing-mode-disclaimer-v2';

function formatProviderName(value?: string | null) {
  const normalized = normalizeProviderName(value);
  switch (normalized) {
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'x_ai':
    case 'xai':
      return 'xAI';
    case 'groq':
      return 'Groq';
    case 'google':
      return 'Google';
    case 'perplexity':
      return 'Perplexity';
    default:
      if (!normalized) {
        return 'Not configured';
      }
      return normalized
        .split(/[_\s-]+/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
  }
}

function getProviderAuthMode(provider: string, appConfig: AppConfig) {
  const normalized = normalizeProviderName(provider);
  if (normalized === 'openai') {
    return normalizeProviderName(appConfig.openaiAuthMode);
  }
  if (normalized === 'anthropic') {
    return normalizeProviderName(appConfig.anthropicAuthMode);
  }
  return '';
}

function isProviderCoveredBySubscription(
  provider: string,
  appConfig: AppConfig,
  isLocalOverride?: boolean
) {
  const normalized = normalizeProviderName(provider);
  if (isLocalOverride === true) {
    return true;
  }
  if (!appConfig.localSubscriptionAuth) {
    return false;
  }
  const authMode = getProviderAuthMode(normalized, appConfig);
  return (
    (normalized === 'openai' || normalized === 'anthropic') && authMode === 'connected_account'
  );
}

type WingRouteSummary = {
  label: string;
  description: string;
  protectedFromDirectApiCosts: boolean | null;
};

function buildAssistantDisplayLabel(assignment: { provider: string | null; model: string | null }) {
  return [formatProviderName(assignment.provider), assignment.model].filter(Boolean).join(' • ');
}

function buildAssistantDescription(assistantRoute: AssistantRouteInfo | null) {
  if (!assistantRoute) {
    return 'Loading current agent route...';
  }

  const effectiveLabel = buildAssistantDisplayLabel(assistantRoute.effective);
  const fallbackLabel = assistantRoute.fallbackLlm
    ? `; fallback ${buildAssistantDisplayLabel(assistantRoute.fallbackLlm)}`
    : '';
  if (assistantRoute.inheritsPrimary) {
    return `${effectiveLabel} (agent primary LLM${fallbackLabel})`;
  }
  return `${effectiveLabel} (agent Voice Call LLM${fallbackLabel})`;
}

function buildWingRouteSummaries(
  voiceRoute: VoiceRouteMetadata,
  assistantRoute: AssistantRouteInfo | null,
  appConfig: AppConfig
): WingRouteSummary[] {
  return [
    {
      label: 'Listening',
      description: buildRouteDisplayLabel(voiceRoute.stt),
      protectedFromDirectApiCosts: isProviderCoveredBySubscription(
        voiceRoute.stt.provider ?? '',
        appConfig,
        voiceRoute.stt.isLocal
      ),
    },
    {
      label: 'Speaking',
      description: buildRouteDisplayLabel(voiceRoute.tts),
      protectedFromDirectApiCosts: isProviderCoveredBySubscription(
        voiceRoute.tts.provider ?? '',
        appConfig,
        voiceRoute.tts.isLocal
      ),
    },
    {
      label: 'Assistant',
      description: buildAssistantDescription(assistantRoute),
      protectedFromDirectApiCosts: assistantRoute
        ? isProviderCoveredBySubscription(assistantRoute.effective.provider ?? '', appConfig)
        : null,
    },
  ];
}

function WingModeDisclaimer({
  open,
  routeSummaries,
  hasMeteredPath,
  onClose,
  onConfirm,
}: {
  open: boolean;
  routeSummaries: WingRouteSummary[];
  hasMeteredPath: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-slate-950/70 px-4 py-6 backdrop-blur-md">
      <div className="w-full max-w-xl overflow-hidden rounded-[30px] border border-white/10 bg-[linear-gradient(160deg,rgba(7,15,24,0.96),rgba(13,32,43,0.94))] text-slate-50 shadow-[0_32px_120px_rgba(2,8,23,0.65)]">
        <div className="border-b border-white/10 px-6 py-5">
          <p className="text-[11px] font-bold tracking-[0.35em] text-cyan-200/75 uppercase">
            Wing Mode
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
            You&apos;ve had a wingman. Now try a Wing AI.
          </h2>
          <p className="mt-3 text-sm leading-6 text-slate-200/80">
            Wing Mode keeps Viventium quietly aware while you work, drive, study, clean, or sit in a
            meeting. It listens for a real summons, ignores background chatter, and stays out of the
            way until you clearly want it.
          </p>
        </div>

        <div className="space-y-4 px-6 py-5">
          <div className="rounded-3xl border border-cyan-400/20 bg-cyan-400/8 p-4">
            <p className="text-xs font-semibold tracking-[0.24em] text-cyan-100/70 uppercase">
              Current Voice Setup
            </p>
            <div className="mt-3 space-y-3">
              {routeSummaries.map((item) => (
                <div key={item.label} className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-white">{item.label}</p>
                    <p className="mt-1 text-sm text-slate-200/80">{item.description}</p>
                  </div>
                  <span
                    className={cn(
                      'rounded-full px-3 py-1 text-[11px] font-semibold tracking-[0.18em] uppercase',
                      item.protectedFromDirectApiCosts === true
                        ? 'bg-emerald-400/15 text-emerald-200'
                        : item.protectedFromDirectApiCosts === false
                          ? 'bg-amber-400/15 text-amber-200'
                          : 'bg-slate-400/20 text-slate-100'
                    )}
                  >
                    {item.protectedFromDirectApiCosts === true
                      ? 'Covered'
                      : item.protectedFromDirectApiCosts === false
                        ? 'Metered'
                        : 'Agent setting'}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {hasMeteredPath ? (
            <div className="rounded-3xl border border-amber-400/25 bg-amber-400/10 p-4 text-sm leading-6 text-amber-50/90">
              Leaving Wing Mode on can rack up API costs because ambient audio still flows through
              transcription, reply judgment, and speech whenever the current setup is metered. For a
              safer everyday setup, connect your OpenAI or Anthropic account in Viventium&apos;s
              Connected Accounts, then pick those providers in Agent Builder or switch listening and
              speaking to local options when you want near-zero marginal cost.
            </div>
          ) : (
            <div className="rounded-3xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm leading-6 text-emerald-50/90">
              This setup is already leaning on local or subscription-covered voice paths, so Wing
              Mode is much safer to leave on for long passive sessions.
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-white/10 px-6 py-5">
          <Button variant="outline" onClick={onClose}>
            Not now
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Enable Wing Mode
          </Button>
        </div>
      </div>
    </div>
  );
}

function WingModeIcon({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('size-4 shrink-0 bg-current', className)}
      style={{
        WebkitMaskImage: "url('/icons/wing-mode.png')",
        maskImage: "url('/icons/wing-mode.png')",
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
      }}
    />
  );
}

/**
 * A control bar specifically designed for voice assistant interfaces
 */
export function AgentControlBar({
  appConfig,
  controls,
  saveUserChoices = true,
  className,
  isConnected = false,
  onDisconnect,
  onDeviceError,
  onChatOpenChange,
  wingModeEnabled = false,
  wingModePending = false,
  onWingModeChange,
  listenOnlyModeEnabled = false,
  listenOnlyModePending = false,
  onListenOnlyModeChange,
  assistantRoute = null,
  requestedVoiceRoute,
  onRequestedVoiceRouteChange,
  voiceRouteEditingDisabled = false,
  voiceRouteLoading = false,
  voiceRouteSaving = false,
  voiceRouteError = null,
  ...props
}: AgentControlBarProps & HTMLAttributes<HTMLDivElement>) {
  const { send } = useChat();
  const participants = useRemoteParticipants();
  const { voiceRoute, hasLiveRoute, isLoading: liveVoiceRouteLoading } = useVoiceRoute(appConfig);
  const [chatOpen, setChatOpen] = useState(false);
  const [wingDisclaimerSeen, setWingDisclaimerSeen] = useState(false);
  const [showWingDisclaimer, setShowWingDisclaimer] = useState(false);
  const listenOnlyModeTooltipId = useId();
  const publishPermissions = usePublishPermissions();
  const {
    micTrackRef,
    cameraToggle,
    microphoneToggle,
    screenShareToggle,
    handleAudioDeviceChange,
    handleVideoDeviceChange,
    handleMicrophoneDeviceSelectError,
    handleCameraDeviceSelectError,
  } = useInputControls({ onDeviceError, saveUserChoices });

  const handleSendMessage = async (message: string) => {
    if (listenOnlyModeEnabled) {
      return;
    }
    await send(message);
  };

  const handleToggleTranscript = useCallback(
    (open: boolean) => {
      setChatOpen(open);
      onChatOpenChange?.(open);
    },
    [onChatOpenChange, setChatOpen]
  );

  const visibleControls = {
    leave: controls?.leave ?? true,
    microphone: controls?.microphone ?? publishPermissions.microphone,
    screenShare: controls?.screenShare ?? publishPermissions.screenShare,
    camera: controls?.camera ?? publishPermissions.camera,
    chat: controls?.chat ?? publishPermissions.data,
  };

  const isAgentAvailable = participants.some((p) => p.isAgent);
  const wingModeTooltip =
    "Wing Mode: You've had a wingman. Now try a Wing AI. Viventium stays quietly aware, ignores background chatter, and only responds when you're clearly talking to it.";
  const listenOnlyModeTooltip =
    'Listen-Only Mode lets Viventium be here with you without interrupting. It listens through ' +
    'the current voice route and remembers the conversation later during memory consolidation. ' +
    'It will not answer, speak, run tools, or update live memory while this is on. Different speakers ' +
    'can be separated only when they join as separate call participants.';
  const wingRouteSummaries = useMemo(
    () => buildWingRouteSummaries(voiceRoute, assistantRoute, appConfig),
    [appConfig, assistantRoute, voiceRoute]
  );
  const wingModeHasMeteredPath = useMemo(
    () => wingRouteSummaries.some((item) => item.protectedFromDirectApiCosts !== true),
    [wingRouteSummaries]
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setWingDisclaimerSeen(window.localStorage.getItem(WING_MODE_DISCLAIMER_KEY) === 'accepted');
  }, []);

  const handleWingModeToggle = useCallback(
    (enabled: boolean) => {
      if (!onWingModeChange) {
        return;
      }
      if (enabled && !wingModeEnabled && !wingDisclaimerSeen) {
        setShowWingDisclaimer(true);
        return;
      }
      onWingModeChange(enabled);
    },
    [onWingModeChange, wingDisclaimerSeen, wingModeEnabled]
  );

  const confirmWingModeDisclaimer = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(WING_MODE_DISCLAIMER_KEY, 'accepted');
    }
    setWingDisclaimerSeen(true);
    setShowWingDisclaimer(false);
    onWingModeChange?.(true);
  }, [onWingModeChange]);

  const handleListenOnlyModeToggle = useCallback(
    (enabled: boolean) => {
      onListenOnlyModeChange?.(enabled);
    },
    [onListenOnlyModeChange]
  );

  return (
    <>
      <WingModeDisclaimer
        open={showWingDisclaimer}
        routeSummaries={wingRouteSummaries}
        hasMeteredPath={wingModeHasMeteredPath}
        onClose={() => setShowWingDisclaimer(false)}
        onConfirm={confirmWingModeDisclaimer}
      />
      <div
        aria-label="Voice assistant controls"
        className={cn(
          'bg-background border-input/50 dark:border-muted flex flex-col rounded-[31px] border p-3 drop-shadow-md/3',
          className
        )}
        {...props}
      >
        {/* Chat Input */}
        {visibleControls.chat && !listenOnlyModeEnabled && (
          <ChatInput
            chatOpen={chatOpen}
            isAgentAvailable={isAgentAvailable}
            onSend={handleSendMessage}
          />
        )}

        <div className="flex flex-wrap items-center gap-1">
          <div className="flex min-w-0 grow flex-wrap gap-1">
            {/* Toggle Microphone */}
            {visibleControls.microphone && (
              <TrackSelector
                kind="audioinput"
                aria-label="Toggle microphone"
                source={Track.Source.Microphone}
                pressed={microphoneToggle.enabled}
                disabled={microphoneToggle.pending}
                audioTrackRef={micTrackRef}
                onPressedChange={microphoneToggle.toggle}
                onMediaDeviceError={handleMicrophoneDeviceSelectError}
                onActiveDeviceChange={handleAudioDeviceChange}
              />
            )}

            {/* Toggle Camera */}
            {visibleControls.camera && (
              <TrackSelector
                kind="videoinput"
                aria-label="Toggle camera"
                source={Track.Source.Camera}
                pressed={cameraToggle.enabled}
                pending={cameraToggle.pending}
                disabled={cameraToggle.pending}
                onPressedChange={cameraToggle.toggle}
                onMediaDeviceError={handleCameraDeviceSelectError}
                onActiveDeviceChange={handleVideoDeviceChange}
              />
            )}

            {/* Toggle Screen Share */}
            {visibleControls.screenShare && (
              <TrackToggle
                size="icon"
                variant="secondary"
                aria-label="Toggle screen share"
                source={Track.Source.ScreenShare}
                pressed={screenShareToggle.enabled}
                disabled={screenShareToggle.pending}
                onPressedChange={screenShareToggle.toggle}
              />
            )}

            {/* Toggle Transcript */}
            <Toggle
              size="icon"
              variant="secondary"
              aria-label="Toggle transcript"
              pressed={chatOpen}
              onPressedChange={handleToggleTranscript}
            >
              <ChatTextIcon weight="bold" />
            </Toggle>

            <VoiceRouteControl
              voiceRoute={voiceRoute}
              requestedVoiceRoute={requestedVoiceRoute}
              onRequestedVoiceRouteChange={onRequestedVoiceRouteChange}
              editingDisabled={voiceRouteEditingDisabled}
              hasLiveRoute={hasLiveRoute}
              isConnected={isConnected}
              savedRouteLoading={voiceRouteLoading}
              liveRouteLoading={isConnected && liveVoiceRouteLoading}
              isSaving={voiceRouteSaving}
              error={voiceRouteError}
            />

            {onListenOnlyModeChange && (
              <span className="group/listen-only-tooltip relative inline-flex">
                <Toggle
                  size="icon"
                  variant="secondary"
                  aria-label="Toggle Listen-Only Mode"
                  aria-describedby={listenOnlyModeTooltipId}
                  pressed={listenOnlyModeEnabled}
                  disabled={listenOnlyModePending || wingModePending}
                  onPressedChange={handleListenOnlyModeToggle}
                  className="border border-transparent data-[state=on]:border-emerald-400/35 data-[state=on]:bg-emerald-500/15 data-[state=on]:text-emerald-700 data-[state=on]:shadow-[0_0_24px_rgba(16,185,129,0.22)] dark:data-[state=on]:text-emerald-200"
                >
                  <EarIcon weight="bold" />
                  <span className="sr-only">Listen-Only Mode</span>
                </Toggle>
                <span
                  id={listenOnlyModeTooltipId}
                  role="tooltip"
                  className="bg-popover text-popover-foreground border-border/80 pointer-events-none fixed right-4 bottom-24 left-4 z-20 w-auto max-w-none translate-x-0 rounded-lg border px-3 py-2 text-[11px] leading-5 normal-case opacity-0 shadow-[0_16px_40px_rgba(15,23,42,0.18)] transition-opacity duration-150 group-focus-within/listen-only-tooltip:opacity-100 group-hover/listen-only-tooltip:opacity-100 sm:absolute sm:right-0 sm:bottom-full sm:left-auto sm:mb-2 sm:w-72 sm:max-w-[calc(100vw-2rem)]"
                >
                  {listenOnlyModeTooltip}
                </span>
              </span>
            )}

            {onWingModeChange && (
              <Toggle
                size="icon"
                variant="secondary"
                aria-label="Toggle Wing Mode"
                title={wingModeTooltip}
                pressed={wingModeEnabled}
                disabled={wingModePending || listenOnlyModePending}
                onPressedChange={handleWingModeToggle}
                className="border border-transparent data-[state=on]:border-cyan-400/30 data-[state=on]:bg-cyan-500/15 data-[state=on]:text-cyan-700 data-[state=on]:shadow-[0_0_24px_rgba(34,211,238,0.18)] dark:data-[state=on]:text-cyan-200"
              >
                <WingModeIcon />
                <span className="sr-only">Wing Mode</span>
              </Toggle>
            )}
          </div>

          {/* Disconnect */}
          {visibleControls.leave && (
            <Button
              variant="destructive"
              aria-label="End call"
              onClick={onDisconnect}
              disabled={!isConnected}
              className="h-9 w-9 px-0 font-mono md:w-auto md:px-4"
            >
              <PhoneDisconnectIcon weight="bold" />
              <span className="hidden md:inline">END CALL</span>
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
