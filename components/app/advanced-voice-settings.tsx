'use client';

import React, { useRef } from 'react';
import { ConnectionState } from 'livekit-client';
import { useSessionContext } from '@livekit/components-react';
import type { AppConfig } from '@/app-config';
import { VoiceRouteControl } from '@/components/livekit/voice-route-control';
import type { UseCallSessionVoiceSettingsResult } from '@/hooks/useCallSessionVoiceSettings';
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
};

export function AdvancedVoiceSettings({
  settings,
  liveRoute,
  readOnly = false,
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
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
    >
      <summary className="bg-background border-border ml-auto w-fit cursor-pointer rounded-lg border px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2">
        Advanced voice settings
      </summary>
      <section
        aria-label="Advanced voice settings"
        className="bg-background border-border mt-2 max-h-[75svh] w-[min(34rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-xl border p-3 shadow-sm"
      >
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="font-semibold">Voice settings</h2>
          <button type="button" onClick={close} className="rounded px-2 py-1 text-sm underline">
            Close settings
          </button>
        </div>
        <p className="text-muted-foreground mb-3 text-sm">
          {readOnly
            ? 'Voice choices are fixed for this call.'
            : 'Changes apply to this call only. Your account defaults stay the same.'}
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
              (settings.isLoading ? 'Loading voice settings…' : 'Voice settings are unavailable.')}
          </p>
        )}
        {assistant ? (
          <dl className="mt-4 space-y-2 text-sm break-words">
            <div>
              <dt className="font-medium">Assistant</dt>
              <dd>
                {assistant.effective.provider} · {assistant.effective.model}
              </dd>
            </div>
            {assistant.voiceFallbackLlm || assistant.fallbackLlm ? (
              <div>
                <dt className="font-medium">Backup assistant</dt>
                <dd>
                  {(assistant.voiceFallbackLlm ?? assistant.fallbackLlm)?.provider} ·{' '}
                  {(assistant.voiceFallbackLlm ?? assistant.fallbackLlm)?.model}
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
      </section>
    </details>
  );
}

export function ConnectedAdvancedVoiceSettings({
  appConfig,
  settings,
  ended,
}: {
  appConfig: AppConfig;
  settings: UseCallSessionVoiceSettingsResult;
  ended: boolean;
}) {
  const session = useSessionContext();
  const { voiceRoute, hasLiveRoute } = useVoiceRoute(appConfig);
  return (
    <AdvancedVoiceSettings
      settings={settings}
      liveRoute={hasLiveRoute ? voiceRoute : null}
      readOnly={ended || session.connectionState !== ConnectionState.Disconnected}
    />
  );
}
