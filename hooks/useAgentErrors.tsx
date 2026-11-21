import { ReactNode, useEffect, useRef } from 'react';
import { toast as sonnerToast } from 'sonner';
import { useAgent, useSessionContext } from '@livekit/components-react';
import { WarningIcon } from '@phosphor-icons/react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { VIVENTIUM_CONFIG } from '@/lib/viventium/config';

interface ToastProps {
  title: ReactNode;
  description: ReactNode;
}

function toastAlert(toast: ToastProps) {
  const { title, description } = toast;

  return sonnerToast.custom(
    (id) => (
      <Alert onClick={() => sonnerToast.dismiss(id)} className="bg-accent w-full md:w-[364px]">
        <WarningIcon weight="bold" />
        <AlertTitle>{title}</AlertTitle>
        {description && <AlertDescription>{description}</AlertDescription>}
      </Alert>
    ),
    { duration: 10_000 }
  );
}

/**
 * Viventium (CP-HL-021): on top of upstream's hook this handles one failure exactly once even
 * when the SDK hands over new agent objects or a new `end` callback, re-arms after any
 * non-failed state, and calls `onFailure` before the session is ended.
 */
export function useAgentErrors(onFailure?: () => void) {
  const agent = useAgent();
  const { isConnected, end } = useSessionContext();
  const failureHandled = useRef(false);

  useEffect(() => {
    if (agent.state !== 'failed') {
      failureHandled.current = false;
      return;
    }
    if (isConnected && !failureHandled.current) {
      failureHandled.current = true;
      onFailure?.();
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
              <a
                target="_blank"
                rel="noopener noreferrer"
                href={VIVENTIUM_CONFIG.siteUrl}
                className="whitespace-nowrap underline"
              >
                {VIVENTIUM_CONFIG.siteLinkText}
              </a>
              .
            </p>
          </>
        ),
      });

      end();
    }
  }, [agent, isConnected, end, onFailure]);
}
