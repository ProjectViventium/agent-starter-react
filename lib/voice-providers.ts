/*
 * How a speech provider is shown in the voice picker: a friendly name, one plain line, and a
 * mark (logo, on-device icon or a letter tile).
 *
 * Presentation only. Which providers exist, whether they are available, where they run and
 * which models or voices they offer always come from the voice-settings response; a provider
 * this file does not know still gets a card (its own label and a letter tile).
 * Logo files: `public/providers/` (see SOURCE.md there).
 */
import { type VoiceRouteCapability, normalizeProviderName } from '@/hooks/useVoiceRoute';

export type VoiceModality = 'stt' | 'tts';

export type ProviderMark =
  | { kind: 'logo'; src: string }
  /** Runs on this Mac: drawn as a laptop tile. */
  | { kind: 'device' }
  | { kind: 'letter'; letter: string };

export type ProviderPresentation = {
  name: string;
  description: string;
  mark: ProviderMark;
};

type KnownProvider = {
  name: string;
  logo?: string;
  onDevice?: boolean;
  /** One line per use; a provider may only listen or only speak. */
  listening?: string;
  voice?: string;
};

const KNOWN_PROVIDERS: Record<string, KnownProvider> = {
  openai: {
    name: 'OpenAI',
    logo: '/providers/openai.svg',
    listening: 'Accurate speech recognition from OpenAI.',
    voice: 'Natural voices from OpenAI.',
  },
  assemblyai: {
    name: 'AssemblyAI',
    logo: '/providers/assemblyai.svg',
    listening: 'Fast live transcription, made for conversations.',
  },
  pywhispercpp: {
    name: 'Whisper',
    onDevice: true,
    listening: 'Whisper running on this Mac. Your audio is not sent to a speech service.',
  },
  elevenlabs: {
    name: 'ElevenLabs',
    logo: '/providers/elevenlabs.svg',
    voice: 'Expressive, lifelike voices.',
  },
  cartesia: {
    name: 'Cartesia',
    voice: 'Quick, natural voices.',
  },
  xai: {
    name: 'xAI',
    logo: '/providers/xai.svg',
    voice: 'The Grok voices from xAI.',
  },
  local_chatterbox_turbo_mlx_8bit: {
    name: 'Chatterbox',
    onDevice: true,
    voice: 'Chatterbox running on this Mac. Speech is made here.',
  },
};

function genericDescription(modality: VoiceModality, isLocal: boolean): string {
  if (modality === 'stt') {
    return isLocal ? 'Listens on this Mac.' : 'Listens through an online service.';
  }
  return isLocal ? 'Speaks from this Mac.' : 'Speaks through an online service.';
}

export function presentProvider(
  provider: Pick<VoiceRouteCapability, 'id' | 'label' | 'isLocal'>,
  modality: VoiceModality
): ProviderPresentation {
  const known = KNOWN_PROVIDERS[normalizeProviderName(provider.id)];
  const name = known?.name ?? provider.label;
  const description =
    (modality === 'stt' ? known?.listening : known?.voice) ??
    genericDescription(modality, provider.isLocal);
  const mark: ProviderMark = known?.logo
    ? { kind: 'logo', src: known.logo }
    : (known?.onDevice ?? provider.isLocal)
      ? { kind: 'device' }
      : { kind: 'letter', letter: (name.trim()[0] ?? '?').toUpperCase() };
  return { name, description, mark };
}
