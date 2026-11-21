import { App } from '@/components/app/app';

// Viventium always uses its own token route (`VIVENTIUM_CONFIG.tokenEndpoint`, app/api/token/route.ts). Upstream's other token
// sources (LiveKit Cloud development token server, LiveKit homepage agent) are not used: a
// Viventium call must never connect to someone else's agent.
export default function Page() {
  return <App agentName={process.env.AGENT_NAME} isVideoInputSupported />;
}
