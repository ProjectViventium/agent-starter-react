/* === VIVENTIUM START ===
 * Feature: Voice conversation transcript.
 * Purpose: Keep spoken conversation text and file links usable in the call.
 * Approach: Preserve inline link boundaries, then reuse LiveKit's safe bare-link formatter.
 * === VIVENTIUM END === */
import * as React from 'react';
import { formatChatMessageLinks } from '@livekit/components-react';
import { readTranscriptLink, transcriptHttpHref } from '@/lib/citations';
import { cn } from '@/lib/utils';

function formatBareLinks(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let start = 0;
  const candidates = /(?:[A-Za-z][A-Za-z0-9+.-]*:|www\.)[^\s<>"]+/gi;
  for (const match of text.matchAll(candidates)) {
    const index = match.index!;
    nodes.push(
      <React.Fragment key={`plain-${index}`}>
        {formatChatMessageLinks(text.slice(start, index))}
      </React.Fragment>
    );
    const candidate = match[0];
    let end = candidate.length;
    const balances: Record<string, number> = { ')': 0, ']': 0, '}': 0 };
    for (const char of candidate) {
      if (char === '(') balances[')'] -= 1;
      if (char === '[') balances[']'] -= 1;
      if (char === '{') balances['}'] -= 1;
      if (Object.hasOwn(balances, char)) balances[char] += 1;
    }
    while (end > 0) {
      const char = candidate[end - 1];
      if ('.,;:!?'.includes(char)) end -= 1;
      else if (balances[char] > 0) {
        balances[char] -= 1;
        end -= 1;
      } else break;
    }
    const target = candidate.slice(0, end);
    const href = transcriptHttpHref(/^www\./i.test(target) ? `https://${target}` : target);
    nodes.push(
      <React.Fragment key={`url-${index}`}>
        {href ? formatChatMessageLinks(target) : target}
        {candidate.slice(end)}
      </React.Fragment>
    );
    start = index + candidate.length;
  }
  nodes.push(
    <React.Fragment key="tail">{formatChatMessageLinks(text.slice(start))}</React.Fragment>
  );
  return nodes;
}

export function formatTranscriptLinks(message: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let start = 0;
  for (let index = 0; index < message.length; index += 1) {
    if (message[index] === '`') {
      let openingEnd = index + 1;
      while (message[openingEnd] === '`') openingEnd += 1;
      const delimiter = message.slice(index, openingEnd);
      let closing = message.indexOf(delimiter, openingEnd);
      while (
        closing >= 0 &&
        (message[closing - 1] === '`' || message[closing + delimiter.length] === '`')
      )
        closing = message.indexOf(delimiter, closing + delimiter.length);
      nodes.push(
        <React.Fragment key={`plain-${index}`}>
          {formatBareLinks(message.slice(start, index))}
        </React.Fragment>
      );
      const end = closing < 0 ? message.length : closing + delimiter.length;
      nodes.push(
        closing < 0 ? (
          message.slice(index)
        ) : (
          <code key={`code-${index}`}>{message.slice(openingEnd, closing)}</code>
        )
      );
      index = end - 1;
      start = end;
      continue;
    }
    const link = readTranscriptLink(message, index);
    if (!link) continue;
    nodes.push(
      <React.Fragment key={`plain-${index}`}>
        {formatBareLinks(message.slice(start, index))}
      </React.Fragment>
    );
    nodes.push(
      link.complete && link.href ? (
        <a
          className="lk-chat-link"
          key={`link-${index}`}
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {link.label}
        </a>
      ) : (
        message.slice(index, link.end)
      )
    );
    index = link.end - 1;
    start = link.end;
  }
  nodes.push(<React.Fragment key="tail">{formatBareLinks(message.slice(start))}</React.Fragment>);
  return nodes;
}

export interface ChatEntryProps extends React.HTMLAttributes<HTMLLIElement> {
  /** The locale to use for the timestamp. */
  locale: string;
  /** The timestamp of the message. */
  timestamp: number;
  /** The message to display. */
  message: string;
  /** The origin of the message. */
  messageOrigin: 'local' | 'remote';
  /** The sender's name. */
  name?: string;
  /** Whether the message has been edited. */
  hasBeenEdited?: boolean;
}

export const ChatEntry = ({
  name,
  locale,
  timestamp,
  message,
  messageOrigin,
  hasBeenEdited = false,
  className,
  ...props
}: ChatEntryProps) => {
  const time = new Date(timestamp);
  const title = time.toLocaleTimeString(locale, { timeStyle: 'full' });

  return (
    <li
      title={title}
      data-lk-message-origin={messageOrigin}
      className={cn('group flex w-full flex-col gap-0.5', className)}
      {...props}
    >
      <header
        className={cn(
          'text-muted-foreground flex items-center gap-2 text-sm',
          messageOrigin === 'local' ? 'flex-row-reverse' : 'text-left'
        )}
      >
        {name && <strong>{name}</strong>}
        <span className="font-mono text-xs opacity-0 transition-opacity ease-linear group-hover:opacity-100">
          {hasBeenEdited && '*'}
          {time.toLocaleTimeString(locale, { timeStyle: 'short' })}
        </span>
      </header>
      <span
        className={cn(
          'max-w-4/5 rounded-[20px]',
          messageOrigin === 'local' ? 'bg-muted ml-auto p-2' : 'mr-auto'
        )}
      >
        {formatTranscriptLinks(message)}
      </span>
    </li>
  );
};
