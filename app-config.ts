/* VIVENTIUM START
 * Purpose: Viventium agent-starter customization.
 * Details: docs/requirements_and_learnings/05_Open_Source_Modifications.md#agent-starter-react
 VIVENTIUM END */

export interface AppConfig {
  pageTitle: string;
  pageDescription: string;
  companyName: string;
  siteUrl: string;

  supportsChatInput: boolean;
  supportsVideoInput: boolean;
  supportsScreenShare: boolean;
  isPreConnectBufferEnabled: boolean;

  logo: string;
  startButtonText: string;
  accent?: string;
  logoDark?: string;
  accentDark?: string;

  // agent dispatch configuration
  agentName?: string;

  voiceSttProvider?: string;
  voiceSttModel?: string;
  voiceTtsProvider?: string;
  voiceTtsFallbackProvider?: string;
  openaiAuthMode?: string;
  anthropicAuthMode?: string;
  localSubscriptionAuth?: boolean;
  openaiTtsModel?: string;
  openaiTtsVoice?: string;
  openaiTtsSpeed?: string;

  // LiveKit Cloud Sandbox configuration
  sandboxId?: string;
}

export const APP_CONFIG_DEFAULTS: AppConfig = {
  companyName: 'Viventium',
  pageTitle: 'Viventium Voice Assistant',
  pageDescription: 'A voice assistant powered by Viventium.',
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? 'https://viventium.ai',

  supportsChatInput: true,
  supportsVideoInput: true,
  supportsScreenShare: true,
  isPreConnectBufferEnabled: true,

  logo: '/viventium-logo.svg',
  accent: '#00A67E',
  logoDark: '/viventium-logo.svg',
  accentDark: '#00D4A0',
  startButtonText: 'Start chat',

  // agent dispatch configuration
  agentName: process.env.AGENT_NAME ?? undefined,
  voiceSttProvider: process.env.VIVENTIUM_STT_PROVIDER ?? undefined,
  voiceSttModel: process.env.VIVENTIUM_STT_MODEL ?? undefined,
  voiceTtsProvider: process.env.VIVENTIUM_TTS_PROVIDER ?? undefined,
  voiceTtsFallbackProvider: process.env.VIVENTIUM_TTS_PROVIDER_FALLBACK ?? undefined,
  openaiAuthMode: process.env.VIVENTIUM_OPENAI_AUTH_MODE ?? undefined,
  anthropicAuthMode: process.env.VIVENTIUM_ANTHROPIC_AUTH_MODE ?? undefined,
  localSubscriptionAuth:
    /^(1|true|yes)$/i.test(process.env.VIVENTIUM_LOCAL_SUBSCRIPTION_AUTH ?? '') || false,
  openaiTtsModel: process.env.VIVENTIUM_OPENAI_TTS_MODEL ?? undefined,
  openaiTtsVoice: process.env.VIVENTIUM_OPENAI_TTS_VOICE ?? undefined,
  openaiTtsSpeed: process.env.VIVENTIUM_OPENAI_TTS_SPEED ?? undefined,

  // LiveKit Cloud Sandbox configuration
  sandboxId: undefined,
};
