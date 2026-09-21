/* VIVENTIUM START
 * Feature: Per-call voice settings lifecycle regression coverage.
 * Purpose: Prove normal connected and ended call states cannot re-enable route editing.
 * VIVENTIUM END */
import React from 'react';
import { ConnectionState } from 'livekit-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AppConfig } from '@/app-config';
import { ConnectedAdvancedVoiceSettings } from '@/components/app/advanced-voice-settings';
import type { UseCallSessionVoiceSettingsResult } from '@/hooks/useCallSessionVoiceSettings';
import type { VoiceRouteMetadata } from '@/hooks/useVoiceRoute';

const livekitState = vi.hoisted(() => ({
  connectionState: 'connected' as string,
}));

vi.mock('@livekit/components-react', () => ({
  useSessionContext: () => ({ connectionState: livekitState.connectionState }),
}));

const voiceRoute = {
  stt: {
    provider: 'local-stt',
    label: 'Local STT',
    displayLabel: 'Local STT',
    isLocal: true,
    variant: 'base',
    variantLabel: 'Base',
    variantType: 'model',
  },
  tts: {
    provider: 'local-tts',
    label: 'Local TTS',
    displayLabel: 'Local TTS',
    isLocal: true,
    variant: 'base',
    variantLabel: 'Base',
    variantType: 'voice',
  },
  ttsFallback: null,
  capabilities: [],
} as VoiceRouteMetadata;

vi.mock('@/hooks/useVoiceRoute', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/useVoiceRoute')>();
  return {
    ...actual,
    useVoiceRoute: () => ({ voiceRoute, hasLiveRoute: true }),
  };
});

vi.mock('@/components/livekit/voice-route-control', () => ({
  VoiceRouteControl: ({
    onRequestedVoiceRouteChange,
    isConnected,
  }: {
    onRequestedVoiceRouteChange?: unknown;
    isConnected?: boolean;
  }) => (
    <output aria-label="Voice route edit state">
      {onRequestedVoiceRouteChange ? 'editable' : 'read-only'}:{String(isConnected)}
    </output>
  ),
}));

const settings = {
  requestedVoiceRoute: voiceRoute,
  savedVoiceRoute: voiceRoute,
  configuredVoiceRoute: voiceRoute,
  selectionVoiceRoute: voiceRoute,
  assistantRoute: null,
  isLoading: false,
  isSaving: false,
  error: null,
  issue: null,
  notice: null,
  setRequestedVoiceRoute: vi.fn(),
} as unknown as UseCallSessionVoiceSettingsResult;

const appConfig = {} as AppConfig;

afterEach(() => {
  livekitState.connectionState = ConnectionState.Connected;
});

describe('ConnectedAdvancedVoiceSettings', () => {
  it('stays visible and read-only during connected and ended call states', () => {
    const { rerender } = render(
      <ConnectedAdvancedVoiceSettings appConfig={appConfig} settings={settings} ended={false} />
    );
    expect(screen.getByText('Advanced voice settings')).toBeInTheDocument();
    expect(screen.getByLabelText('Voice route edit state')).toHaveTextContent('read-only:true');

    livekitState.connectionState = ConnectionState.Disconnected;
    rerender(
      <ConnectedAdvancedVoiceSettings appConfig={appConfig} settings={settings} ended={true} />
    );
    expect(screen.getByLabelText('Voice route edit state')).toHaveTextContent('read-only:true');
  });
});
