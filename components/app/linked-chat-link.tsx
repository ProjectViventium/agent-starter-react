'use client';

import React from 'react';
import { callCapabilityStorageKey, readCallOpenerOrigin } from '@/lib/call-browser-capability';
import {
  resolveLinkedChatHref,
  resolveLinkedChatOrigin,
  retainedLinkedChatHref,
} from '@/lib/call-handoff';

// VIVENTIUM START: Share normal chat navigation before, during and after the native call session.
export function LinkedChatLink({
  callSessionId,
  conversationId,
  href,
}: {
  callSessionId: string | null;
  conversationId?: string | null;
  href?: string | null;
}) {
  const initialChatHref =
    callSessionId && callCapabilityStorageKey(callSessionId)
      ? (retainedLinkedChatHref(callSessionId) ??
        resolveLinkedChatHref(
          readCallOpenerOrigin(callSessionId) ??
            resolveLinkedChatOrigin(typeof document === 'undefined' ? '' : document.referrer),
          conversationId ?? null
        ))
      : null;
  const linkedChatHref = href ?? initialChatHref;

  return linkedChatHref ? (
    <a
      href={linkedChatHref}
      target="_blank"
      rel="noopener noreferrer"
      className="fixed top-3 left-3 z-[90] rounded-lg border px-3 py-2 text-sm underline md:left-16"
    >
      Open in chat
    </a>
  ) : null;
}
// VIVENTIUM END
