'use client';

import { MessageSquareIcon } from 'lucide-react';
import { callCapabilityStorageKey, readCallOpenerOrigin } from '@/lib/call-browser-capability';
import {
  resolveLinkedChatHref,
  resolveLinkedChatOrigin,
  retainedLinkedChatHref,
} from '@/lib/call-handoff';

/**
 * Where "Open in chat" goes for this call, or `null` when no trustworthy address is known.
 * The one place that knows the chat app's address shape (CP-CMP-013).
 */
function linkedChatHref(
  callSessionId: string | null,
  conversationId: string | null | undefined
): string | null {
  if (!callSessionId || !callCapabilityStorageKey(callSessionId)) return null;
  return (
    retainedLinkedChatHref(callSessionId) ??
    resolveLinkedChatHref(
      readCallOpenerOrigin(callSessionId) ??
        resolveLinkedChatOrigin(typeof document === 'undefined' ? '' : document.referrer),
      conversationId ?? null
    )
  );
}

/** Opens the conversation this call belongs to, before, during and after the call. */
export function LinkedChatLink({
  callSessionId,
  conversationId,
  href,
}: {
  callSessionId: string | null;
  conversationId?: string | null;
  /** An address learned during the call (from a finished result); wins over the initial one. */
  href?: string | null;
}) {
  const target = href ?? linkedChatHref(callSessionId, conversationId);
  return target ? (
    <a
      href={target}
      target="_blank"
      rel="noopener noreferrer"
      className="bg-background/90 border-border text-foreground hover:bg-accent fixed top-3 left-3 z-[60] inline-flex h-9 items-center gap-2 rounded-full border px-3 text-sm font-medium shadow-xs md:top-5 md:left-16"
    >
      <MessageSquareIcon aria-hidden="true" className="size-4" />
      Open in chat
    </a>
  ) : null;
}
