import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CallVoicePicker, VoicePicker, type VoicePickerProps } from '@/components/app/voice-picker';
import type { UseCallSessionVoiceSettingsResult } from '@/hooks/useCallSessionVoiceSettings';
import {
  type VoiceRouteCapability,
  type VoiceRouteMetadata,
  type VoiceRouteState,
  normalizeVoiceRouteMetadata,
} from '@/hooks/useVoiceRoute';
import { presentProvider } from '@/lib/voice-providers';

const room = vi.hoisted(() => ({
  connectionState: 'disconnected',
  agentMetadata: null as string | null,
}));
vi.mock('@livekit/components-react', () => ({
  useSessionContext: () => ({ connectionState: room.connectionState }),
  useRemoteParticipants: () =>
    room.agentMetadata === null ? [] : [{ isAgent: true, metadata: room.agentMetadata }],
}));

/** A voice-settings response as the page's route returns it (catalog from the voice gateway). */
const SAMPLE_CATALOG: VoiceRouteCapability[] = [
  {
    id: 'assemblyai',
    modality: 'stt',
    label: 'AssemblyAI',
    isLocal: false,
    available: true,
    unavailableReason: null,
    variantLabel: 'Engine',
    variants: [
      { id: 'u3-rt-pro', label: 'Universal-3 Pro streaming' },
      { id: 'universal-streaming-english', label: 'Universal Streaming (English)' },
    ],
  },
  {
    id: 'openai',
    modality: 'stt',
    label: 'OpenAI',
    isLocal: false,
    available: true,
    unavailableReason: null,
    variantLabel: 'Model',
    variants: [
      { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe' },
      { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe' },
    ],
  },
  {
    id: 'pywhispercpp',
    modality: 'stt',
    label: 'Whisper.cpp Local',
    isLocal: true,
    available: true,
    unavailableReason: null,
    variantLabel: 'Model',
    variants: [{ id: 'large-v3-turbo', label: 'large-v3-turbo (Recommended)' }],
  },
  {
    id: 'xai',
    modality: 'tts',
    label: 'xAI',
    isLocal: false,
    available: true,
    unavailableReason: null,
    variantLabel: 'Voice',
    variants: [
      { id: 'ara', label: 'Ara' },
      { id: 'eve', label: 'Eve' },
    ],
  },
  {
    id: 'elevenlabs',
    modality: 'tts',
    label: 'ElevenLabs',
    isLocal: false,
    available: false,
    unavailableReason: 'Add an ElevenLabs API key in settings.',
    variantLabel: 'Voice',
    variants: [{ id: 'default', label: 'Default' }],
  },
  {
    id: 'cartesia',
    modality: 'tts',
    label: 'Cartesia',
    isLocal: false,
    available: true,
    unavailableReason: null,
    variantLabel: 'Voice',
    variants: [
      { id: 'megan', label: 'Megan' },
      { id: 'lyra', label: 'Lyra' },
    ],
  },
  {
    id: 'local_chatterbox_turbo_mlx_8bit',
    modality: 'tts',
    label: 'Local Chatterbox',
    isLocal: true,
    available: true,
    unavailableReason: null,
    variantLabel: 'Model',
    variants: [{ id: 'mlx-community/chatterbox-turbo-8bit', label: 'chatterbox-turbo-8bit' }],
  },
];

const CHOSEN: VoiceRouteState = {
  stt: { provider: 'assemblyai', variant: 'u3-rt-pro' },
  tts: { provider: 'xai', variant: 'ara' },
};

function sampleSettings(
  changed: Partial<UseCallSessionVoiceSettingsResult> = {}
): UseCallSessionVoiceSettingsResult {
  return {
    requestedVoiceRoute: CHOSEN,
    savedVoiceRoute: CHOSEN,
    configuredVoiceRoute: CHOSEN,
    selectionVoiceRoute: normalizeVoiceRouteMetadata({ capabilities: SAMPLE_CATALOG }),
    assistantRoute: {
      primary: { provider: 'openai', model: 'gpt-5' },
      voiceCallLlm: null,
      fallbackLlm: null,
      voiceFallbackLlm: {
        provider: 'anthropic',
        model: 'claude-opus',
        providerLabel: 'Anthropic',
        modelLabel: 'Claude Opus',
        effort: 'low',
      },
      effective: {
        provider: 'openai',
        model: 'gpt-5',
        providerLabel: 'OpenAI',
        modelLabel: 'GPT-5',
        effort: 'medium',
      },
      inheritsPrimary: true,
    },
    isLoading: false,
    isSaving: false,
    error: null,
    issue: null,
    setRequestedVoiceRoute: vi.fn(async () => true),
    ...changed,
  };
}

const deviceSound = { mode: 'standard', ready: true, notice: null, selectMode: vi.fn() } as const;

function openPicker(props: Partial<VoicePickerProps> = {}) {
  const settings = props.settings === undefined ? sampleSettings() : props.settings;
  render(<VoicePicker deviceSound={deviceSound} {...props} settings={settings} />);
  fireEvent.click(screen.getByRole('button', { name: /^Voice settings/ }));
  return { settings, panel: screen.getByRole('dialog', { name: 'Voice' }) };
}

function card(panel: HTMLElement, section: 'Listening' | 'Voice', name: string) {
  const group = within(panel).getByRole('group', { name: section });
  return within(group).getByRole('button', { name: new RegExp(`^${name}\\b`) });
}

function liveRoute(stt: string, tts: string): VoiceRouteMetadata {
  return normalizeVoiceRouteMetadata({
    stt: { provider: stt },
    tts: { provider: tts },
    capabilities: SAMPLE_CATALOG,
  });
}

afterEach(() => {
  room.connectionState = 'disconnected';
  room.agentMetadata = null;
});

describe('the Voice button', () => {
  it('shows the current choice at a glance: who is listening and who is speaking', () => {
    render(<VoicePicker deviceSound={deviceSound} settings={sampleSettings()} />);
    const button = screen.getByRole('button', {
      name: 'Voice settings. Listening: AssemblyAI. Voice: xAI',
    });
    const logos = [...button.querySelectorAll('[data-provider-logo]')].map((logo) =>
      logo.getAttribute('data-provider-logo')
    );
    expect(logos).toEqual(['/providers/assemblyai.svg', '/providers/xai.svg']);
  });

  it('during a call shows what the call is using, not what was chosen afterwards', () => {
    render(
      <VoicePicker
        deviceSound={deviceSound}
        settings={sampleSettings()}
        phase="live"
        liveRoute={liveRoute('pywhispercpp', 'cartesia')}
      />
    );
    expect(
      screen.getByRole('button', { name: 'Voice settings. Listening: Whisper. Voice: Cartesia' })
    ).toBeInTheDocument();
  });

  it('is a plain "Voice" button when nothing is known yet', () => {
    render(
      <VoicePicker
        deviceSound={deviceSound}
        settings={sampleSettings({ isLoading: true, selectionVoiceRoute: null })}
      />
    );
    expect(screen.getByRole('button', { name: 'Voice settings' })).toHaveTextContent('Voice');
  });
});

describe('provider cards', () => {
  it('renders one card per provider from the response, in two sections', () => {
    const { panel } = openPicker();
    const listening = within(panel).getByRole('group', { name: 'Listening' });
    const voice = within(panel).getByRole('group', { name: 'Voice' });
    const names = (group: HTMLElement) =>
      within(group)
        .getAllByRole('button')
        .filter((button) => button.querySelector('[data-provider-mark]'))
        .map((button) => button.querySelector('[data-provider-name]')?.textContent);
    expect(names(listening)).toEqual(['AssemblyAI', 'OpenAI', 'Whisper']);
    expect(names(voice)).toEqual(['xAI', 'ElevenLabs', 'Cartesia', 'Chatterbox']);
  });

  it('gives each card a logo, a laptop tile for on-device options or a letter tile', () => {
    const { panel } = openPicker();
    const mark = (section: 'Listening' | 'Voice', name: string) =>
      card(panel, section, name).querySelector('[data-provider-mark]');
    expect(mark('Listening', 'OpenAI')?.querySelector('[data-provider-logo]')).toHaveAttribute(
      'data-provider-logo',
      '/providers/openai.svg'
    );
    expect(mark('Voice', 'ElevenLabs')?.querySelector('[data-provider-logo]')).toHaveAttribute(
      'data-provider-logo',
      '/providers/elevenlabs.svg'
    );
    expect(mark('Listening', 'Whisper')).toHaveAttribute('data-provider-mark', 'device');
    expect(mark('Voice', 'Chatterbox')).toHaveAttribute('data-provider-mark', 'device');
    expect(mark('Voice', 'Cartesia')).toHaveAttribute('data-provider-mark', 'letter');
    expect(mark('Voice', 'Cartesia')).toHaveTextContent('C');
  });

  it('says where each runs and whether it is covered or metered', () => {
    const { panel } = openPicker();
    const whisper = card(panel, 'Listening', 'Whisper');
    expect(whisper).toHaveTextContent('On this Mac');
    expect(whisper).toHaveTextContent('Covered');
    const openai = card(panel, 'Listening', 'OpenAI');
    expect(openai).toHaveTextContent('Cloud');
    expect(openai).toHaveTextContent('Metered');
    expect(within(panel).getByText(/Covered runs on this Mac/)).toBeInTheDocument();
  });

  it('makes the chosen card obvious', () => {
    const { panel } = openPicker();
    expect(card(panel, 'Listening', 'AssemblyAI')).toHaveAttribute('aria-pressed', 'true');
    expect(card(panel, 'Listening', 'OpenAI')).toHaveAttribute('aria-pressed', 'false');
    expect(card(panel, 'Voice', 'xAI')).toHaveAttribute('aria-pressed', 'true');
  });

  it('never shows raw provider ids', () => {
    const { panel } = openPicker();
    for (const rawId of ['pywhispercpp', 'local_chatterbox_turbo_mlx_8bit', 'assemblyai', 'xai']) {
      expect(panel.textContent).not.toContain(rawId);
    }
  });

  it('gives a provider it does not know a card with its own label and a letter tile', () => {
    const unknown: VoiceRouteCapability = {
      id: 'future_voice',
      modality: 'tts',
      label: 'Future Voice',
      isLocal: false,
      available: true,
      unavailableReason: null,
      variantLabel: 'Voice',
      variants: [],
    };
    expect(presentProvider(unknown, 'tts')).toEqual({
      name: 'Future Voice',
      description: 'Speaks through an online service.',
      mark: { kind: 'letter', letter: 'F' },
    });
    const { panel } = openPicker({
      settings: sampleSettings({
        selectionVoiceRoute: normalizeVoiceRouteMetadata({
          capabilities: [...SAMPLE_CATALOG, unknown],
        }),
      }),
    });
    expect(card(panel, 'Voice', 'Future Voice')).toHaveTextContent('Cloud');
  });
});

describe('unavailable providers', () => {
  it('shows the card greyed with the reason in plain words', () => {
    const { panel } = openPicker();
    const elevenlabs = card(panel, 'Voice', 'ElevenLabs');
    expect(elevenlabs).toHaveAttribute('aria-disabled', 'true');
    expect(elevenlabs).toHaveTextContent('Not available: Add an ElevenLabs API key in settings.');
  });

  it('cannot be chosen', () => {
    const { panel, settings } = openPicker();
    fireEvent.click(card(panel, 'Voice', 'ElevenLabs'));
    expect(settings!.setRequestedVoiceRoute).not.toHaveBeenCalled();
  });
});

describe('choosing', () => {
  it('saves a provider with its first model or voice, leaving the other choice as it is', () => {
    const { panel, settings } = openPicker();
    fireEvent.click(card(panel, 'Voice', 'Cartesia'));
    expect(settings!.setRequestedVoiceRoute).toHaveBeenCalledExactlyOnceWith({
      stt: CHOSEN.stt,
      tts: { provider: 'cartesia', variant: 'megan' },
    });
  });

  it('shows the models or voices of the chosen provider only, exactly as offered', () => {
    const { panel } = openPicker();
    const voices = within(panel).getByRole('group', { name: 'xAI voice' });
    expect(
      within(voices)
        .getAllByRole('button')
        .map((chip) => chip.textContent)
    ).toEqual(['Ara', 'Eve']);
    expect(within(voices).getByRole('button', { name: 'Ara' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(within(panel).queryByRole('button', { name: 'Megan' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('group', { name: 'AssemblyAI engine' })).toBeInTheDocument();
  });

  it('saves another voice of the same provider', () => {
    const { panel, settings } = openPicker();
    fireEvent.click(within(panel).getByRole('button', { name: 'Eve' }));
    expect(settings!.setRequestedVoiceRoute).toHaveBeenCalledExactlyOnceWith({
      stt: CHOSEN.stt,
      tts: { provider: 'xai', variant: 'eve' },
    });
  });

  it('does nothing when the chosen card or chip is pressed again', () => {
    const { panel, settings } = openPicker();
    fireEvent.click(card(panel, 'Voice', 'xAI'));
    fireEvent.click(within(panel).getByRole('button', { name: 'Ara' }));
    expect(settings!.setRequestedVoiceRoute).not.toHaveBeenCalled();
  });

  it('holds further choices while one is being saved', () => {
    const { panel, settings } = openPicker({ settings: sampleSettings({ isSaving: true }) });
    expect(within(panel).getByRole('status')).toHaveTextContent('Saving your choice…');
    fireEvent.click(card(panel, 'Listening', 'OpenAI'));
    expect(settings!.setRequestedVoiceRoute).not.toHaveBeenCalled();
  });

  it('shows why a save or load failed', () => {
    const { panel } = openPicker({
      settings: sampleSettings({ error: 'Unable to save voice settings.' }),
    });
    expect(within(panel).getByRole('alert')).toHaveTextContent('Unable to save voice settings.');
  });
});

describe('when a choice takes effect', () => {
  it('before the call starts: used when the call starts', () => {
    const { panel } = openPicker({ phase: 'before' });
    expect(panel).toHaveTextContent('Used when you start this call.');
    expect(within(panel).queryByText('In use')).not.toBeInTheDocument();
  });

  it('during a call: says the running call keeps its voice and marks what is in use', () => {
    const { panel, settings } = openPicker({
      phase: 'live',
      liveRoute: liveRoute('assemblyai', 'cartesia'),
    });
    expect(panel).toHaveTextContent(
      'A running call keeps its voice. Your choice is saved for this call and used the next time it starts.'
    );
    expect(panel).not.toHaveTextContent('Used when you start this call.');
    // Chosen and in use can differ: xAI is chosen, Cartesia is what the call uses.
    expect(card(panel, 'Voice', 'Cartesia')).toHaveTextContent('In use');
    expect(card(panel, 'Voice', 'Cartesia')).toHaveAttribute('aria-pressed', 'false');
    expect(card(panel, 'Voice', 'xAI')).toHaveAttribute('aria-pressed', 'true');
    expect(card(panel, 'Voice', 'xAI')).not.toHaveTextContent('In use');
    expect(card(panel, 'Listening', 'AssemblyAI')).toHaveTextContent('In use');

    // The choice is still saved for this call.
    fireEvent.click(card(panel, 'Listening', 'OpenAI'));
    expect(settings!.setRequestedVoiceRoute).toHaveBeenCalledExactlyOnceWith({
      stt: { provider: 'openai', variant: 'gpt-4o-mini-transcribe' },
      tts: CHOSEN.tts,
    });
  });

  it('after the call has ended: nothing can be changed', () => {
    const { panel, settings } = openPicker({ phase: 'ended' });
    expect(panel).toHaveTextContent('This call has ended.');
    fireEvent.click(card(panel, 'Listening', 'OpenAI'));
    expect(settings!.setRequestedVoiceRoute).not.toHaveBeenCalled();
  });

  it('inside a call session, follows the connection and what the voice agent reports', () => {
    room.connectionState = 'connected';
    room.agentMetadata = JSON.stringify({
      voiceRoute: { stt: { provider: 'whisper_local' }, tts: { provider: 'xai' } },
    });
    render(<CallVoicePicker deviceSound={deviceSound} settings={sampleSettings()} ended={false} />);
    fireEvent.click(
      screen.getByRole('button', { name: 'Voice settings. Listening: Whisper. Voice: xAI' })
    );
    const panel = screen.getByRole('dialog', { name: 'Voice' });
    expect(panel).toHaveTextContent('A running call keeps its voice.');
    expect(card(panel, 'Listening', 'Whisper')).toHaveTextContent('In use');
  });

  it('inside a call session that is not connected, behaves as before the call', () => {
    render(<CallVoicePicker deviceSound={deviceSound} settings={sampleSettings()} ended={false} />);
    fireEvent.click(screen.getByRole('button', { name: /^Voice settings/ }));
    expect(screen.getByRole('dialog', { name: 'Voice' })).toHaveTextContent(
      'Used when you start this call.'
    );
  });
});

describe('the rest of the panel', () => {
  it('states the assistant and the backup assistant as a quiet line', () => {
    const { panel } = openPicker();
    expect(within(panel).getByText(/^Assistant:/)).toHaveTextContent(
      'Assistant: OpenAI · GPT-5 · medium'
    );
    expect(within(panel).getByText(/^Backup assistant:/)).toHaveTextContent(
      'Backup assistant: Anthropic · Claude Opus · low'
    );
  });

  it('states a backup voice when one is reported', () => {
    const { panel } = openPicker({
      phase: 'live',
      liveRoute: normalizeVoiceRouteMetadata({
        stt: { provider: 'assemblyai' },
        tts: { provider: 'xai' },
        ttsFallback: { provider: 'openai', label: 'OpenAI', variant: 'gpt-4o-mini-tts' },
        capabilities: SAMPLE_CATALOG,
      }),
    });
    expect(within(panel).getByText(/^Backup voice:/)).toHaveTextContent(
      'Backup voice: OpenAI • gpt-4o-mini-tts'
    );
  });

  it('keeps the sound choice for this device in the same panel', () => {
    const { panel } = openPicker();
    fireEvent.click(within(panel).getByRole('button', { name: 'Earpiece / headphones' }));
    expect(deviceSound.selectMode).toHaveBeenCalledWith('earpiece');
  });

  it('without a call offers only the sound choice', () => {
    render(<VoicePicker deviceSound={deviceSound} />);
    fireEvent.click(screen.getByRole('button', { name: 'Voice settings' }));
    const panel = screen.getByRole('dialog', { name: 'Voice' });
    expect(panel).toHaveTextContent('Open a call from Viventium to choose its voice.');
    expect(within(panel).queryByRole('group', { name: 'Listening' })).not.toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'Speaker' })).toBeInTheDocument();
  });

  it('says so while the options load and when there are none', () => {
    const loading = openPicker({
      settings: sampleSettings({ isLoading: true, selectionVoiceRoute: null }),
    });
    expect(within(loading.panel).getByRole('status')).toHaveTextContent('Loading voice options…');
  });

  it('closes with Escape or the close button', () => {
    openPicker();
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Voice' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Voice settings/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Close voice settings' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
