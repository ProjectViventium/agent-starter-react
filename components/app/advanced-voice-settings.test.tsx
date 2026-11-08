/* VIVENTIUM START
 * Feature: Per-call voice settings lifecycle regression coverage.
 * Purpose: Prove normal connected and ended call states cannot re-enable route editing.
 * VIVENTIUM END */
import React from 'react';
import { ConnectionState } from 'livekit-client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { AppConfig } from '@/app-config';
import {
  AdvancedVoiceSettings,
  ConnectedAdvancedVoiceSettings,
} from '@/components/app/advanced-voice-settings';
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
  it('shows device sound without unavailable call controls before a call exists', () => {
    render(
      <AdvancedVoiceSettings
        settings={{ ...settings, selectionVoiceRoute: null }}
        hasCall={false}
        deviceSound={{ mode: 'standard', ready: true, notice: null, selectMode: vi.fn() }}
      />
    );
    expect(screen.getByRole('button', { name: 'Speaker', hidden: true })).toBeInTheDocument();
    expect(screen.queryByText('Voice and assistant')).not.toBeInTheDocument();
    expect(screen.queryByText('Voice settings are unavailable.')).not.toBeInTheDocument();
  });
  it('saves sound for the next call without changing a connected call or opening its microphone', () => {
    const selectMode = vi.fn();
    const { rerender } = render(
      <ConnectedAdvancedVoiceSettings
        appConfig={appConfig}
        settings={settings}
        ended={false}
        deviceSound={{ mode: 'standard', ready: true, notice: null, selectMode }}
        activeSoundMode="standard"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Earpiece / headphones', hidden: true }));
    expect(selectMode).toHaveBeenCalledWith('earpiece');
    rerender(
      <ConnectedAdvancedVoiceSettings
        appConfig={appConfig}
        settings={settings}
        ended={false}
        deviceSound={{ mode: 'earpiece', ready: true, notice: null, selectMode }}
        activeSoundMode="standard"
      />
    );
    expect(screen.getByText(/Saved for your next call/)).toBeInTheDocument();
    expect(screen.getByLabelText('Voice route edit state')).toHaveTextContent('read-only:true');
  });
  it('shows the configured effort beside the assistant and backup model', () => {
    const primary = {
      provider: 'glasshive-harness',
      model: 'codex-cli:gpt-6.1-sol',
      effort: 'high',
    };
    const voice = {
      provider: 'glasshive-harness',
      model: 'grok-build:grok-4.7-build-fast',
      effort: 'high',
    };
    const fallback = {
      provider: 'glasshive-harness',
      model: 'claude-code:claude-opus-5-5',
      effort: 'high',
    };
    render(
      <ConnectedAdvancedVoiceSettings
        appConfig={appConfig}
        ended={false}
        settings={{
          ...settings,
          assistantRoute: {
            primary,
            voiceCallLlm: voice,
            fallbackLlm: fallback,
            voiceFallbackLlm: fallback,
            effective: voice,
            inheritsPrimary: false,
          },
        }}
      />
    );
    expect(screen.getByText(/grok-build:grok-4\.7-build-fast/)).toHaveTextContent('high');
    expect(screen.getByText(/claude-code:claude-opus-5-5/)).toHaveTextContent('high');
  });
  it('renders the capability-owned provider and model labels without exposing raw route IDs', () => {
    const primary = {
      provider: 'glasshive-harness',
      model: 'codex-cli:gpt-6.1-sol',
      effort: 'high',
      providerLabel: 'xPerfect',
      modelLabel: 'OpenAI / GPT-6.1 Sol',
    };
    const voice = {
      provider: 'glasshive-harness',
      model: 'grok-build:grok-4.7-build-fast',
      effort: 'high',
      providerLabel: 'xPerfect',
      modelLabel: 'Grok / Grok 4.7 Fast',
    };
    const fallback = {
      provider: 'glasshive-harness',
      model: 'claude-code:claude-opus-5-5',
      effort: 'high',
      providerLabel: 'xPerfect',
      modelLabel: 'Anthropic / Opus 5.5',
    };
    render(
      <ConnectedAdvancedVoiceSettings
        appConfig={appConfig}
        ended={false}
        settings={{
          ...settings,
          assistantRoute: {
            primary,
            voiceCallLlm: voice,
            fallbackLlm: fallback,
            voiceFallbackLlm: fallback,
            effective: voice,
            inheritsPrimary: false,
          },
        }}
      />
    );
    expect(screen.getByText(/Grok \/ Grok 4.7 Fast/)).toHaveTextContent('xPerfect');
    expect(screen.getByText(/Anthropic \/ Opus 5.5/)).toHaveTextContent('high');
    expect(screen.queryByText(/grok-build:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/claude-code:/)).not.toBeInTheDocument();
  });

  it('stays visible and read-only during connected and ended call states', () => {
    const { rerender } = render(
      <ConnectedAdvancedVoiceSettings appConfig={appConfig} settings={settings} ended={false} />
    );
    expect(screen.getAllByLabelText('Advanced voice settings').length).toBeGreaterThan(0);
    expect(screen.getByLabelText('Voice route edit state')).toHaveTextContent('read-only:true');

    livekitState.connectionState = ConnectionState.Disconnected;
    rerender(
      <ConnectedAdvancedVoiceSettings appConfig={appConfig} settings={settings} ended={true} />
    );
    expect(screen.getByLabelText('Voice route edit state')).toHaveTextContent('read-only:true');
  });
});
