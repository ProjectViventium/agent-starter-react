/*
 * Text of one transcript line (CP-CMP-032).
 *
 * The transcript shows text that came from outside (the assistant's words, tool results read
 * aloud), so it is rendered as text, never as HTML or full markdown: `[label](address)` and bare
 * web addresses become links that open in a new tab, text in backticks shows as code, and
 * everything else stays literal. Only http and https addresses become clickable; a link that has
 * not finished arriving stays plain text until it is complete.
 *
 * Why not the base's markdown renderer (`Streamdown`): with its default settings it turned an
 * `<iframe>` and remote `<img>` in a message into a live frame and a loaded image (tried
 * 10 Nov 2026 against the cases in `transcript-text.test.tsx`).
 */
import * as React from 'react';
import { formatChatMessageLinks } from '@livekit/components-react';
import { readTranscriptLink, transcriptHttpHref } from '@/lib/citations';

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
          className="text-primary font-medium wrap-anywhere underline underline-offset-4"
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

export function TranscriptText({ text }: { text: string }) {
  return <>{formatTranscriptLinks(text)}</>;
}
