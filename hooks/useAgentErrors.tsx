import { useEffect } from 'react';
import { useAgent, useSessionContext } from '@livekit/components-react';
import { toastAlert } from '@/components/livekit/alert-toast';

export function useAgentErrors() {
  const agent = useAgent();
  const { isConnected, end } = useSessionContext();

  useEffect(() => {
    if (isConnected && agent.state === 'failed') {
      const reasons = agent.failureReasons;

      toastAlert({
        title: 'Session ended',
        description: (
          <>
            {reasons.length > 1 && (
              <ul className="list-inside list-disc">
                {reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            {reasons.length === 1 && <p className="w-full">{reasons[0]}</p>}
            <p className="w-full">
              {/* VIVENTIUM START
               * Purpose: Point user-facing help links to Viventium.AI.
               * Details: docs/requirements_and_learnings/16_Branding_and_Assets.md#agent-starter-help-links
               * VIVENTIUM END */}
              <a
                target="_blank"
                rel="noopener noreferrer"
                href="https://viventium.ai"
                className="whitespace-nowrap underline"
              >
                Visit Viventium.AI
              </a>
              .
            </p>
          </>
        ),
      });

      end();
    }
  }, [agent, isConnected, end]);
}
