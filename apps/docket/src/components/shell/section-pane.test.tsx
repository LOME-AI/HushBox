import { useState } from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { makeFinding } from '@/test-utils/finding-fixture';
import { stubIntersectionObserver } from '@/test-utils/intersection-observer';
import { useHotkeyHold, useHotkeysHeld } from '@/components/hotkey-hold';
import { TEST_IDS } from '@/test-ids';
import { PromptForm } from '@/components/finding/prompt-form';
import { STACK_SPAN } from './logic/finding-window';
import { sectionSpec } from './logic/sections';
import { SectionPane } from './section-pane';
import type { SectionPaneProps } from './section-pane';
import type { SectionId } from './logic/sections';
import type { IntersectionStub } from '@/test-utils/intersection-observer';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

const three: readonly FindingJson[] = [
  makeFinding({ id: 'A-1' }),
  makeFinding({ id: 'A-2' }),
  makeFinding({ id: 'A-3' }),
];

function renderPane({
  container,
  ...props
}: Partial<SectionPaneProps> & { container?: HTMLElement } = {}): {
  onOpen: ReturnType<typeof vi.fn>;
  rerender: (focus: string) => void;
  rerenderSection: (section: SectionId, focus: string) => void;
} {
  const onOpen = vi.fn();
  const pane = (focus: string | null, section: SectionId = 'open'): JSX.Element => (
    <SectionPane
      findings={three}
      onOpen={onOpen}
      mode="list"
      filtering={false}
      onClearFilters={(): void => {}}
      {...props}
      section={sectionSpec(section)}
      focus={focus}
    />
  );
  const view = render(pane(props.focus ?? null), container === undefined ? {} : { container });
  return {
    onOpen,
    rerender: (focus: string): void => {
      view.rerender(pane(focus));
    },
    rerenderSection: (section: SectionId, focus: string): void => {
      view.rerender(pane(focus, section));
    },
  };
}

/**
 * A list-mode pane whose queue is meant to be handed a wider one between two
 * renders. A deferred read is only visible across such a widening: the pass the
 * widening triggers is still holding the queue from before it.
 */
function widening(
  props: Partial<SectionPaneProps>
): (findings: readonly FindingJson[]) => JSX.Element {
  function pane(findings: readonly FindingJson[]): JSX.Element {
    return (
      <SectionPane
        section={sectionSpec('open')}
        findings={findings}
        focus={null}
        onOpen={vi.fn()}
        mode="list"
        filtering={false}
        onClearFilters={(): void => {}}
        {...props}
      />
    );
  }
  return pane;
}

describe('SectionPane', () => {
  it('renders one row per finding in list mode', () => {
    renderPane();

    expect(screen.getAllByTestId(TEST_IDS.findingRow)).toHaveLength(3);
  });

  it('opens the finding a reader picks off the queue', () => {
    const { onOpen } = renderPane();

    fireEvent.click(screen.getAllByTestId(TEST_IDS.findingRow)[1]!);

    expect(onOpen).toHaveBeenCalledWith('A-2');
  });

  it('shows the section its own empty copy when it holds nothing', () => {
    renderPane({ findings: [] });

    expect(screen.getByText(sectionSpec('open').emptyTitle)).toBeInTheDocument();
  });

  it('says the filters are what emptied the section, not the audit', () => {
    renderPane({ findings: [], filtering: true });

    expect(screen.getByText('No finding matches these filters')).toBeInTheDocument();
  });

  it('clears the filters from the empty state', () => {
    const onClearFilters = vi.fn();
    renderPane({ findings: [], filtering: true, onClearFilters });

    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));

    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  /**
   * The queue is read by scrolling, not by paging: the findings either side of
   * the reader's are on screen under and over it, so the next one is already
   * there to be scrolled to rather than stepped to.
   */
  it('stacks the queue in focus mode, so reading runs on past the finding the reader is on', () => {
    renderPane({
      mode: 'focus',
      focus: 'A-2',
      renderDetail: (finding) => <p>card {finding.id}</p>,
    });

    expect(screen.getByText('card A-1')).toBeInTheDocument();
    expect(screen.getByText('card A-2')).toBeInTheDocument();
    expect(screen.getByText('card A-3')).toBeInTheDocument();
  });

  it('stacks the findings in the order the queue reads', () => {
    const { container } = render(<p />);
    renderPane({
      container,
      mode: 'focus',
      focus: 'A-2',
      renderDetail: (finding) => <p>card {finding.id}</p>,
    });

    expect(container.textContent).toContain('card A-1card A-2card A-3');
  });

  it('shows no rows in focus mode', () => {
    renderPane({ mode: 'focus', focus: 'A-2' });

    expect(screen.queryByTestId(TEST_IDS.findingRow)).not.toBeInTheDocument();
  });

  /**
   * The reader scrolling is the only thing that carries them down a long queue,
   * and until it moved the stack the console showed four findings out of
   * several hundred and then simply ended. Everything below is driven by the
   * observer, because nothing else can move the stack.
   */
  describe('scrolling through the queue', () => {
    const long = Array.from({ length: 40 }, (_unused, index) =>
      makeFinding({ id: `long-${String(index)}` })
    );

    let stub: IntersectionStub | null = null;

    afterEach(() => {
      stub?.restore();
      stub = null;
    });

    function scrolled(
      props: Partial<SectionPaneProps> = {},
      container?: HTMLElement
    ): {
      cards: () => readonly string[];
      sentinel: () => Element | null;
      reachEnd: () => void;
      seeCard: (id: string) => void;
    } {
      stub = stubIntersectionObserver();
      renderPane({
        findings: long,
        mode: 'focus',
        focus: 'long-0',
        renderDetail: (finding) => <p>card {finding.id}</p>,
        ...(container === undefined ? {} : { container }),
        ...props,
      });
      const card = (id: string): Element | null => document.querySelector(`[data-finding="${id}"]`);
      return {
        cards: () =>
          [...document.querySelectorAll('[data-finding]')].map(
            (node) => (node as HTMLElement).dataset['finding'] ?? ''
          ),
        sentinel: () => document.querySelector('[data-slot="stack-end"]'),
        reachEnd: () => {
          const end = document.querySelector('[data-slot="stack-end"]');
          if (end !== null) stub?.show([end]);
        },
        seeCard: (id) => {
          const found = card(id);
          if (found !== null) stub?.show([found]);
        },
      };
    }

    it('ends the stack with something the reader can reach by scrolling', () => {
      const stack = scrolled();

      expect(stack.sentinel()).not.toBeNull();
    });

    /**
     * The hooks measure against whichever pane their element sits in, so what
     * this pins is the wiring: the stack and its sentinel are inside the pane
     * the reader scrolls. Move either out of it and both observers start
     * measuring the window, which in this console is a box nobody ever moves.
     */
    it('puts the stack and its end inside the pane both observers measure', () => {
      const pane = document.createElement('div');
      pane.style.overflowY = 'auto';
      document.body.append(pane);

      scrolled({}, pane);

      expect(stub?.built().map((options) => options.root)).toEqual([pane, pane]);
    });

    it('mounts more of the queue when the reader reaches the bottom of the stack', () => {
      const stack = scrolled();
      const before = stack.cards().length;

      stack.reachEnd();

      expect(stack.cards().length).toBeGreaterThan(before);
    });

    it('carries on to the last finding in the queue, rather than ending at a slice', () => {
      const stack = scrolled();

      for (let reached = 0; reached < 40; reached += 1) stack.reachEnd();

      expect(stack.cards()).toContain('long-39');
      expect(stack.sentinel()).toBeNull();
    });

    /**
     * The keyboard has to aim where the reader is looking. Without this a reader
     * scrolls to a finding, presses a digit, and rules a different one.
     */
    it('reports the finding the reader has scrolled to', () => {
      const onSee = vi.fn<(id: string) => void>();
      const stack = scrolled({ onSee });
      stack.reachEnd();

      stack.seeCard('long-5');

      expect(onSee).toHaveBeenLastCalledWith('long-5');
    });

    /**
     * The sections that render their own list do not follow the reader's
     * scrolling, so the pane has to survive being scrolled without a caller
     * that wants to hear about it.
     */
    it('takes a scroll no caller asked to hear about', () => {
      const stack = scrolled();

      expect(() => {
        stack.seeCard('long-1');
      }).not.toThrow();
    });

    it('watches the findings it has mounted, so growth brings more under the observer', () => {
      const stack = scrolled();

      stack.reachEnd();

      expect(stub?.watching().length).toBeGreaterThan(0);
      expect(stack.cards()).toContain('long-7');
    });
  });

  /**
   * The corpus is several hundred findings and a card carries the finding's
   * whole body plus a text box per option, so the stack starts as a window over
   * the queue rather than the queue itself.
   */
  it('stacks a bounded window rather than the whole queue', () => {
    const long = Array.from({ length: 40 }, (_unused, index) =>
      makeFinding({ id: `long-${String(index)}` })
    );

    renderPane({
      findings: long,
      mode: 'focus',
      focus: 'long-20',
      renderDetail: () => <p>card</p>,
    });

    expect(screen.getAllByText('card')).toHaveLength(STACK_SPAN);
  });

  /**
   * Every decision key is registered on the window, so a stack with two cards
   * answering would rule a finding the reader is not looking at.
   */
  it('tells the stack which one card the keyboard answers', () => {
    renderPane({
      mode: 'focus',
      focus: 'A-2',
      renderDetail: (finding, active) => (
        <p>
          {finding.id} {String(active)}
        </p>
      ),
    });

    expect(screen.getByText('A-1 false')).toBeInTheDocument();
    expect(screen.getByText('A-2 true')).toBeInTheDocument();
    expect(screen.getByText('A-3 false')).toBeInTheDocument();
  });

  it('falls back to the first finding when the focused one is not in this section', () => {
    renderPane({
      mode: 'focus',
      focus: 'Z-9',
      // Named by which card the reader is on rather than by which is first in
      // the stack: the whole point is where the fallback puts them.
      renderDetail: (finding, active) => (active ? <p>reader on {finding.id}</p> : <p />),
    });

    expect(screen.getByText('reader on A-1')).toBeInTheDocument();
  });

  it('reads out where the reader is in the queue', () => {
    renderPane({ mode: 'focus', focus: 'A-2' });

    expect(screen.getByText('2 of 3')).toBeInTheDocument();
  });

  /**
   * The queue is worked through continuously, and a control that has to be
   * clicked between one finding and the next is a stop in the middle of that.
   * The keyboard steps instead, which is where the reader's hands already are.
   */
  it('offers no paging controls', () => {
    renderPane({ mode: 'focus', focus: 'A-2' });

    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous' })).not.toBeInTheDocument();
  });

  it('shows the empty state in focus mode too', () => {
    renderPane({ mode: 'focus', findings: [] });

    expect(screen.getByText(sectionSpec('open').emptyTitle)).toBeInTheDocument();
  });

  it('lets a section replace the queue with a body of its own', () => {
    renderPane({ renderBody: (findings) => <p>board of {findings.length}</p> });

    expect(screen.getByText('board of 3')).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.findingRow)).not.toBeInTheDocument();
  });

  it('still shows the empty state to a section that renders its own body', () => {
    renderPane({ findings: [], renderBody: () => <p>board</p> });

    expect(screen.getByText(sectionSpec('open').emptyTitle)).toBeInTheDocument();
  });

  it('lets a section render the list its own way while keeping focus mode', () => {
    renderPane({ renderList: (findings) => <p>review of {findings.length}</p> });

    expect(screen.getByText('review of 3')).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.findingRow)).not.toBeInTheDocument();
  });

  it('leaves the focused finding to the card even when the list is the section’s own', () => {
    renderPane({ mode: 'focus', renderList: () => <p>review</p> });

    expect(screen.queryByText('review')).not.toBeInTheDocument();
    expect(screen.getAllByTestId(TEST_IDS.focusedFinding)).not.toHaveLength(0);
  });

  it('puts a section lead above the queue rather than in place of it', () => {
    renderPane({ renderLead: (findings) => <p>waiting on {findings.length}</p> });

    expect(screen.getByText('waiting on 3')).toBeInTheDocument();
    expect(screen.getAllByTestId(TEST_IDS.findingRow)).toHaveLength(3);
  });

  it('puts the lead above the focused finding too', () => {
    renderPane({ mode: 'focus', renderLead: () => <p>waiting</p> });

    expect(screen.getByText('waiting')).toBeInTheDocument();
    expect(screen.getAllByTestId(TEST_IDS.focusedFinding)).not.toHaveLength(0);
  });

  it('shows no lead to a section that has none', () => {
    renderPane({});

    expect(screen.queryByText('waiting')).not.toBeInTheDocument();
  });

  it('lets the caller render the focused finding its own way', () => {
    renderPane({
      mode: 'focus',
      focus: 'A-2',
      renderDetail: (finding) => <p>ruling {finding.id}</p>,
    });

    expect(screen.getByText('ruling A-2')).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.focusedFinding)).not.toBeInTheDocument();
  });

  /**
   * A ruling card whose box is keyed to the finding, which is how the card
   * hands the box over: moving to another finding tears it down, and the
   * half-written words are the moment that would otherwise be lost.
   */
  const promptDetail = (finding: FindingJson): JSX.Element => (
    <PromptForm
      key={finding.id}
      title={finding.id}
      placeholder="why"
      submitLabel="Deny"
      onSubmit={vi.fn()}
    />
  );

  /**
   * The same box, wired the way the card wires it: what the reader is writing
   * takes the console's keyboard until they stop. Only the wiring is stood in
   * for — the retraction under test is the prompt's own.
   */
  function HoldingPrompt({ finding }: Readonly<{ finding: FindingJson }>): JSX.Element {
    const [drafting, setDrafting] = useState(false);
    useHotkeyHold(drafting);

    return (
      <PromptForm
        title={finding.id}
        placeholder="why"
        submitLabel="Deny"
        onSubmit={vi.fn()}
        onDrafting={setDrafting}
      />
    );
  }

  const holdingDetail = (finding: FindingJson): JSX.Element => (
    <HoldingPrompt key={finding.id} finding={finding} />
  );

  /**
   * The same wiring, on a card that withholds its box while staying on screen —
   * a denial box on a finding that has just been denied, a note whose option was
   * removed. The card outlives the box, so nothing else can hand the keyboard
   * back: the retraction has to be the box's own.
   */
  function WithholdablePrompt({ finding }: Readonly<{ finding: FindingJson }>): JSX.Element {
    const [drafting, setDrafting] = useState(false);
    const [open, setOpen] = useState(true);
    useHotkeyHold(drafting);

    return (
      <div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
          }}
        >
          Withhold {finding.id}
        </button>
        {open && (
          <PromptForm
            title={finding.id}
            placeholder="why"
            submitLabel="Deny"
            onSubmit={vi.fn()}
            onDrafting={setDrafting}
          />
        )}
      </div>
    );
  }

  /**
   * A draft outlives the prompt that holds it, keyed by finding id, so two tests
   * writing on one id write on one entry — inert only while they happen to type
   * the same words. Minting the pair here keeps every draft test's keys out of
   * reach of the rest of the file whatever it types.
   */
  let drafted = 0;
  const draftPair = (): readonly [FindingJson, FindingJson] => {
    drafted += 1;
    const nth = String(drafted);
    return [makeFinding({ id: `draft-${nth}-a` }), makeFinding({ id: `draft-${nth}-b` })];
  };

  /**
   * A queue long enough that the two findings at its ends are never stacked
   * together, so stepping from one to the other really does take the first off
   * screen. The fillers are minted alongside them and never written into.
   */
  const draftQueue = (): readonly [FindingJson, readonly FindingJson[], FindingJson] => {
    const [written, stepped] = draftPair();
    const nth = String(drafted);
    const fillers = Array.from({ length: STACK_SPAN }, (_unused, index) =>
      makeFinding({ id: `draft-${nth}-fill-${String(index)}` })
    );
    return [written, [written, ...fillers, stepped], stepped];
  };

  it('scopes an unsent draft to the finding it was written on, so a step away gives it back', () => {
    // Keyed the way the card tears the prompt down: moving to another finding
    // closes it, which is the moment the words would otherwise be lost.
    const [written, stepped] = draftPair();
    const { rerender } = renderPane({
      findings: [written, stepped],
      mode: 'focus',
      focus: written.id,
      renderDetail: promptDetail,
    });
    fireEvent.change(screen.getByLabelText(written.id), { target: { value: 'not so' } });

    rerender(stepped.id);
    rerender(written.id);

    expect(screen.getByLabelText(written.id)).toHaveValue('not so');
  });

  /**
   * The stack is bounded, so a finding the reader scrolls far enough past is
   * unmounted rather than merely scrolled off. Its unsent words are the reader's
   * work, and the window sliding is not a decision to throw them away.
   */
  it('gives back a draft on a finding the stack has scrolled off entirely', () => {
    const [written, queue, stepped] = draftQueue();
    const { rerender } = renderPane({
      findings: queue,
      mode: 'focus',
      focus: written.id,
      renderDetail: promptDetail,
    });
    fireEvent.change(screen.getByLabelText(written.id), { target: { value: 'not so' } });

    rerender(stepped.id);
    expect(screen.queryByLabelText(written.id)).not.toBeInTheDocument();

    rerender(written.id);
    expect(screen.getByLabelText(written.id)).toHaveValue('not so');
  });

  /**
   * The card stays, so its unmount cannot be what saves the console — this is
   * the retraction itself, on the path a growing stack reaches most often.
   */
  it('hands the keyboard back when a box holding words is withheld under a card that stays', () => {
    const [written, queue] = draftQueue();
    renderPane({
      findings: queue,
      mode: 'focus',
      focus: written.id,
      renderDetail: (finding) => <WithholdablePrompt key={finding.id} finding={finding} />,
    });
    fireEvent.change(screen.getByLabelText(written.id), { target: { value: 'not so' } });
    expect(renderHook(() => useHotkeysHeld()).result.current).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: `Withhold ${written.id}` }));

    expect(screen.queryByLabelText(written.id)).not.toBeInTheDocument();
    expect(renderHook(() => useHotkeysHeld()).result.current).toBe(false);
  });

  /**
   * A box that leaves the screen still holding words retracts the report the
   * console's whole keyboard hangs off. The stack unmounts boxes constantly, so
   * this is the path the console now spends its time on.
   */
  it('hands the keyboard back when the stack scrolls a box holding words off it', () => {
    const [written, queue, stepped] = draftQueue();
    const { rerender } = renderPane({
      findings: queue,
      mode: 'focus',
      focus: written.id,
      renderDetail: holdingDetail,
    });
    fireEvent.change(screen.getByLabelText(written.id), { target: { value: 'not so' } });
    expect(renderHook(() => useHotkeysHeld()).result.current).toBe(true);

    rerender(stepped.id);

    expect(renderHook(() => useHotkeysHeld()).result.current).toBe(false);
  });

  it('brings a widened queue back in a pass of its own, rather than mounting it under the keystroke that widened it', () => {
    const seen: number[] = [];
    const list = (findings: readonly FindingJson[]): JSX.Element => {
      seen.push(findings.length);
      return <p>queue</p>;
    };
    const pane = widening({ renderList: list });
    const view = render(pane([three[0]!]));

    seen.length = 0;
    view.rerender(pane(three));

    expect([seen[0], seen.at(-1)]).toEqual([1, 3]);
  });

  /**
   * The row list is rendered by the pane itself, so what it holds is only
   * readable from a render-phase seam: `renderLead` runs before the pass it
   * belongs to commits, so the rows it counts are the ones the pass before it
   * left on screen.
   */
  it('mounts the rows a widening brought back in a pass of their own, rather than under the keystroke that widened them', () => {
    const rows: number[] = [];
    const lead = (): null => {
      rows.push(document.querySelectorAll(`[data-testid="${TEST_IDS.findingRow}"]`).length);
      return null;
    };
    const pane = widening({ renderLead: lead });
    const view = render(pane([three[0]!]));

    rows.length = 0;
    view.rerender(pane(three));

    expect([rows[0], rows[1]]).toEqual([1, 1]);
  });

  it('hands a replacing list the finding the reader is on', () => {
    const seen = vi.fn();
    renderPane({
      mode: 'list',
      focus: 'A-2',
      renderList: (findings, focus) => {
        seen(focus);
        return <p>{String(findings.length)} rows</p>;
      },
    });

    expect(seen).toHaveBeenCalledWith('A-2');
  });

  it('tells a replacing list when nothing is selected, rather than leaving it guessing', () => {
    const seen = vi.fn();
    renderPane({
      mode: 'list',
      focus: null,
      renderList: (findings, focus) => {
        seen(focus);
        return <p>{String(findings.length)} rows</p>;
      },
    });

    expect(seen).toHaveBeenCalledWith(null);
  });

  it('keeps an unsent draft off the next finding the reader steps to', () => {
    const [written, stepped] = draftPair();
    const { rerender } = renderPane({
      findings: [written, stepped],
      mode: 'focus',
      focus: written.id,
      renderDetail: promptDetail,
    });
    fireEvent.change(screen.getByLabelText(written.id), { target: { value: 'not so' } });

    rerender(stepped.id);

    expect(screen.getByLabelText(stepped.id)).toHaveValue('');
  });

  it('gives a section rendering its own body the queue the reader asked for, with no pass of lag', () => {
    const seen: number[] = [];
    const board = (findings: readonly FindingJson[]): JSX.Element => {
      seen.push(findings.length);
      return <p>board</p>;
    };
    const pane = widening({ renderBody: board });
    const view = render(pane([three[0]!]));

    seen.length = 0;
    view.rerender(pane(three));

    expect(seen[0]).toBe(3);
  });

  it('gives a section lead the queue the reader asked for, with no pass of lag', () => {
    const seen: number[] = [];
    const lead = (findings: readonly FindingJson[]): JSX.Element => {
      seen.push(findings.length);
      return <p>waiting</p>;
    };
    const pane = widening({ renderLead: lead });
    const view = render(pane([three[0]!]));

    seen.length = 0;
    view.rerender(pane(three));

    expect(seen[0]).toBe(3);
  });

  /**
   * The queue counter is rendered inside the pane, so a test can only read the
   * value the pane settled on. `renderDetail` runs during the pane's render,
   * which is before that pass commits, so what it reads out of the document is
   * the counter the pass before it left there — the only way a value that is
   * wrong for a single pass is visible from outside.
   *
   * The stand-in detail closes with punctuation because the counter sits
   * directly after it in the document's text: an id ending in a digit would
   * otherwise run into the counter's first number and be read as part of it.
   */
  function counterRecorder(part: 'place' | 'total'): {
    seen: string[];
    renderDetail: (finding: FindingJson) => JSX.Element;
  } {
    const seen: string[] = [];
    return {
      seen,
      renderDetail: (finding: FindingJson): JSX.Element => {
        const counter = /(\d+) of (\d+)/u.exec(document.body.textContent);
        seen.push(counter?.[part === 'place' ? 1 : 2] ?? '');
        return <p>ruling {finding.id}. </p>;
      },
    };
  }

  /** Widens a focus-mode pane from the head of the queue to the whole of it. */
  function widenInFocus(renderDetail: (finding: FindingJson) => JSX.Element): () => void {
    const pane = (findings: readonly FindingJson[]): JSX.Element => (
      <SectionPane
        section={sectionSpec('open')}
        findings={findings}
        focus="A-3"
        onOpen={vi.fn()}
        mode="focus"
        filtering={false}
        onClearFilters={(): void => {}}
        renderDetail={renderDetail}
      />
    );
    const view = render(pane([three[0]!]));
    return (): void => {
      view.rerender(pane(three));
    };
  }

  it('shows the reader’s place in the queue they asked for, while the row list is still a pass behind', () => {
    const { seen: places, renderDetail } = counterRecorder('place');
    const widen = widenInFocus(renderDetail);

    places.length = 0;
    widen();

    // First and last rather than first and second: the pane stacks the queue,
    // so each pass calls the recorder once per card on screen.
    expect([places[0], places.at(-1)]).toEqual(['1', '3']);
  });

  it('shows the size of the queue they asked for, while the row list is still a pass behind', () => {
    const { seen: totals, renderDetail } = counterRecorder('total');
    const widen = widenInFocus(renderDetail);

    totals.length = 0;
    widen();

    expect([totals[0], totals.at(-1)]).toEqual(['1', '3']);
  });

  describe('keeping the reader in view', () => {
    const PANE_HEIGHT = 200;
    const ROW_TOP = 500;
    const ROW_STRIDE = 100;

    /**
     * Layout the pane can be measured against: happy-dom reports every box at
     * the origin, so the pane and the boxes inside it are given the offsets a
     * browser would have produced. A stride separates siblings, which is the
     * only thing that tells a scroll aimed at one row from one aimed at another.
     */
    function scrollingPane(stride = 0): HTMLElement {
      const scroller = document.createElement('div');
      scroller.style.overflowY = 'auto';
      document.body.append(scroller);
      Object.defineProperty(scroller, 'clientHeight', { value: PANE_HEIGHT, configurable: true });
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element
      ): DOMRect {
        if (this === scroller) return { top: 0 } as DOMRect;
        const among = [...(this.parentElement?.children ?? [])].indexOf(this);
        return { top: ROW_TOP + stride * among } as DOMRect;
      });
      return scroller;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('opens a focused finding at its own header rather than where the last one was left', () => {
      const scroller = scrollingPane();
      const { rerender } = renderPane({ mode: 'focus', focus: 'A-1', container: scroller });
      scroller.scrollTop = 0;

      rerender('A-2');

      expect(scroller.scrollTop).toBe(ROW_TOP);
    });

    /**
     * The reader's own scrolling moves which finding they are on, and the
     * scroller answers a move by scrolling to it. Answering this one would put
     * the console and the reader's hand on the same scrollbar, each moving it
     * because the other did.
     */
    it('does not scroll after a move the reader made by scrolling', () => {
      const stub = stubIntersectionObserver();
      const scroller = scrollingPane();
      const seen: string[] = [];
      const { rerender } = renderPane({
        mode: 'focus',
        focus: 'A-1',
        container: scroller,
        onSee: (id) => seen.push(id),
      });
      scroller.scrollTop = 0;

      const second = scroller.querySelector('[data-finding="A-2"]');
      if (second !== null) stub.show([second]);
      rerender('A-2');

      expect(seen).toEqual(['A-2']);
      expect(scroller.scrollTop).toBe(0);
      stub.restore();
    });

    it('leaves the header and the rail where they are, whatever it has to scroll', () => {
      const scroller = scrollingPane();
      const { rerender } = renderPane({ mode: 'focus', focus: 'A-1', container: scroller });

      rerender('A-2');

      expect(document.documentElement.scrollTop).toBe(0);
    });

    it('brings the selected row back into view in list mode', () => {
      const scroller = scrollingPane();

      renderPane({ mode: 'list', focus: 'A-3', container: scroller });

      expect(scroller.scrollTop).toBe(ROW_TOP - PANE_HEIGHT);
    });

    it('brings the row back into view when the section changes under the same selection', () => {
      const scroller = scrollingPane();
      const { rerenderSection } = renderPane({ mode: 'list', focus: 'A-3', container: scroller });
      scroller.scrollTop = 0;

      rerenderSection('questions', 'A-3');

      expect(scroller.scrollTop).toBe(ROW_TOP - PANE_HEIGHT);
    });

    it('scrolls nothing in a list with no selection', () => {
      const scroller = scrollingPane();

      renderPane({ mode: 'list', focus: null, container: scroller });

      expect(scroller.scrollTop).toBe(0);
    });

    it('aims the scroll at the row the reader is on, not at the last row in the queue', () => {
      const scroller = scrollingPane(ROW_STRIDE);

      renderPane({ mode: 'list', focus: 'A-2', container: scroller });

      expect(scroller.scrollTop).toBe(ROW_TOP + ROW_STRIDE - PANE_HEIGHT);
    });

    it('lands the reader on a row the deferred queue only mounts a pass late', () => {
      const scroller = scrollingPane();
      const pane = (findings: readonly FindingJson[]): JSX.Element => (
        <SectionPane
          section={sectionSpec('open')}
          findings={findings}
          focus="A-3"
          onOpen={vi.fn()}
          mode="list"
          filtering={false}
          onClearFilters={(): void => {}}
        />
      );
      const view = render(pane([three[0]!]), { container: scroller });
      scroller.scrollTop = 0;

      view.rerender(pane(three));

      expect(scroller.scrollTop).toBe(ROW_TOP - PANE_HEIGHT);
    });

    it('brings the card to the top when the reader switches to it from the list', () => {
      const scroller = scrollingPane();
      const pane = (mode: SectionPaneProps['mode']): JSX.Element => (
        <SectionPane
          section={sectionSpec('open')}
          findings={three}
          focus="A-2"
          onOpen={vi.fn()}
          mode={mode}
          filtering={false}
          onClearFilters={(): void => {}}
        />
      );
      const view = render(pane('list'), { container: scroller });
      scroller.scrollTop = 0;

      view.rerender(pane('focus'));

      expect(scroller.scrollTop).toBe(ROW_TOP);
    });
  });
});
