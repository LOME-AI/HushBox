import { beforeEach, describe, it, expect } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { ReasoningNotShared } from '@/components/chat/message/thinking-disclosure';
import { buildRenderContext } from '@/components/chat/segments/render-context';
import { SegmentList } from '@/components/chat/segments/segment-list';
import { useSegmentViewState } from '@/components/chat/segments/segment-view-state';
import type { MessageRenderFacts } from '@/components/chat/segments/render-context';
import type { ReasoningSegment, Segment, WebSearchRow } from '@hushbox/shared';

const MODEL = 'Sonnet 4.6';
const TRACE = 'Consider the derivative first.';
const ANSWER = 'The slope is 16.';
const EXAMPLE = [
  { title: 'Example Domain', url: 'https://example.com/' },
  { title: 'Example Organization', url: 'https://example.org/' },
  { title: 'Example Network', url: 'https://example.net/' },
];

const SETTLED_FACTS: MessageRenderFacts = {
  messageId: 'm-1',
  isStreaming: false,
  modelName: MODEL,
  reasoningTokens: undefined,
  reasoningEffort: undefined,
};
const STREAMING_FACTS: MessageRenderFacts = { ...SETTLED_FACTS, isStreaming: true };

function text(value: string): Segment {
  return { kind: 'text', text: value };
}

function span(...children: Segment[]): ReasoningSegment {
  return { kind: 'reasoning', children };
}

function search(...searches: WebSearchRow['searches']): Segment {
  return { kind: 'webSearch', row: { v: 1, searches, notRun: { limit: 0, invalidQuery: 0 } } };
}

/** Streaming, the span open with nothing inside it yet. */
const WAITING: readonly Segment[] = [span()];
/** Streaming, thoughts arriving, no answer yet. */
const REASONING: readonly Segment[] = [span(text(TRACE))];
/** Streaming, the first answer tokens have arrived. */
const ANSWERING: readonly Segment[] = [span(text(TRACE)), text('The slope')];
/** The finished turn. */
const SETTLED: readonly Segment[] = [span(text(TRACE)), text(ANSWER)];
/** Reasoning streamed, then the run stopped without ever answering. */
const STOPPED: readonly Segment[] = [span(text(TRACE))];

function renderTree(
  tree: readonly Segment[],
  facts: Partial<MessageRenderFacts> = {}
): ReturnType<typeof render> {
  const context = buildRenderContext(tree, { ...SETTLED_FACTS, ...facts });
  return render(<SegmentList nodes={tree} context={context} parent="root" />);
}

/** Every state that draws the chrome row, keyed by the label used in failures. */
const ROW_STATES: readonly (readonly [string, () => ReturnType<typeof render>])[] = [
  ['waiting', () => renderTree(WAITING, STREAMING_FACTS)],
  ['reasoning', () => renderTree(REASONING, STREAMING_FACTS)],
  ['answering', () => renderTree(ANSWERING, STREAMING_FACTS)],
  ['settled', () => renderTree(SETTLED)],
  ['not shared', () => render(<ReasoningNotShared tokenCount={1204} />)],
  ['stopped', () => renderTree(STOPPED)],
];

/** The chrome row of whichever state is on screen: the status line, the toggle, or the plain line. */
function row(): HTMLElement {
  return screen.getByTestId(TEST_IDS.thinkingDisclosure).firstElementChild as HTMLElement;
}

/**
 * Opens the disclosure and blocks until the lazily loaded markdown stack has
 * mounted, so nothing renders after the test ends. The block is the markdown
 * module's own promise, awaited to the same resolved module the renderer's
 * `React.lazy` gets from the module registry, never a timed query.
 */
async function openTrace(): Promise<HTMLElement> {
  fireEvent.click(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle));
  await act(async () => {
    await import('@/components/chat/message/markdown-renderer');
  });
  return screen.getByTestId(TEST_IDS.thinkingDisclosureContent);
}

beforeEach(() => {
  useSegmentViewState.setState({ open: new Set() });
});

/** The live one-liner a sighted reader sees. */
function oneLiner(): HTMLElement {
  return screen.getByTestId(TEST_IDS.thinkingDisclosureStatus);
}

/** What the live span's hidden status says, the only line a screen reader hears from it. */
function announcement(): string | null {
  return screen.getByRole('status').textContent;
}

function redrawTree(
  view: ReturnType<typeof render>,
  tree: readonly Segment[],
  facts: Partial<MessageRenderFacts> = {}
): void {
  const context = buildRenderContext(tree, { ...SETTLED_FACTS, ...facts });
  view.rerender(<SegmentList nodes={tree} context={context} parent="root" />);
}

describe('ThinkingDisclosure live', () => {
  it('shows the model as thinking before the first thought arrives', () => {
    renderTree(WAITING, STREAMING_FACTS);
    expect(oneLiner()).toHaveTextContent(`${MODEL} is thinking`);
  });

  it('announces that the model is thinking when it starts', () => {
    renderTree(WAITING, STREAMING_FACTS);
    expect(announcement()).toBe(`${MODEL} is thinking`);
  });

  it('hides its visible one-liner from assistive tech, which hears the status instead', () => {
    renderTree(WAITING, STREAMING_FACTS);
    expect(oneLiner()).toHaveAttribute('aria-hidden', 'true');
  });

  it('sets its dots inside the one-liner, so a wrapped line carries them after its last word', () => {
    renderTree(WAITING, STREAMING_FACTS);
    const words = within(oneLiner()).getByText(`${MODEL} is thinking`);
    expect(words.querySelectorAll('.animate-dot-pulse')).toHaveLength(3);
  });

  it('names an unnamed model as AI while it is thinking', () => {
    renderTree(WAITING, { ...STREAMING_FACTS, modelName: undefined });
    expect(oneLiner()).toHaveTextContent('AI is thinking');
  });

  it('shows only its one-liner while thoughts stream, never the thoughts', () => {
    renderTree(REASONING, STREAMING_FACTS);
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosure)).toHaveTextContent(
      `${MODEL} is thinking`
    );
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosure)).not.toHaveTextContent(TRACE);
  });

  it('offers nothing to open while it is live', () => {
    renderTree(REASONING, STREAMING_FACTS);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('says the model is searching while a search inside it runs', () => {
    renderTree([span(text(TRACE), search({ query: 'q', status: 'searching' }))], STREAMING_FACTS);
    expect(oneLiner()).toHaveTextContent(`${MODEL} is searching the web`);
  });

  it('announces a search inside it by its query', () => {
    const view = renderTree([span(text(TRACE))], STREAMING_FACTS);
    redrawTree(
      view,
      [span(text(TRACE), search({ query: 'postgres 18', status: 'searching' }))],
      STREAMING_FACTS
    );
    expect(announcement()).toBe('Searching the web for postgres 18');
  });

  it('announces searches that start together as one sentence naming each query', () => {
    const view = renderTree([span(text(TRACE))], STREAMING_FACTS);
    redrawTree(
      view,
      [
        span(
          text(TRACE),
          search({ query: 'a', status: 'searching' }, { query: 'b', status: 'searching' })
        ),
      ],
      STREAMING_FACTS
    );
    expect(announcement()).toBe('Searching the web for a and b');
  });

  it('keeps a search finishing out of the announcement until its whole row settles', () => {
    const view = renderTree(
      [
        span(
          text(TRACE),
          search({ query: 'a', status: 'searching' }, { query: 'b', status: 'searching' })
        ),
      ],
      STREAMING_FACTS
    );
    redrawTree(
      view,
      [
        span(
          text(TRACE),
          search(
            { query: 'a', status: 'done', sources: EXAMPLE },
            { query: 'b', status: 'searching' }
          )
        ),
      ],
      STREAMING_FACTS
    );
    expect(announcement()).toBe('Searching the web for a and b');
  });

  it('announces what a search inside it found, never that the model is thinking again', () => {
    const view = renderTree(
      [span(text(TRACE), search({ query: 'a', status: 'searching' }))],
      STREAMING_FACTS
    );
    redrawTree(
      view,
      [span(text(TRACE), search({ query: 'a', status: 'done', sources: EXAMPLE }), text('more'))],
      STREAMING_FACTS
    );
    expect(announcement()).toBe('Searched the web, 3 sources');
  });

  it('announces what a search inside it found when the answer follows straight after', () => {
    const view = renderTree(
      [span(text(TRACE), search({ query: 'a', status: 'searching' }))],
      STREAMING_FACTS
    );
    redrawTree(
      view,
      [span(text(TRACE), search({ query: 'a', status: 'done', sources: EXAMPLE })), text('The')],
      STREAMING_FACTS
    );
    expect(announcement()).toBe('Searched the web, 3 sources');
  });

  it('announces a search whose start and result land in one render', () => {
    const view = renderTree([span(text(TRACE))], STREAMING_FACTS);
    redrawTree(
      view,
      [span(text(TRACE), search({ query: 'a', status: 'done', sources: EXAMPLE }), text('more'))],
      STREAMING_FACTS
    );
    expect(announcement()).toBe('Searched the web, 3 sources');
  });

  it('names an unnamed model as AI while it searches', () => {
    renderTree([span(text(TRACE), search({ query: 'q', status: 'searching' }))], {
      ...STREAMING_FACTS,
      modelName: undefined,
    });
    expect(oneLiner()).toHaveTextContent('AI is searching the web');
  });

  it('carries the progress of several searches inside it', () => {
    renderTree(
      [
        span(
          text(TRACE),
          search(
            { query: 'a', status: 'done', sources: EXAMPLE },
            { query: 'b', status: 'searching' }
          )
        ),
      ],
      STREAMING_FACTS
    );
    expect(oneLiner()).toHaveTextContent(`${MODEL} is searching the web · 1 of 2 done`);
  });

  it('keeps what a settled search found once it thinks again', () => {
    renderTree(
      [span(text(TRACE), search({ query: 'a', status: 'done', sources: EXAMPLE }), text('more'))],
      STREAMING_FACTS
    );
    expect(oneLiner()).toHaveTextContent(`${MODEL} is thinking · Searched 3 sources`);
  });

  it('keeps a search inside live reasoning out of sight', () => {
    renderTree([span(text(TRACE), search({ query: 'q', status: 'searching' }))], STREAMING_FACTS);
    expect(screen.queryByTestId(TEST_IDS.webSearchRow)).not.toBeInTheDocument();
  });

  it('flips the status row to a disclosure button when the answer starts', () => {
    renderTree(ANSWERING, STREAMING_FACTS);
    expect(screen.queryByTestId(TEST_IDS.thinkingDisclosureStatus)).not.toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle).tagName).toBe('BUTTON');
  });

  it('adds no live region for reasoning read from history', () => {
    renderTree(SETTLED);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('ThinkingDisclosure settled', () => {
  it('rests as a closed disclosure carrying no trace text', () => {
    renderTree(SETTLED);
    const toggle = screen.getByTestId(TEST_IDS.thinkingDisclosureToggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosure)).not.toHaveTextContent(TRACE);
    // The panel the button controls is mounted and empty, so the resting
    // footprint is the button and nothing else.
    expect(toggle.nextElementSibling).toBeEmptyDOMElement();
    expect(toggle.nextElementSibling).toHaveAttribute('hidden');
  });

  it('says no answer followed when the run stopped after reasoning', () => {
    renderTree(STOPPED);
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent(
      'Reasoning · stopped before an answer'
    );
  });

  it('labels the disclosure "Reasoning" alone when no effort rung is known', () => {
    renderTree(SETTLED);
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent(/^Reasoning$/);
  });

  it('carries the effort rung in the label when the turn resolved to one', () => {
    renderTree(SETTLED, { reasoningEffort: 'high' });
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent(
      'Reasoning · High effort'
    );
  });

  it('names the rung as an effort with a word boundary at the separator', () => {
    renderTree(SETTLED, { reasoningEffort: 'high' });
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveAccessibleName(
      'Reasoning, High effort'
    );
  });

  it('appends the search fragment after the effort', () => {
    renderTree(
      [span(text(TRACE), search({ query: 'a', status: 'done', sources: EXAMPLE })), text(ANSWER)],
      { reasoningEffort: 'high' }
    );
    const toggle = screen.getByTestId(TEST_IDS.thinkingDisclosureToggle);
    expect(toggle).toHaveTextContent('Reasoning · High effort · Searched 3 sources');
    expect(toggle).toHaveAccessibleName('Reasoning, High effort, Searched 3 sources');
  });

  it('names the effort on the first reasoning row of a message only', () => {
    renderTree(
      [
        span(text('first')),
        text('Part one.'),
        span(text('second'), search({ query: 'a', status: 'done', sources: EXAMPLE })),
        text('Part two.'),
      ],
      { reasoningEffort: 'high' }
    );
    const [first, second] = screen.getAllByTestId(TEST_IDS.thinkingDisclosureToggle);
    expect(first).toHaveTextContent(/^Reasoning · High effort$/);
    expect(second).toHaveTextContent(/^Reasoning · Searched 3 sources$/);
  });
});

describe('ReasoningNotShared', () => {
  it('states plainly when reasoning was billed but never shared', () => {
    render(<ReasoningNotShared tokenCount={1204} />);
    const line = screen.getByTestId(TEST_IDS.reasoningNotShared);
    expect(line).toHaveTextContent('Reasoning not shared · 1,204 tokens');
    expect(line.tagName).toBe('P');
  });

  it('offers no control, since it opens to nothing', () => {
    render(<ReasoningNotShared tokenCount={1204} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ThinkingDisclosure trace', () => {
  it('renders the opened trace through the markdown path', async () => {
    renderTree([span(text('**Weighing** the options.')), text(ANSWER)]);
    const content = await openTrace();
    expect(content).toHaveTextContent('Weighing the options.');
    expect(content.textContent).not.toContain('**');
  });

  it('mints no document from a fenced block inside the trace', async () => {
    const fence = Array.from({ length: 15 }, (_, index) => `const line${String(index)} = 1;`).join(
      '\n'
    );
    renderTree([span(text(`\`\`\`typescript\n${fence}\n\`\`\``)), text(ANSWER)]);
    await openTrace();
    await expect(screen.findByTestId(TEST_IDS.documentCard)).rejects.toThrow();
  });

  it('reads forwards: the opened trace is neither reversed nor internally scrolled', async () => {
    renderTree(SETTLED);
    const content = await openTrace();
    for (
      let element: HTMLElement | null = content;
      element !== null;
      element = element.parentElement
    ) {
      expect(element.className).not.toMatch(/flex-col-reverse|overflow-y-auto/);
      if (element.dataset['testid'] === TEST_IDS.thinkingDisclosure) break;
    }
  });

  it('shows the reasoning token count inside the opened trace, never in the label', async () => {
    renderTree(SETTLED, { reasoningTokens: 1204 });
    const toggle = screen.getByTestId(TEST_IDS.thinkingDisclosureToggle);
    const panel = toggle.nextElementSibling;
    expect(toggle).not.toHaveTextContent('1,204');
    await openTrace();
    expect(panel).toHaveTextContent('1,204 reasoning tokens');
  });

  it('shows the partial trace of a run that stopped before answering', async () => {
    renderTree(STOPPED);
    expect(await openTrace()).toHaveTextContent(TRACE);
  });

  it('shows a search inside the opened reasoning, between the thoughts it came between', async () => {
    renderTree([
      span(text('before'), search({ query: 'a', status: 'done', sources: EXAMPLE }), text('after')),
      text(ANSWER),
    ]);
    const content = await openTrace();
    const nested = screen.getByTestId(TEST_IDS.webSearchRow);
    expect(content).toContainElement(nested);
    expect(content.textContent.indexOf('before')).toBeLessThan(
      content.textContent.indexOf('Searched the web')
    );
    expect(content.textContent.indexOf('Searched the web')).toBeLessThan(
      content.textContent.indexOf('after')
    );
  });

  it('opening the reasoning leaves the searches inside it closed', async () => {
    renderTree([
      span(text('t'), search({ query: 'a', status: 'done', sources: EXAMPLE })),
      text(ANSWER),
    ]);
    await openTrace();
    expect(screen.getByTestId(TEST_IDS.webSearchRowToggle)).toHaveAttribute(
      'aria-expanded',
      'false'
    );
  });

  it('stays open while the answer streams on and a search joins it', async () => {
    const view = renderTree(ANSWERING, STREAMING_FACTS);
    await openTrace();
    const joined = [...ANSWERING, search({ query: 'q', status: 'searching' })];
    view.rerender(
      <SegmentList
        nodes={joined}
        context={buildRenderContext(joined, STREAMING_FACTS)}
        parent="root"
      />
    );
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveAttribute(
      'aria-expanded',
      'true'
    );
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureContent)).toHaveTextContent(TRACE);
  });

  it('collapses again on a second click', async () => {
    renderTree(SETTLED);
    await openTrace();
    const toggle = screen.getByTestId(TEST_IDS.thinkingDisclosureToggle);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId(TEST_IDS.thinkingDisclosureContent)).not.toBeInTheDocument();
  });

  it('stays open when its row is mounted again under the same message', async () => {
    const { unmount } = renderTree(SETTLED);
    await openTrace();
    unmount();
    renderTree(SETTLED);
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveAttribute(
      'aria-expanded',
      'true'
    );
  });
});

describe('ThinkingDisclosure disclosure control', () => {
  it('wires aria-controls to a panel that resolves while collapsed', () => {
    renderTree(SETTLED);
    const controls = screen
      .getByTestId(TEST_IDS.thinkingDisclosureToggle)
      .getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    expect(document.querySelector(`[id="${controls ?? ''}"]`)).toBeInTheDocument();
  });

  it('keeps a focus ring no layout in the component can clip', () => {
    renderTree(SETTLED);
    const toggle = screen.getByTestId(TEST_IDS.thinkingDisclosureToggle);
    expect(toggle.className).toContain('focus-visible:outline-2');
    expect(toggle.className).toContain('focus-visible:outline-offset-2');
    expect(screen.getByTestId(TEST_IDS.thinkingDisclosure).innerHTML).not.toContain(
      'overflow-hidden'
    );
  });
});

describe('ThinkingDisclosure chrome', () => {
  it('starts the label at the same offset in every state', () => {
    const offsets = ROW_STATES.map(([, draw]) => {
      const { unmount } = draw();
      const lead = row().firstElementChild as HTMLElement;
      const measured = `${lead.className}|${row().className.includes('gap-1.5') ? 'gap' : 'no-gap'}`;
      unmount();
      return measured;
    });
    expect(new Set(offsets).size).toBe(1);
    expect(offsets[0]).toContain('w-3');
  });

  it('keeps the row at a 24px hit target in every state', () => {
    for (const [name, draw] of ROW_STATES) {
      const { unmount } = draw();
      expect(row().className, name).toContain('min-h-6');
      unmount();
    }
  });

  it('sets the row in the UI sans inside a reading region', () => {
    renderTree(SETTLED);
    expect(row().className).toContain('font-sans');
  });

  it('sets the trace in the reading serif, a step below the answer', async () => {
    renderTree(SETTLED);
    const content = await openTrace();
    expect(content.className).toContain('font-serif');
    expect(content.className).toContain('text-[0.9375rem]');
    expect(content.className).toContain('max-w-[68ch]');
  });

  it('draws no container around any state', () => {
    for (const [name, draw] of ROW_STATES) {
      const { unmount } = draw();
      const surface = screen.getByTestId(TEST_IDS.thinkingDisclosure);
      for (const element of [surface, row()]) {
        expect(element.className, name).not.toMatch(/(^|:)(border|rounded|bg-)/);
      }
      unmount();
    }
  });

  it('moves only the dots while thinking', () => {
    const { container } = renderTree(REASONING, STREAMING_FACTS);
    expect(container.querySelectorAll('.animate-dot-pulse')).toHaveLength(3);
  });

  it('moves only the chevron once the disclosure exists', () => {
    const { container } = renderTree(SETTLED);
    expect(container.querySelectorAll('.animate-dot-pulse')).toHaveLength(0);
    const chevron = screen.getByTestId(TEST_IDS.thinkingDisclosureToggle).querySelector('svg');
    expect(chevron?.getAttribute('class')).toContain('transition-transform');
  });

  it('turns the chevron when the trace opens', async () => {
    renderTree(SETTLED);
    await openTrace();
    const chevron = screen.getByTestId(TEST_IDS.thinkingDisclosureToggle).querySelector('svg');
    expect(chevron?.getAttribute('class')).toContain('rotate-90');
  });
});
