/**
 * Viventium brand and page configuration (CP-APP-004).
 *
 * Upstream removed `app-config.ts`; these are the few values Viventium still needs. They are
 * plain constants (no env, no remote config), safe to import from server and client code.
 *
 * Not here on purpose:
 * - accent colours: `--primary` / `--primary-hover` in `styles/globals.css` (same values as
 *   `accent` / `accentDark` below, which exist for code that needs the hex value);
 * - agent name for unsigned development calls: `process.env.AGENT_NAME` in `app/page.tsx`;
 * - default voice-route labels and auth-mode fields (CP-APP-005, CP-APP-006): dropped.
 */
export const VIVENTIUM_CONFIG = {
  companyName: 'Viventium',
  pageTitle: 'Viventium Voice Assistant',
  pageDescription: 'A voice assistant powered by Viventium.',
  /** Public site linked from the header and from the "session ended" toast. */
  siteUrl: 'https://viventium.ai',
  siteLinkLabel: 'Viventium.AI',
  siteLinkText: 'Visit Viventium.AI',
  logo: '/viventium-logo.svg',
  logoDark: '/viventium-logo.svg',
  accent: '#00A67E',
  accentDark: '#00D4A0',
  startButtonText: 'Start chat',
  /** Same-origin token route (`app/api/token/route.ts`); replaces `/api/connection-details`. */
  tokenEndpoint: '/api/token',
} as const;

export type ViventiumConfig = typeof VIVENTIUM_CONFIG;
