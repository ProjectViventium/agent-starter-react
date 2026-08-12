import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import {
  CallActivity,
  LatestSpeakerCaption,
  SpeakerTranscript,
} from '@/components/app/call-activity';
import type { SpeakerSegmentV1, VoiceTaskEventV1, VoiceTaskView } from '@/lib/voice-events';

function task(overrides: Partial<VoiceTaskEventV1> = {}): VoiceTaskEventV1 {
  return {
    version: 1,
    eventId: 'event-1',
    sequence: 1,
    emittedAt: '2026-08-09T12:00:00.000Z',
    callSessionId: 'call-1',
    taskId: 'task-1',
    type: 'progress',
    state: 'running',
    phase: 'Searching trusted sources',
    label: 'Market lookup',
    progress: { current: 2, total: 4, unit: 'sources' },
    source: { title: 'Primary documentation', url: 'https://example.com/docs' },
    cancellable: true,
    retryable: false,
    ...overrides,
  };
}

function view(overrides: Partial<VoiceTaskEventV1> = {}): VoiceTaskView {
  const event = task(overrides);
  return {
    ...event,
    firstEmittedAt: event.emittedAt,
    sources: event.source ? [event.source] : [],
  };
}

function segment(overrides: Partial<SpeakerSegmentV1> = {}): SpeakerSegmentV1 {
  return {
    version: 1,
    segmentId: 'segment-1',
    callSessionId: 'call-1',
    turnId: 'turn-1',
    sequence: 1,
    revision: 2,
    text: 'We should ship this carefully.',
    isFinal: true,
    speaker: {
      key: 'speaker-1',
      label: 'Speaker 1',
      source: 'provider_diarization',
      attribution: 'unverified',
      actorTrust: 'shared_mic_unverified',
    },
    ...overrides,
  };
}

describe('CallActivity', () => {
  it('shows only authoritative work details and exposes cancel without visual clutter', () => {
    const onCancel = vi.fn();
    render(<CallActivity tasks={[view()]} onCancel={onCancel} onRetry={vi.fn()} />);

    expect(screen.getByRole('status')).toHaveTextContent('Market lookup');
    expect(screen.getByRole('status')).toHaveTextContent('Searching trusted sources');
    expect(screen.getByRole('status')).toHaveTextContent('2 of 4 sources');
    expect(screen.getByRole('link', { name: 'Primary documentation' })).toHaveAttribute(
      'href',
      'https://example.com/docs'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel Market lookup' }));
    expect(onCancel).toHaveBeenCalledWith('task-1');
  });

  it('renders needs-input and retry only when authoritative state allows them', () => {
    const onRetry = vi.fn();
    render(
      <CallActivity
        tasks={[
          view({
            state: 'needs_input',
            type: 'needs_input',
            needsInput: { prompt: 'Which report should I use?', inputType: 'text' },
            cancellable: false,
          }),
          view({
            eventId: 'event-2',
            taskId: 'task-2',
            sequence: 2,
            state: 'failed',
            type: 'error',
            label: 'Second task',
            retryable: true,
            cancellable: false,
          }),
        ]}
        onCancel={vi.fn()}
        onRetry={onRetry}
      />
    );
    expect(screen.getByText('Which report should I use?')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Retry Second task' }));
    expect(onRetry).toHaveBeenCalledWith('task-2');
  });

  it('renders hostile source URLs as non-clickable text', () => {
    render(
      <CallActivity
        tasks={[view({ source: { title: 'Unsafe source', url: 'javascript:alert(1)' } })]}
      />
    );
    expect(screen.getByText('Unsafe source')).not.toHaveAttribute('href');
    expect(screen.queryByRole('link', { name: 'Unsafe source' })).not.toBeInTheDocument();
  });

  it('retains and renders multiple authoritative sources', () => {
    const first = { id: 'one', title: 'First source', url: 'https://one.example' };
    const second = { id: 'two', title: 'Second source', url: 'https://two.example' };
    render(<CallActivity tasks={[{ ...view({ source: second }), sources: [first, second] }]} />);
    expect(screen.getByRole('link', { name: 'First source' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Second source' })).toBeVisible();
  });

  it('briefly shows terminal state and then dismisses the compact card', () => {
    vi.useFakeTimers();
    render(<CallActivity tasks={[view({ state: 'completed', type: 'result' })]} />);
    expect(screen.getByText('completed')).toBeVisible();
    act(() => vi.advanceTimersByTime(8_001));
    expect(screen.queryByText('completed')).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it('keeps cancel but suppresses retry and new-work input in Listen-Only', () => {
    render(
      <CallActivity
        mode="listen_only"
        tasks={[
          view({
            state: 'needs_input',
            type: 'needs_input',
            needsInput: { prompt: 'Should I continue?', inputType: 'confirm' },
            cancellable: true,
            retryable: true,
          }),
        ]}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
        onInput={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Cancel Market lookup' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Retry Market lookup' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('does not put interactive task controls inside a status live region', () => {
    render(<CallActivity tasks={[view()]} onCancel={vi.fn()} />);
    const cancel = screen.getByRole('button', { name: 'Cancel Market lookup' });
    expect(cancel.closest('[role="status"]')).toBeNull();
    expect(screen.getByRole('status', { name: 'Call activity update' })).toBeVisible();
  });
});

describe('SpeakerTranscript', () => {
  it('renders call-scoped speaker labels, revisions, overlap, and Unknown abstention', () => {
    render(
      <SpeakerTranscript
        segments={[
          segment(),
          segment({
            segmentId: 'segment-2',
            sequence: 2,
            revision: 0,
            uncertain: true,
            overlap: true,
            text: 'I could not attribute this safely.',
            speaker: {
              key: 'unknown',
              label: 'Unknown',
              source: 'unknown',
              attribution: 'unknown',
              actorTrust: 'unknown',
            },
          }),
        ]}
      />
    );

    expect(screen.getByText('Speaker 1')).toBeVisible();
    expect(screen.getByText('Unknown')).toBeVisible();
    expect(screen.getByText('Updated')).toBeVisible();
    expect(screen.getByText('Overlapping · uncertain')).toBeVisible();
  });

  it('updates the passive latest caption revision in place with truthful attribution', () => {
    const { rerender } = render(<LatestSpeakerCaption segments={[segment({ revision: 1 })]} />);
    const liveRegion = screen.getByRole('status');
    expect(liveRegion).toHaveTextContent('Speaker 1 · We should ship this carefully.');

    rerender(
      <LatestSpeakerCaption
        segments={[
          segment({
            revision: 2,
            text: 'Revised words.',
            overlap: true,
            uncertain: true,
          }),
        ]}
      />
    );
    expect(screen.getByRole('status')).toBe(liveRegion);
    expect(liveRegion).toHaveTextContent('Unknown · overlapping · Revised words.');
  });

  it('automatically windows more than four thousand segments while preserving full scroll access', () => {
    const segments = Array.from({ length: 4_096 }, (_, index) =>
      segment({
        segmentId: `segment-${index}`,
        turnId: `turn-${index}`,
        sequence: index,
        revision: 1,
        text: `Synthetic speaker segment ${index}`,
      })
    );
    const scrollContainerRef = React.createRef<HTMLDivElement>();
    render(
      <div ref={scrollContainerRef}>
        <SpeakerTranscript segments={segments} scrollContainerRef={scrollContainerRef} />
      </div>
    );

    const container = scrollContainerRef.current!;
    const transcript = screen.getByRole('list', { name: 'Speaker transcript' });
    const rect = (top: number, bottom: number) => ({
      top,
      bottom,
      left: 0,
      right: 500,
      width: 500,
      height: bottom - top,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
    vi.spyOn(container, 'getBoundingClientRect').mockImplementation(() => rect(0, 600));
    const transcriptRect = vi
      .spyOn(transcript, 'getBoundingClientRect')
      .mockImplementation(() => rect(20, 580));

    expect(screen.getByText('Synthetic speaker segment 4095')).toBeVisible();
    expect(screen.queryByText('Synthetic speaker segment 0')).not.toBeInTheDocument();
    expect(transcript.querySelectorAll('li')).toHaveLength(160);

    for (let index = 0; index < 34; index += 1) {
      fireEvent.scroll(container);
    }

    expect(screen.getByText('Synthetic speaker segment 0')).toBeVisible();
    expect(transcript.querySelectorAll('li').length).toBeLessThanOrEqual(512);
    expect(transcript.querySelector('li')).toHaveAttribute('aria-setsize', '4096');
    expect(transcript.querySelector('li')).toHaveAttribute('aria-posinset', '1');

    transcriptRect.mockImplementation(() => rect(-500, 580));
    for (let index = 0; index < 34; index += 1) {
      fireEvent.scroll(container);
    }

    expect(screen.getByText('Synthetic speaker segment 4095')).toBeVisible();
    expect(screen.queryByText('Synthetic speaker segment 0')).not.toBeInTheDocument();
    expect(transcript.querySelectorAll('li').length).toBeLessThanOrEqual(512);
  });
});
