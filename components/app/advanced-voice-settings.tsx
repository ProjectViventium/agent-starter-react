'use client';

import React, { useRef } from 'react';
import { ConnectionState } from 'livekit-client';
import { useSessionContext } from '@livekit/components-react';
import { GearIcon, HeadphonesIcon, SpeakerHighIcon, XIcon } from '@phosphor-icons/react/dist/ssr';
import type { AppConfig } from '@/app-config';
import { VoiceRouteControl } from '@/components/livekit/voice-route-control';
import type { UseCallSessionVoiceSettingsResult } from '@/hooks/useCallSessionVoiceSettings';
import type { DeviceSoundMode, DeviceSoundSettings } from '@/hooks/useDeviceSoundMode';
import { type VoiceRouteMetadata, useVoiceRoute } from '@/hooks/useVoiceRoute';

/* VIVENTIUM START
 * Feature: Per-call voice route visibility and control.
 * Purpose: Show the configured and live speech/assistant routes before, during, and after a call
 * without changing account defaults or silently switching providers.
 * VIVENTIUM END */

type AdvancedVoiceSettingsProps = {
  settings: UseCallSessionVoiceSettingsResult;
  liveRoute?: VoiceRouteMetadata | null;
  readOnly?: boolean;
  hasCall?: boolean;
  deviceSound?: DeviceSoundSettings;
  activeSoundMode?: DeviceSoundMode | null;
};

export function AdvancedVoiceSettings({
  settings,
  liveRoute,
  readOnly = false,
  hasCall = true,
  deviceSound,
  activeSoundMode,
}: AdvancedVoiceSettingsProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const route = liveRoute ?? settings.selectionVoiceRoute;
  const assistant = settings.assistantRoute;
  const close = () => {
    if (!detailsRef.current) return;
    detailsRef.current.open = false;
    detailsRef.current.querySelector('summary')?.focus();
  };

  return (
    <details
      ref={detailsRef}
      className="fixed top-3 right-3 z-[90] max-w-[calc(100vw-1.5rem)]"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault();
          close();
        }
      }}
    >
      <summary
        aria-label="Advanced voice settings"
        className="bg-background border-border ml-auto flex w-fit cursor-pointer items-center gap-2 rounded-full border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        <GearIcon size={20} aria-hidden="true" /> Voice
      </summary>
      <section
        aria-label="Advanced voice settings"
        className="bg-background border-border mt-2 max-h-[75svh] w-[min(26rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-xl border p-3 shadow-sm"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-semibold">Voice settings</h2>
          <button
            type="button"
            aria-label="Close settings"
            onClick={close}
            className="hover:bg-muted flex size-11 items-center justify-center rounded-full"
          >
            <XIcon size={20} aria-hidden="true" />
          </button>
        </div>
        {deviceSound && (
          <fieldset className="mb-4">
            <legend className="mb-2 text-sm font-medium">Sound on this device</legend>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['standard', 'Speaker', SpeakerHighIcon],
                  ['earpiece', 'Earpiece / headphones', HeadphonesIcon],
                ] as const
              ).map(([mode, label, Icon]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={deviceSound.mode === mode}
                  disabled={!deviceSound.ready}
                  onClick={() => deviceSound.selectMode(mode)}
                  className={`flex min-h-24 flex-col items-center justify-center gap-2 rounded-xl border p-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 ${deviceSound.mode === mode ? 'border-primary bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:bg-muted'}`}
                >
                  <Icon
                    size={28}
                    weight={deviceSound.mode === mode ? 'fill' : 'regular'}
                    aria-hidden="true"
                  />
                  {label}
                </button>
              ))}
            </div>
            {deviceSound.mode === 'earpiece' && (
              <p className="text-muted-foreground mt-2 text-xs">
                For phone crackle. Hold to your ear or use headphones.
              </p>
            )}
            {activeSoundMode && deviceSound.mode !== activeSoundMode && (
              <p role="status" className="mt-2 text-sm">
                Saved for your next call.
              </p>
            )}
            {deviceSound.notice && (
              <p role="status" className="mt-2 text-sm">
                {deviceSound.notice}
              </p>
            )}
          </fieldset>
        )}
        {hasCall && (
          <details className="border-border border-t pt-2">
            <summary className="cursor-pointer py-3 text-sm font-medium">
              Voice and assistant
            </summary>
            <p className="text-muted-foreground mb-3 text-xs">
              {readOnly ? 'Current call settings.' : 'For this call. Save defaults in your chat.'}
            </p>
            {route ? (
              <VoiceRouteControl
                inline
                voiceRoute={route}
                requestedVoiceRoute={settings.configuredVoiceRoute}
                onRequestedVoiceRouteChange={readOnly ? undefined : settings.setRequestedVoiceRoute}
                hasLiveRoute={Boolean(liveRoute)}
                isConnected={readOnly}
                savedRouteLoading={settings.isLoading}
                liveRouteLoading={readOnly && !liveRoute}
                isSaving={settings.isSaving}
                error={settings.error}
                notice={settings.notice}
              />
            ) : (
              <p role={settings.error ? 'alert' : 'status'} className="text-sm">
                {settings.error ||
                  (settings.isLoading
                    ? 'Loading voice settings…'
                    : 'Voice settings are unavailable.')}
              </p>
            )}
            {assistant ? (
              <dl className="mt-4 space-y-2 text-sm break-words">
                <div>
                  <dt className="font-medium">Assistant</dt>
                  <dd>
                    {assistant.effective.providerLabel ?? assistant.effective.provider} ·{' '}
                    {assistant.effective.modelLabel ?? assistant.effective.model}
                    {assistant.effective.effort ? (
                      <>
                        {' '}
                        · <span className="capitalize">{assistant.effective.effort}</span>
                      </>
                    ) : null}
                  </dd>
                </div>
                {assistant.voiceFallbackLlm || assistant.fallbackLlm ? (
                  <div>
                    <dt className="font-medium">Backup assistant</dt>
                    <dd>
                      {(assistant.voiceFallbackLlm ?? assistant.fallbackLlm)?.providerLabel ??
                        (assistant.voiceFallbackLlm ?? assistant.fallbackLlm)?.provider}{' '}
                      ·{' '}
                      {(assistant.voiceFallbackLlm ?? assistant.fallbackLlm)?.modelLabel ??
                        (assistant.voiceFallbackLlm ?? assistant.fallbackLlm)?.model}
                      {(assistant.voiceFallbackLlm ?? assistant.fallbackLlm)?.effort ? (
                        <>
                          {' '}
                          ·{' '}
                          <span className="capitalize">
                            {(assistant.voiceFallbackLlm ?? assistant.fallbackLlm)?.effort}
                          </span>
                        </>
                      ) : null}
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
            {settings.selectionVoiceRoute ? (
              <details className="mt-4 text-sm">
                <summary className="cursor-pointer py-2 font-medium">
                  Speech service availability
                </summary>
                <ul className="space-y-3 pb-2">
                  {settings.selectionVoiceRoute.capabilities.map((capability) => (
                    <li key={`${capability.modality}:${capability.id}`}>
                      <span className="font-medium">{capability.label}</span> (
                      {capability.modality === 'stt' ? 'Listening' : 'Speaking'}):{' '}
                      {capability.available
                        ? 'Available'
                        : capability.unavailableReason || 'Unavailable'}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </details>
        )}
      </section>
    </details>
  );
}

export function ConnectedAdvancedVoiceSettings({
  appConfig,
  settings,
  ended,
  deviceSound,
  activeSoundMode,
}: {
  appConfig: AppConfig;
  settings: UseCallSessionVoiceSettingsResult;
  ended: boolean;
  deviceSound?: DeviceSoundSettings;
  activeSoundMode?: DeviceSoundMode | null;
}) {
  const session = useSessionContext();
  const { voiceRoute, hasLiveRoute } = useVoiceRoute(appConfig);
  return (
    <AdvancedVoiceSettings
      settings={settings}
      liveRoute={hasLiveRoute ? voiceRoute : null}
      readOnly={ended || session.connectionState !== ConnectionState.Disconnected}
      deviceSound={deviceSound}
      activeSoundMode={activeSoundMode}
    />
  );
}
