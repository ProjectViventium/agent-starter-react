import React from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChatEntry } from '@/components/livekit/chat-entry';
import { stripVoiceControlTagsForDisplay } from '@/lib/citations';

const display = (message: string) =>
  render(<ChatEntry locale="en" timestamp={0} message={message} messageOrigin="remote" />);

describe('Call transcript links', () => {
  it('renders the authored label and exact workspace target', () => {
    const href = 'https://work.example.test/w/work_01';
    const { container } = display(`Open [View / Steer work](${href}).`);
    const link = screen.getByRole('link', { name: 'View / Steer work' });
    expect(link.getAttribute('href')).toBe(href);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(container).toHaveTextContent('Open View / Steer work.');
    expect(container.textContent).not.toContain('](');
    expect(container.textContent).not.toContain(href);
  });

  it('preserves a lowercase label through remote control cleanup', () => {
    const href = 'https://docs.example.test/report';
    display(stripVoiceControlTagsForDisplay(`[thinking] [report](${href})`));
    expect(screen.getByRole('link', { name: 'report' }).getAttribute('href')).toBe(href);
    expect(screen.queryByText('[thinking]')).not.toBeInTheDocument();
  });

  it.each([
    ['(https://docs.example.test/report).', 'https://docs.example.test/report'],
    ['https://docs.example.test/Function_(math).', 'https://docs.example.test/Function_(math)'],
    ['https://docs.example.test/a[b]).', 'https://docs.example.test/a[b]'],
  ])('keeps outside punctuation out of a bare target: %s', (message, href) => {
    const { container } = display(message);
    expect(screen.getByRole('link').getAttribute('href')).toBe(href);
    expect(container).toHaveTextContent(message);
  });

  it('preserves balanced destinations and query/email/fragment bytes', () => {
    const href =
      'https://docs.example.test/Function_(math)?part=A_B&contact=qa@example.test&x=A%29B#Result';
    display(`[Report](${href})`);
    expect(screen.getByRole('link', { name: 'Report' }).getAttribute('href')).toBe(href);
  });

  it('accepts an angle destination without normalizing URL bytes', () => {
    const href = 'HTTPS://docs.example.test/Guide_(A)?part=A_B#Result';
    display(`[Report](<${href}>)`);
    expect(screen.getByRole('link', { name: 'Report' }).getAttribute('href')).toBe(href);
  });

  it('handles escaped label and destination delimiters', () => {
    display('[Report \\[A\\]](https://docs.example.test/a\\))');
    expect(screen.getByRole('link', { name: 'Report [A]' }).getAttribute('href')).toBe(
      'https://docs.example.test/a)'
    );
  });

  it.each([
    '[Unsafe](javascript:alert(1))',
    '[Unsafe](data:text/html,example)',
    'javascript://example.test/action',
    '[Report](https://docs.example.test/report "Title")',
    '[Report](https://docs.example.test/a b)',
  ])('keeps unsafe or unsupported destinations literal: %s', (message) => {
    const { container } = display(message);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(container).toHaveTextContent(message);
  });

  it('does not recursively linkify a URL in a Markdown label', () => {
    display('[https://label.example.test](https://target.example.test/report)');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(
      screen.getByRole('link', { name: 'https://label.example.test' }).getAttribute('href')
    ).toBe('https://target.example.test/report');
  });

  it('keeps adjacent links and intervening text in order', () => {
    const { container } = display(
      '[One](https://docs.example.test/one), [Two](https://docs.example.test/two); https://docs.example.test/three.'
    );
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      'https://docs.example.test/one',
      'https://docs.example.test/two',
      'https://docs.example.test/three',
    ]);
    expect(container).toHaveTextContent('One, Two; https://docs.example.test/three.');
  });

  it('renders HTML-like labels as escaped React text', () => {
    const { container } = display(
      '[<img src=x onerror=alert(1)>](https://docs.example.test/report)'
    );
    expect(screen.getByRole('link')).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(container.querySelector('img')).toBeNull();
  });

  it.each(['[report](', '[report](https://exa', '[report](<https://exa'])(
    'holds an incomplete link as literal text through remote cleanup: %s',
    (message) => {
      const { container } = display(stripVoiceControlTagsForDisplay(message));
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(container).toHaveTextContent(message);
    }
  );

  it('classifies a completed invalid stage direction using the existing cleanup', () => {
    display(stripVoiceControlTagsForDisplay('[sighs](softly)'));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByText('[sighs](softly)')).not.toBeInTheDocument();
    expect(screen.getByText('(softly)')).toBeInTheDocument();
  });

  it('retains ordinary bare domain and email formatting', () => {
    display('Open example.test or email qa@example.test.');
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      'https://example.test',
      'mailto:qa@example.test',
    ]);
  });

  it.each(['`report.pdf`', '`https://docs.example.test/report`', '``a`b.pdf``'])(
    'keeps code content out of bare-link formatting: %s',
    (message) => {
      const { container } = display(message);
      expect(screen.queryByRole('link')).not.toBeInTheDocument();
      expect(container.querySelector('code')).toBeInTheDocument();
    }
  );

  it('holds an incomplete code span while preserving links outside complete code', () => {
    display('`report.pdf` https://docs.example.test/report `https://unfinished.example.test');
    expect(screen.getAllByRole('link').map((link) => link.getAttribute('href'))).toEqual([
      'https://docs.example.test/report',
    ]);
    expect(screen.getByText('report.pdf')).toBeInTheDocument();
  });
});
