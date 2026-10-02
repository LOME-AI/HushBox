import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { makeFinding, makeQuestion } from '@/test-utils/finding-fixture';
import { withAuditAddress } from '@/test-utils/audit-address';
import { usePublishedBindings } from '@/components/published-bindings';
import { useHotkeysHeld } from '@/components/hotkey-hold';
import { TEST_IDS } from '@/test-ids';
import { PromptDraftScope } from './prompt-form';
import { FindingCard } from './finding-card';
import { createWriteStore } from './hooks/use-ruling-actions';
import type { FindingCardProps } from './finding-card';
import type { FindingJson, RenderedOption } from '@hushbox/docket';
import type { JSX } from 'react';

function jsonResponse(status: number, body: unknown): Response {
  return Response.json(body, { status });
}

/** A fresh Response per call: a body may be read only once, and a retry re-reads. */
function responds(status: number, body: unknown): () => Promise<Response> {
  return () => Promise.resolve(jsonResponse(status, body));
}

function option(overrides: Partial<RenderedOption> = {}): RenderedOption {
  return {
    id: 'A',
    label: 'Apply it',
    recommended: false,
    dedicated: false,
    meta: null,
    html: '',
    ...overrides,
  };
}

const queue: readonly FindingJson[] = [
  makeFinding({ id: 'AI-1', title: 'the pool is torn down early', state: 'open' }),
  makeFinding({ id: 'AI-2', state: 'open' }),
  makeFinding({ id: 'AI-3', state: 'open' }),
];
const [first, second] = queue as [FindingJson, FindingJson];

function renderCard(overrides: Partial<FindingCardProps> = {}): {
  put: ReturnType<typeof vi.fn>;
  onFocus: ReturnType<typeof vi.fn>;
  onJump: ReturnType<typeof vi.fn>;
  onLand: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
  rerenderWith: (next: Partial<FindingCardProps>) => void;
  unmount: () => void;
} {
  const put = vi.fn();
  const onFocus = vi.fn();
  const onJump = vi.fn();
  const onLand = vi.fn();
  const notify = vi.fn();
  const fetchMock = vi
    .fn()
    .mockImplementation(
      responds(200, { finding: makeFinding({ id: 'AI-1', state: 'ruled' }), undoToken: 't1' })
    );
  const props: FindingCardProps = {
    finding: first,
    findings: queue,
    queue,
    active: true,
    sectionState: 'open',
    put,
    onFocus,
    onJump,
    onLand,
    notify,
    // One per card unless a test hands its own over: what a write leaves behind
    // outlives the mount, so a shared one would carry into the next test.
    writeStore: createWriteStore(),
    api: { fetch: fetchMock as unknown as typeof globalThis.fetch, wait: () => Promise.resolve() },
    ...overrides,
  };
  const { rerender, unmount } = render(<FindingCard {...props} />, { wrapper: withAuditAddress });
  return {
    put,
    onFocus,
    onJump,
    onLand,
    notify,
    fetchMock,
    unmount,
    rerenderWith: (next) => {
      rerender(<FindingCard {...props} {...next} />);
    },
  };
}

/** Runs an interaction and lets the write it starts settle inside act. */
async function settled(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}

/** Lets a write that was deliberately observed mid-flight finish inside act. */
async function settle(): Promise<void> {
  await settled(() => {});
}

function press(key: string, init: KeyboardEventInit = {}): void {
  fireEvent.keyDown(document.body, { key, ...init });
}

/** Puts words in one of the card's boxes, which are all on screen at once. */
function write(label: string, text: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value: text } });
}

describe('FindingCard', () => {
  it('renders the finding it is ruling', () => {
    renderCard();

    expect(screen.getByTestId(TEST_IDS.findingCard)).toBeInTheDocument();
    expect(screen.getByText('the pool is torn down early')).toBeInTheDocument();
  });

  /**
   * The reader reads and acts at the same time, so the finding runs down one
   * half and everything that acts on it down the other. Nothing here lays
   * anything out, so what is reachable is that the two halves exist and that
   * their contents are in different ones.
   */
  it('reads the finding down one column and acts on it down the other', () => {
    renderCard({
      finding: makeFinding({
        id: 'AI-1',
        bodyHtml: '<p>the pool closes in a finally</p>',
        options: [option()],
      }),
    });

    const reading = screen
      .getByText('the pool closes in a finally')
      .closest('[data-slot^="finding-"]');
    const acting = screen
      .getByLabelText('Rule in your own words')
      .closest('[data-slot^="finding-"]');

    expect(reading).toHaveAttribute('data-slot', 'finding-reading');
    expect(acting).toHaveAttribute('data-slot', 'finding-deciding');
  });

  it('splits the two halves evenly, and caps the card at no width at all', () => {
    renderCard();

    const card = screen.getByTestId(TEST_IDS.findingCard);
    expect(card.querySelector('[data-slot="finding-reading"]')?.parentElement?.className).toContain(
      'lg:grid-cols-2'
    );
    for (let node: HTMLElement | null = card; node !== null; node = node.parentElement) {
      expect(node.className).not.toContain('max-w-');
    }
  });

  /**
   * Every way of putting words on a finding is on screen at once. A field the
   * reader has to uncover is a field they can rule the whole audit without
   * ever finding.
   */
  it('carries every field a decision is written in, with nothing clicked to reveal them', () => {
    renderCard({ finding: makeFinding({ id: 'AI-1', options: [option()] }) });

    expect(screen.getByLabelText('Rule in your own words')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason for denying')).toBeInTheDocument();
    expect(screen.getByLabelText('Ask the implementation agent')).toBeInTheDocument();
    expect(screen.getByLabelText('Note on A')).toBeInTheDocument();
  });

  it('sends the caret to the ruling box rather than uncovering one', () => {
    renderCard();

    press('r');

    expect(screen.getByLabelText('Rule in your own words')).toHaveFocus();
  });

  it('sends the caret to the denial box', () => {
    renderCard();

    press('d');

    expect(screen.getByLabelText('Reason for denying')).toHaveFocus();
  });

  it('sends the caret to the question box', () => {
    renderCard();

    press('q');

    expect(screen.getByLabelText('Ask the implementation agent')).toHaveFocus();
  });

  it('sends the caret back a second time, so a shortcut never goes inert', () => {
    renderCard();

    press('r');
    screen.getByLabelText('Rule in your own words').blur();
    press('r');

    expect(screen.getByLabelText('Rule in your own words')).toHaveFocus();
  });

  it('flags a finding the audit marked a warning', () => {
    renderCard({ finding: makeFinding({ id: 'AI-1', warning: true }) });

    expect(screen.getByText(/read this one before ruling/)).toBeInTheDocument();
  });

  it('says nothing about warnings on an ordinary finding', () => {
    renderCard();

    expect(screen.queryByText(/read this one before ruling/)).toBeNull();
  });

  it('names each group partner and the state it is in', () => {
    renderCard({
      finding: makeFinding({ id: 'AI-1', group: 'AI-1 + AI-2' }),
      findings: [first, makeFinding({ id: 'AI-2', state: 'denied' })],
    });

    const chip = screen.getByTestId(TEST_IDS.findingChip);
    expect(chip).toHaveTextContent('AI-2');
    expect(chip).toHaveTextContent('denied');
  });

  it('jumps to a related finding', () => {
    const { onJump } = renderCard({ finding: makeFinding({ id: 'AI-1', related: ['AI-3'] }) });

    fireEvent.click(screen.getByTestId(TEST_IDS.findingChip));

    expect(onJump).toHaveBeenCalledWith('AI-3');
  });

  it('renders the explainer the audit wrote', () => {
    renderCard({
      finding: makeFinding({ id: 'AI-1', bodyHtml: '<p>the pool closes in a finally</p>' }),
    });

    expect(screen.getByText('the pool closes in a finally')).toBeInTheDocument();
  });

  it('writes the option the reader chose', async () => {
    const { fetchMock } = renderCard({
      finding: makeFinding({ id: 'AI-1', options: [option()] }),
    });

    await settled(() => {
      fireEvent.click(screen.getByTestId(TEST_IDS.optionChoice));
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/audits/2026-07-30/finding/AI-1/rule');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ option: 'A', base: 'hash' }),
    });
  });

  it('moves the finding out of the section and advances', async () => {
    const { put, onFocus } = renderCard({
      finding: makeFinding({ id: 'AI-1', options: [option()] }),
    });

    fireEvent.click(screen.getByTestId(TEST_IDS.optionChoice));

    expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: 'AI-1', state: 'ruled' }));
    expect(onFocus).toHaveBeenCalledWith('AI-2');
    await settle();
  });

  it('offers the way back once the write lands', async () => {
    const { notify } = renderCard({ finding: makeFinding({ id: 'AI-1', options: [option()] }) });

    await settled(() => {
      fireEvent.click(screen.getByTestId(TEST_IDS.optionChoice));
    });

    expect(notify).toHaveBeenCalledWith('Ruled AI-1 as A', expect.any(Function));
  });

  it('rules with free text', async () => {
    const { fetchMock } = renderCard();

    write('Rule in your own words', 'do the third thing');
    await settled(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Rule' }));
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ option: 'other', text: 'do the third thing', base: 'hash' }),
    });
  });

  it('denies with a reason', async () => {
    const { fetchMock } = renderCard();

    write('Reason for denying', 'the audit misread it');
    await settled(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny with this reason' }));
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/audits/2026-07-30/finding/AI-1/deny');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ reason: 'the audit misread it', base: 'hash' }),
    });
  });

  it('denies without a reason', async () => {
    const { fetchMock } = renderCard();

    await settled(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny without a reason' }));
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify({ base: 'hash' }) });
  });

  it('asks a question', async () => {
    const { fetchMock } = renderCard();

    write('Ask the implementation agent', 'which pool?');
    await settled(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Ask the agent' }));
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/audits/2026-07-30/finding/AI-1/ask');
  });

  it('never dead-ends a finding with no options', () => {
    renderCard();

    expect(screen.getByText('No options were minted for this finding')).toBeInTheDocument();
    expect(screen.getByLabelText('Rule in your own words')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason for denying')).toBeInTheDocument();
    expect(screen.getByLabelText('Ask the implementation agent')).toBeInTheDocument();
  });

  it('shows a refused write and leaves the finding as it was', async () => {
    const { put } = renderCard({
      finding: makeFinding({ id: 'AI-1', options: [option()] }),
      api: {
        fetch: vi
          .fn()
          .mockImplementation(
            responds(409, { error: { code: 'conflict', message: 'ruling changed since read' } })
          ) as unknown as typeof globalThis.fetch,
        wait: () => Promise.resolve(),
      },
    });

    await settled(() => {
      fireEvent.click(screen.getByTestId(TEST_IDS.optionChoice));
    });

    expect(screen.getByTestId(TEST_IDS.writeError)).toHaveTextContent('ruling changed since read');
    expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'AI-1', state: 'open' }));
  });

  it('reports a refusal that landed while the pane had no card to report it on', async () => {
    const writeStore = createWriteStore();
    const refused = vi
      .fn()
      .mockImplementation(responds(500, { error: { message: 'the console did not finish' } }));
    const { unmount } = renderCard({
      writeStore,
      queue: [first],
      api: { fetch: refused as unknown as typeof globalThis.fetch, wait: () => Promise.resolve() },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Deny without a reason' }));
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    renderCard({ writeStore, queue: [first] });

    expect(screen.getByTestId(TEST_IDS.writeError)).toHaveTextContent('the console did not finish');
  });

  it('says which finding a write is still waiting on another writer for', async () => {
    let release = (): void => undefined;
    const held = vi
      .fn()
      .mockImplementationOnce(
        responds(503, { error: { code: 'locked', message: 'held', retryable: true } })
      )
      .mockImplementation(responds(200, { finding: first, undoToken: 't1' }));

    renderCard({
      api: {
        fetch: held as unknown as typeof globalThis.fetch,
        wait: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      },
    });

    await settled(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Deny without a reason' }));
    });

    expect(screen.getByRole('status')).toHaveTextContent('AI-1');
    await settled(() => {
      release();
    });
  });

  it('undoes the last write from the card', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        responds(200, { finding: makeFinding({ id: 'AI-1', state: 'ruled' }), undoToken: 't1' })
      )
      .mockImplementationOnce(responds(200, { finding: first, undoToken: 't2' }));
    renderCard({
      finding: makeFinding({ id: 'AI-1', options: [option()] }),
      api: {
        fetch: fetchMock as unknown as typeof globalThis.fetch,
        wait: () => Promise.resolve(),
      },
    });

    await settled(() => {
      fireEvent.click(screen.getByTestId(TEST_IDS.optionChoice));
    });
    await settled(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    });

    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/undo');
  });

  it('offers no undo before the first write', () => {
    renderCard();

    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
  });

  it('takes nothing back from the undo key before the first write', async () => {
    const { fetchMock } = renderCard();

    await settled(() => {
      press('u');
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('takes the last write back from the undo key', async () => {
    const { fetchMock } = renderCard({ finding: makeFinding({ id: 'AI-1', options: [option()] }) });

    await settled(() => {
      fireEvent.click(screen.getByTestId(TEST_IDS.optionChoice));
    });
    await settled(() => {
      press('u');
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/undo', expect.anything());
  });

  it('rules with an option and a note on how to carry it out', async () => {
    const { fetchMock } = renderCard({
      finding: makeFinding({ id: 'AI-1', options: [option({ recommended: true })] }),
    });

    write('Note on A', 'behind the flag first');
    await settled(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Rule with note' }));
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ option: 'A', note: 'behind the flag first', base: 'hash' }),
    });
  });

  it('throws the words in a box away without leaving the finding', () => {
    renderCard();

    write('Rule in your own words', 'do the third thing');
    fireEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0]!);

    expect(screen.getByLabelText('Rule in your own words')).toHaveValue('');
  });

  it('offers no denial on a finding already denied', () => {
    renderCard({ finding: makeFinding({ id: 'AI-1', state: 'denied' }) });

    expect(screen.queryByLabelText('Reason for denying')).toBeNull();
  });

  /**
   * The queue is a stack, so the cards above and below the reader's are mounted
   * with it. They are read, not acted on: every decision key is registered on
   * the window, so a card that answered while the reader was elsewhere would
   * rule a finding they are not looking at.
   */
  describe('a card the reader is not on', () => {
    it('rules on no keystroke aimed at the card the reader is on', () => {
      const { put, fetchMock } = renderCard({
        active: false,
        finding: makeFinding({ id: 'AI-1', options: [option()] }),
      });

      press('1');
      press('r');
      press('d');

      expect(put).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('offers the legend none of its keys, so the reader reads one card’s', () => {
      renderCard({ active: false, finding: makeFinding({ id: 'AI-1', options: [option()] }) });

      const { result } = renderHook(() => usePublishedBindings());

      expect(result.current).toEqual([]);
    });

    /**
     * A card scrolled past keeps the words typed into it — that is the point of
     * keeping the draft — but the hold it would take is the console's whole
     * keyboard, `j` and `k` with it. Taking it from off-screen strands the
     * reader exactly the way an unmounted box used to.
     */
    it('holds none of the console’s keyboard for words left on it', () => {
      renderCard({ active: false, finding: makeFinding({ id: 'AI-1', options: [option()] }) });

      write('Rule in your own words', 'the audit misread it');

      const { result } = renderHook(() => useHotkeysHeld());

      expect(result.current).toBe(false);
    });

    it('is not marked as the one the keyboard is aimed at', () => {
      renderCard({ active: false });

      expect(screen.getByTestId(TEST_IDS.findingCard)).not.toHaveAttribute('aria-current');
    });

    /**
     * The writes a card reports are the shared store's, so every card mounted
     * would speak the same sentence: one live region announcing a held file
     * becomes as many as the reader has scrolled past. The card says what is
     * happening to its own finding, the way its failures already do.
     *
     * The write is started on the card the reader has **left**, which is the
     * whole point of scoping it by finding rather than by which card the reader
     * is on: the notice belongs where the reader will find it if they scroll
     * back. Putting the write on the active card would let a fix that reports
     * only from the active card pass this.
     */
    it('reports a held write on the card the reader has scrolled past', async () => {
      const writeStore = createWriteStore();
      let release = (): void => undefined;
      const held = vi
        .fn()
        .mockImplementationOnce(
          responds(503, { error: { code: 'locked', message: 'held', retryable: true } })
        )
        .mockImplementation(
          responds(200, { finding: makeFinding({ id: 'AI-1', state: 'ruled' }), undoToken: 't1' })
        );
      const api = {
        fetch: held as unknown as typeof globalThis.fetch,
        wait: () => new Promise<void>((resolve) => (release = resolve)),
      };
      const shared = { writeStore, api, findings: queue, queue, sectionState: 'open' } as const;
      render(
        <>
          <PromptDraftScope finding={first.id}>
            <FindingCard
              {...shared}
              finding={first}
              active={false}
              put={vi.fn()}
              onFocus={vi.fn()}
              onJump={vi.fn()}
              onLand={vi.fn()}
              notify={vi.fn()}
            />
          </PromptDraftScope>
          <PromptDraftScope finding={second.id}>
            <FindingCard
              {...shared}
              finding={second}
              active
              put={vi.fn()}
              onFocus={vi.fn()}
              onJump={vi.fn()}
              onLand={vi.fn()}
              notify={vi.fn()}
            />
          </PromptDraftScope>
        </>,
        { wrapper: withAuditAddress }
      );
      const [left, on] = screen.getAllByTestId(TEST_IDS.findingCard) as [HTMLElement, HTMLElement];

      await settled(() => {
        fireEvent.click(within(left).getByRole('button', { name: 'Deny without a reason' }));
      });

      // On the card it belongs to: not silenced because the reader moved on,
      // and not repeated by the card they moved to.
      expect(within(left).getByText(/Still saving/u)).toBeInTheDocument();
      expect(within(on).queryByText(/Still saving/u)).not.toBeInTheDocument();
      expect(screen.getAllByText(/Still saving/u)).toHaveLength(1);
      await settled(release);
    });
  });

  it('marks the card the keyboard is aimed at, so a stack says which answers', () => {
    renderCard();

    expect(screen.getByTestId(TEST_IDS.findingCard)).toHaveAttribute('aria-current', 'true');
  });

  describe('keyboard', () => {
    it('rules with the option a digit stands for', async () => {
      const { put } = renderCard({ finding: makeFinding({ id: 'AI-1', options: [option()] }) });

      press('1');

      expect(put).toHaveBeenCalledWith(expect.objectContaining({ state: 'ruled' }));
      await settle();
    });

    it('reaches the free-text ruling box on a finding whose options were never minted', () => {
      renderCard({ finding: makeFinding({ id: 'AI-1', options: [], needsOptions: true }) });

      press('r');

      expect(screen.getByLabelText('Rule in your own words')).toHaveFocus();
    });

    it('offers undo before any write, so the way back is known before it is needed', () => {
      renderCard();

      const { result } = renderHook(() => usePublishedBindings());

      expect(result.current.map((binding) => binding.combo)).toContain('u');
    });

    it('reaches the ask box', () => {
      renderCard();

      press('q');

      expect(screen.getByRole('button', { name: 'Ask the agent' })).toBeInTheDocument();
    });

    it('takes no keyboard hold from a key the card offers no control for', () => {
      renderCard({ finding: makeFinding({ id: 'AI-1', state: 'denied' }), sectionState: 'denied' });

      press('d');

      const { result } = renderHook(() => useHotkeysHeld());

      expect(result.current).toBe(false);
    });

    it('offers the question key on a ruled finding, which a question does not undecide', () => {
      renderCard({ finding: makeFinding({ id: 'AI-1', state: 'ruled' }), sectionState: 'ruled' });

      const { result } = renderHook(() => usePublishedBindings());

      expect(result.current.map((binding) => binding.combo)).toContain('q');
    });

    it('offers no deny key on a finding already denied', () => {
      renderCard({ finding: makeFinding({ id: 'AI-1', state: 'denied' }), sectionState: 'denied' });

      const { result } = renderHook(() => usePublishedBindings());

      expect(result.current.map((binding) => binding.combo)).not.toContain('d');
    });

    it('opens a note on the recommended option', () => {
      renderCard({
        finding: makeFinding({
          id: 'AI-1',
          options: [option(), option({ id: 'B', recommended: true })],
        }),
      });

      press('n');

      expect(screen.getByLabelText('Note on B')).toHaveFocus();
    });

    /**
     * Nothing on the card closes any more, so escape is what shows the reader
     * which box is holding the console's keyboard. Its own escape empties it,
     * which is the second half of the way out.
     */
    it('hands the reader back to the box that is holding the keyboard', () => {
      renderCard();

      write('Reason for denying', 'the audit misread it');
      screen.getByLabelText('Reason for denying').blur();
      press('Escape');

      expect(screen.getByLabelText('Reason for denying')).toHaveFocus();
    });

    it('moves the caret nowhere on escape while no box is holding anything', () => {
      renderCard();

      press('Escape');

      expect(screen.getByLabelText('Reason for denying')).not.toHaveFocus();
      expect(screen.getByLabelText('Rule in your own words')).not.toHaveFocus();
    });

    it('writes nothing from a key pressed over words nobody has sent', () => {
      const { fetchMock } = renderCard({
        finding: makeFinding({ id: 'AI-1', options: [option()] }),
      });

      write('Reason for denying', 'the audit misread it');
      screen.getByLabelText('Reason for denying').blur();
      press('1');

      expect(fetchMock).not.toHaveBeenCalled();
    });

    /**
     * The stranding this hold can produce. Denying without a reason withholds the
     * denial box on the very finding it denies, and a finding the queue has
     * nowhere to move on from stays on screen. The words leave with the box, so
     * the hold they raised has to leave with them: otherwise every shortcut the
     * console has is dead with nothing on screen holding anything, and Escape
     * points the caret at a field that is no longer rendered.
     */
    it('hands the keyboard back when the box holding the words leaves the screen', () => {
      const { rerenderWith } = renderCard({
        finding: makeFinding({ id: 'AI-1', options: [option()] }),
      });

      write('Reason for denying', 'the audit misread it');
      rerenderWith({
        finding: makeFinding({ id: 'AI-1', state: 'denied', options: [option()] }),
        sectionState: 'denied',
      });

      const { result } = renderHook(() => useHotkeysHeld());

      expect(result.current).toBe(false);
    });

    /**
     * The denial box is not a special case. Every box on the card is the same
     * field, and an option's note box goes the same way when the option it
     * belongs to does, so the keyboard has to come back from that one too.
     */
    it('hands the keyboard back from a note whose option leaves the screen', () => {
      const { rerenderWith } = renderCard({
        finding: makeFinding({ id: 'AI-1', options: [option()] }),
      });

      write('Note on A', 'do it in the adapter');
      rerenderWith({ finding: makeFinding({ id: 'AI-1', options: [] }) });

      const { result } = renderHook(() => useHotkeysHeld());

      expect(result.current).toBe(false);
    });

    it('writes from a key pressed over boxes nobody has written in', () => {
      const { fetchMock } = renderCard({
        finding: makeFinding({ id: 'AI-1', options: [option()] }),
      });

      press('1');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('changing a ruling that has been worked on', () => {
    const worked = makeFinding({
      id: 'AI-1',
      state: 'ruled',
      options: [option(), option({ id: 'B', label: 'The second way' })],
      ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
      progress: {
        status: 'in-progress',
        updated: null,
        verified: false,
        notes: [
          { at: '2026-07-30', by: 'agent', text: 'started' },
          { at: '2026-07-30', by: 'agent', text: 'blocked on the migration' },
        ],
      },
    });

    it('writes nothing when an option is chosen', async () => {
      const { fetchMock } = renderCard({ finding: worked, sectionState: 'ruled' });

      await settled(() => {
        fireEvent.click(screen.getAllByTestId(TEST_IDS.optionChoice)[1]!);
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('names how many notes the ruling would discard', () => {
      renderCard({ finding: worked, sectionState: 'ruled' });

      fireEvent.click(screen.getAllByTestId(TEST_IDS.optionChoice)[1]!);

      expect(
        screen.getByText('It is marked In progress, with 2 progress notes.')
      ).toBeInTheDocument();
    });

    it('re-rules once the reader accepts', async () => {
      const { fetchMock } = renderCard({ finding: worked, sectionState: 'ruled' });

      fireEvent.click(screen.getAllByTestId(TEST_IDS.optionChoice)[1]!);
      await settled(() => {
        fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));
      });

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/audits/2026-07-30/finding/AI-1/rule',
        expect.objectContaining({ body: JSON.stringify({ option: 'B', base: 'hash' }) })
      );
    });

    it('leaves the ruling alone when the reader backs out', async () => {
      const { fetchMock } = renderCard({ finding: worked, sectionState: 'ruled' });

      fireEvent.click(screen.getAllByTestId(TEST_IDS.optionChoice)[1]!);
      await settled(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('warns on a free-text ruling too', () => {
      renderCard({ finding: worked, sectionState: 'ruled' });

      write('Rule in your own words', 'do it the third way');
      fireEvent.click(screen.getByRole('button', { name: 'Rule' }));

      expect(screen.getByTestId(TEST_IDS.confirmAccept)).toBeInTheDocument();
    });

    it('warns on a ruling carrying a note too', () => {
      renderCard({ finding: worked, sectionState: 'ruled' });

      write('Note on A', 'and log it');
      fireEvent.click(screen.getAllByRole('button', { name: 'Rule with note' })[0]!);

      expect(screen.getByTestId(TEST_IDS.confirmAccept)).toBeInTheDocument();
    });

    it('warns before a digit re-rules it', () => {
      renderCard({ finding: worked, sectionState: 'ruled' });

      fireEvent.keyDown(document, { key: '2' });

      expect(screen.getByTestId(TEST_IDS.confirmAccept)).toBeInTheDocument();
    });

    it('warns before re-ruling a decided finding nobody has worked on', async () => {
      const untouched = makeFinding({
        id: 'AI-1',
        state: 'ruled',
        options: [option(), option({ id: 'B', label: 'The second way' })],
        ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
      });
      const { fetchMock } = renderCard({ finding: untouched, sectionState: 'ruled' });

      await settled(() => {
        fireEvent.click(screen.getAllByTestId(TEST_IDS.optionChoice)[1]!);
      });

      expect(screen.getByTestId(TEST_IDS.confirmAccept)).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('warns before denying a finding that is already ruled', async () => {
      const untouched = makeFinding({
        id: 'AI-1',
        state: 'ruled',
        ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
      });
      const { fetchMock } = renderCard({ finding: untouched, sectionState: 'ruled' });

      press('d');
      await settled(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Deny without a reason' }));
      });

      expect(screen.getByTestId(TEST_IDS.confirmAccept)).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('says only that the decision is archived where there is no work to lose', () => {
      const untouched = makeFinding({
        id: 'AI-1',
        state: 'ruled',
        options: [option(), option({ id: 'B', label: 'The second way' })],
        ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
      });
      renderCard({ finding: untouched, sectionState: 'ruled' });

      fireEvent.click(screen.getAllByTestId(TEST_IDS.optionChoice)[1]!);

      expect(screen.queryByText(/progress note/)).toBeNull();
      expect(
        screen.getByText(
          "The decision it carries now is archived into the finding's history, not lost."
        )
      ).toBeInTheDocument();
    });

    const openWithWork = makeFinding({
      id: 'AI-1',
      state: 'open',
      options: [option()],
      progress: {
        status: 'in-progress',
        updated: null,
        verified: false,
        notes: [{ at: '2026-07-30', by: 'agent', text: 'started' }],
      },
    });

    const openWithNotesOnly = makeFinding({
      id: 'AI-1',
      state: 'open',
      options: [option()],
      progress: {
        status: 'not-started',
        updated: null,
        verified: false,
        notes: [{ at: '2026-07-30', by: 'agent', text: 'started' }],
      },
    });

    it('rules straight through where the only work recorded is notes a decision keeps', async () => {
      const { fetchMock } = renderCard({ finding: openWithNotesOnly });

      await settled(() => {
        fireEvent.click(screen.getAllByTestId(TEST_IDS.optionChoice)[0]!);
      });

      expect(screen.queryByTestId(TEST_IDS.confirmAccept)).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/audits/2026-07-30/finding/AI-1/rule',
        expect.objectContaining({ body: JSON.stringify({ option: 'A', base: 'hash' }) })
      );
    });

    it('asks before a first ruling discards work recorded on an undecided finding', async () => {
      const { fetchMock } = renderCard({ finding: openWithWork });

      await settled(() => {
        fireEvent.click(screen.getAllByTestId(TEST_IDS.optionChoice)[0]!);
      });

      expect(
        screen.getByText('It is marked In progress, with 1 progress note.')
      ).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('rules the undecided finding once the reader accepts losing that work', async () => {
      const { fetchMock } = renderCard({ finding: openWithWork });

      fireEvent.click(screen.getAllByTestId(TEST_IDS.optionChoice)[0]!);
      await settled(() => {
        fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));
      });

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/audits/2026-07-30/finding/AI-1/rule',
        expect.objectContaining({ body: JSON.stringify({ option: 'A', base: 'hash' }) })
      );
    });

    it('writes nothing when it is denied instead, which discards the ruling the same way', async () => {
      const { fetchMock } = renderCard({ finding: worked, sectionState: 'ruled' });

      await settled(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Deny without a reason' }));
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(screen.getByTestId(TEST_IDS.confirmAccept)).toBeInTheDocument();
    });

    it('denies once the reader accepts, carrying the reason they gave', async () => {
      const { fetchMock } = renderCard({ finding: worked, sectionState: 'ruled' });

      write('Reason for denying', 'not worth the seam');
      fireEvent.click(screen.getByRole('button', { name: 'Deny with this reason' }));
      await settled(() => {
        fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));
      });

      expect(fetchMock).toHaveBeenCalledWith(
        '/api/audits/2026-07-30/finding/AI-1/deny',
        expect.objectContaining({
          body: JSON.stringify({ reason: 'not worth the seam', base: 'hash' }),
        })
      );
    });

    it('asks before a first denial discards work recorded on an undecided finding', async () => {
      const { fetchMock } = renderCard({ finding: openWithWork });

      await settled(() => {
        fireEvent.click(screen.getByRole('button', { name: 'Deny without a reason' }));
      });

      expect(screen.getByTestId(TEST_IDS.confirmAccept)).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  it('never carries the words written on one finding onto the next', () => {
    const { rerenderWith } = renderCard();

    write('Reason for denying', 'the audit misread it');
    rerenderWith({ finding: second });

    expect(screen.getByLabelText('Reason for denying')).toHaveValue('');
  });

  /**
   * The write is optimistic, so a refusal can land on a card the reader left
   * long ago and take them back to it, in the middle of whatever they were
   * writing on the finding they had moved on to.
   */
  it('gives back the words a late refusal took the reader away from', async () => {
    const refused = vi.fn().mockImplementation(responds(500, { error: { message: 'disk gone' } }));
    const scoped = (finding: FindingJson): JSX.Element => (
      <PromptDraftScope finding={finding.id}>
        <FindingCard
          finding={finding}
          findings={queue}
          queue={queue}
          active
          sectionState="open"
          put={vi.fn()}
          onFocus={vi.fn()}
          onJump={vi.fn()}
          onLand={vi.fn()}
          notify={vi.fn()}
          writeStore={createWriteStore()}
          api={{
            fetch: refused as unknown as typeof globalThis.fetch,
            wait: () => Promise.resolve(),
          }}
        />
      </PromptDraftScope>
    );
    const { rerender } = render(scoped(first), { wrapper: withAuditAddress });

    fireEvent.click(screen.getByRole('button', { name: 'Deny without a reason' }));
    rerender(scoped(second));
    write('Reason for denying', 'the reason being written when the refusal landed');
    await settled(() => {
      rerender(scoped(first));
    });
    // The reader starts writing a reason on the finding they were taken back to.
    write('Reason for denying', 'a second reason, on the finding the refusal was about');
    rerender(scoped(second));

    expect(screen.getByLabelText('Reason for denying')).toHaveValue(
      'the reason being written when the refusal landed'
    );
  });
});

describe('FindingCard on a finding that has already been decided', () => {
  const ruled = makeFinding({
    id: 'AI-1',
    state: 'ruled',
    options: [option()],
    ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
  });

  it('says what was decided', () => {
    renderCard({ finding: ruled, sectionState: 'ruled' });

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent('Ruled');
  });

  it('reads as decided anywhere on the card, which is the thing an open one never says', () => {
    renderCard({ finding: ruled, sectionState: 'ruled' });

    expect(screen.getByTestId(TEST_IDS.findingCard).textContent).toMatch(
      /ruled|ruling|decided|chose|chosen/i
    );
  });

  it('marks the option the ruling chose', () => {
    renderCard({ finding: ruled, sectionState: 'ruled' });

    expect(screen.getByText('A: Apply it').closest('button')).toHaveAttribute(
      'data-chosen',
      'true'
    );
  });

  it('says nothing about a decision on a finding nobody has decided', () => {
    renderCard();

    expect(screen.queryByTestId(TEST_IDS.decisionSummary)).toBeNull();
  });

  it('takes the decision back where the reader is working, rather than sending them elsewhere', async () => {
    const { fetchMock } = renderCard({ finding: ruled, sectionState: 'ruled' });

    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));
    await settled(() => {
      fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));
    });

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/audits/2026-07-30/finding/AI-1/reopen',
      expect.anything()
    );
  });

  it('warns before a reopen discards the ruling', () => {
    const { fetchMock } = renderCard({ finding: ruled, sectionState: 'ruled' });

    fireEvent.click(screen.getByRole('button', { name: 'Reopen' }));

    expect(screen.getByTestId(TEST_IDS.confirmAccept)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers a question once the reopen has landed, without naming another view', () => {
    renderCard({ finding: ruled, sectionState: 'ruled' });

    expect(screen.queryByText(/List view/u)).toBeNull();
  });

  it('offers no reopen on a finding nobody has decided', () => {
    renderCard();

    expect(screen.queryByRole('button', { name: 'Reopen' })).toBeNull();
  });

  it('promises no option minting on a denied finding, which is not queued for any', () => {
    renderCard({
      finding: makeFinding({
        id: 'AI-1',
        state: 'denied',
        needsOptions: true,
        denial: { by: 'audit', reason: 'refuted by measurement', at: '2026-07-30' },
      }),
      sectionState: 'denied',
    });

    expect(screen.getByText('Rule it in your own words.')).toBeInTheDocument();
  });

  it('reports a denial on the card the reader is looking at', () => {
    renderCard({
      finding: makeFinding({
        id: 'AI-1',
        state: 'denied',
        denial: { by: 'audit', reason: 'refuted by measurement', at: '2026-07-30' },
      }),
      sectionState: 'denied',
    });

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent(
      'refuted by measurement'
    );
  });
});

describe('FindingCard on a finding whose work stopped', () => {
  const blocked = makeFinding({
    id: 'AI-1',
    state: 'ruled',
    options: [option()],
    ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
    progress: {
      status: 'blocked',
      updated: '2026-08-01',
      verified: false,
      notes: [{ at: '2026-08-01', by: 'agent', text: 'The ruling names no owner.' }],
    },
  });

  it('answers the block from the card the reason is on', async () => {
    const { fetchMock } = renderCard({ finding: blocked, sectionState: 'ruled' });

    write('Answer the block', 'the api slice owns it');
    await settled(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer and unblock' }));
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/audits/2026-07-30/finding/AI-1/unblock');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ note: 'the api slice owns it', base: 'hash' }),
    });
  });

  /**
   * The reason is read and the answer is written at the same time, so they sit
   * on the card's two sides rather than one above the other: the reader is
   * looking at the account while typing the reply to it.
   */
  it('reads the reason down one column and writes the answer down the other', () => {
    renderCard({ finding: blocked, sectionState: 'ruled' });

    expect(
      screen.getByTestId(TEST_IDS.blockingNote).closest('[data-slot^="finding-"]')
    ).toHaveAttribute('data-slot', 'finding-reading');
    expect(
      screen.getByLabelText('Answer the block').closest('[data-slot^="finding-"]')
    ).toHaveAttribute('data-slot', 'finding-deciding');
  });

  it('offers no answer on a finding whose work never stopped', () => {
    renderCard({ finding: makeFinding({ id: 'AI-1', state: 'ruled' }), sectionState: 'ruled' });

    expect(screen.queryByLabelText('Answer the block')).toBeNull();
  });

  it('answers no keystroke aimed at the box the answer is being written in', () => {
    renderCard({ finding: blocked, sectionState: 'ruled' });

    const box = screen.getByLabelText('Answer the block');
    box.focus();
    fireEvent.keyDown(box, { key: 'd' });

    expect(screen.getByLabelText('Reason for denying')).not.toHaveFocus();
    expect(box).toHaveFocus();
  });

  /**
   * The caret leaves the box without the edit ending — a click on a citation in
   * the account the reader is answering does exactly that — so the hold has to
   * outlive the focus.
   */
  it('holds the console’s keyboard over an answer nobody has sent', () => {
    renderCard({ finding: blocked, sectionState: 'ruled' });

    write('Answer the block', 'the api slice owns it');
    screen.getByLabelText('Answer the block').blur();
    press('d');

    expect(screen.getByLabelText('Reason for denying')).not.toHaveFocus();
    const { result } = renderHook(() => useHotkeysHeld());
    expect(result.current).toBe(true);
  });

  it('hands the reader back to an answer nobody has sent', () => {
    renderCard({ finding: blocked, sectionState: 'ruled' });

    write('Answer the block', 'the api slice owns it');
    screen.getByLabelText('Answer the block').blur();
    press('Escape');

    expect(screen.getByLabelText('Answer the block')).toHaveFocus();
  });

  /**
   * Escape walks out of the boxes one at a time: the box it lands in empties on
   * its own Escape, and the next press reaches the one behind it. A box that
   * takes the caret but never gives it back would strand every box after it.
   */
  it('walks the reader out of an answer down to the denial behind it', () => {
    renderCard({ finding: blocked, sectionState: 'ruled' });

    write('Answer the block', 'the api slice owns it');
    write('Reason for denying', 'the audit misread it');
    screen.getByLabelText('Reason for denying').blur();
    press('Escape');
    const answer = screen.getByLabelText('Answer the block');
    expect(answer).toHaveFocus();

    fireEvent.keyDown(answer, { key: 'Escape' });
    press('Escape');

    expect(screen.getByLabelText('Reason for denying')).toHaveFocus();
    expect(screen.getByLabelText('Reason for denying')).toHaveValue('the audit misread it');
  });

  it('reports a refused answer on the card the reader is on', async () => {
    renderCard({
      finding: blocked,
      sectionState: 'ruled',
      api: {
        fetch: vi
          .fn()
          .mockImplementation(
            responds(409, { error: { code: 'conflict', message: 'a note landed since you read' } })
          ) as unknown as typeof globalThis.fetch,
        wait: () => Promise.resolve(),
      },
    });

    write('Answer the block', 'the api slice owns it');
    await settled(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer and unblock' }));
    });

    expect(screen.getByTestId(TEST_IDS.writeError)).toHaveTextContent(
      'a note landed since you read'
    );
  });
});

describe('FindingCard on a finding held by a question', () => {
  const questioned = makeFinding({
    id: 'AI-1',
    questions: [
      makeQuestion({ at: '2026-07-30', text: 'was the destructive chain already applied?' }),
    ],
  });

  it('names the state on the card the reader lands on', () => {
    renderCard({ finding: questioned, sectionState: 'open' });

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent('Question open');
  });

  it('shows the pending question in the section that exists for questions', () => {
    renderCard({ finding: questioned, sectionState: 'open' });

    const thread = screen.getByRole('region', { name: 'Questions' });

    expect(thread).toHaveTextContent('was the destructive chain already applied?');
  });

  it('states the pending question where the reader lands, not only further down', () => {
    renderCard({ finding: questioned, sectionState: 'open' });

    expect(screen.getByTestId(TEST_IDS.decisionSummary)).toHaveTextContent(
      'was the destructive chain already applied?'
    );
  });

  it('says the question is still waiting rather than leaving the block bare', () => {
    renderCard({ finding: questioned, sectionState: 'open' });

    expect(screen.getByText('waiting for an answer')).toBeInTheDocument();
  });
});

describe('FindingCard and the mark that owes a finding a session', () => {
  const marked = makeFinding({
    id: 'AI-1',
    state: 'open',
    options: [option({ id: 'A', dedicated: true }), option({ id: 'B', label: 'Leave it' })],
  });

  it('sets the mark on its own, because it decides nothing else', async () => {
    const { fetchMock } = renderCard({ finding: first, sectionState: 'open' });

    await settled(() => {
      fireEvent.click(screen.getByTestId(TEST_IDS.dedicatedToggle));
    });

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/audits/2026-07-30/finding/AI-1/dedicate');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ dedicated: true, base: 'hash' }),
    });
  });

  it('clears a mark the reader disagrees with', async () => {
    const { fetchMock } = renderCard({
      finding: makeFinding({ id: 'AI-1', state: 'open', dedicated: true }),
      sectionState: 'open',
    });

    await settled(() => {
      fireEvent.click(screen.getByTestId(TEST_IDS.dedicatedToggle));
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ dedicated: false, base: 'hash' }),
    });
  });

  it('carries the mark on the ruling when the chosen option calls for one', async () => {
    const { fetchMock } = renderCard({ finding: marked, sectionState: 'open' });

    await settled(() => {
      fireEvent.click(screen.getAllByTestId(TEST_IDS.optionChoice)[0]!);
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ option: 'A', dedicated: true, base: 'hash' }),
    });
  });

  it('leaves the mark alone when the chosen option calls for nothing', async () => {
    const { fetchMock } = renderCard({ finding: marked, sectionState: 'open' });

    await settled(() => {
      fireEvent.click(screen.getAllByTestId(TEST_IDS.optionChoice)[1]!);
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({ option: 'B', base: 'hash' }),
    });
  });

  /** The marker informs the ruling screen; only the field moves the finding. */
  it('opens the toggle on a marker the chosen option carries', () => {
    renderCard({
      finding: makeFinding({
        id: 'AI-1',
        state: 'ruled',
        options: [option({ id: 'A', dedicated: true })],
        ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
      }),
      sectionState: 'ruled',
    });

    expect(screen.getByTestId(TEST_IDS.dedicatedToggle)).toBeChecked();
  });

  it('writes nothing when the reader turns an option’s proposal down', async () => {
    const { fetchMock } = renderCard({
      finding: makeFinding({
        id: 'AI-1',
        state: 'ruled',
        options: [option({ id: 'A', dedicated: true })],
        ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
      }),
      sectionState: 'ruled',
    });

    await settled(() => {
      fireEvent.click(screen.getByTestId(TEST_IDS.dedicatedToggle));
    });

    expect(screen.getByTestId(TEST_IDS.dedicatedToggle)).not.toBeChecked();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says on the card itself that the finding is owed a session', () => {
    renderCard({
      finding: makeFinding({ id: 'AI-1', state: 'open', dedicated: true }),
      sectionState: 'open',
    });

    expect(screen.getByTestId(TEST_IDS.dedicatedBanner)).toBeInTheDocument();
  });

  const stopped = {
    status: 'blocked' as const,
    updated: '2026-08-01',
    verified: false,
    notes: [{ at: '2026-08-01', by: 'agent' as const, text: 'This is bigger than one task.' }],
  };

  /**
   * The two controls are one answer. A mark set in the decisions area and an
   * answer to the block sent afterwards are the same reader saying the same
   * thing, so the second write cannot undo the first.
   */
  it('does not clear a mark the reader set on the card before answering the block', async () => {
    const { fetchMock } = renderCard({
      finding: makeFinding({
        id: 'AI-1',
        state: 'ruled',
        options: [option()],
        ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
        progress: stopped,
      }),
      sectionState: 'ruled',
    });

    await settled(() => {
      fireEvent.click(screen.getByTestId(TEST_IDS.dedicatedToggle));
    });
    expect(screen.getByTestId(TEST_IDS.unblockDedicated)).toBeChecked();

    write('Answer the block', 'carry on');
    await settled(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer and unblock' }));
    });

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ note: 'carry on', dedicated: true, base: 'hash' }),
    });
  });

  it('does not put back a mark the reader took off before answering the block', async () => {
    const { fetchMock } = renderCard({
      finding: makeFinding({
        id: 'AI-1',
        state: 'ruled',
        dedicated: true,
        options: [option()],
        ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
        progress: stopped,
      }),
      sectionState: 'ruled',
    });

    await settled(() => {
      fireEvent.click(screen.getByTestId(TEST_IDS.dedicatedToggle));
    });
    expect(screen.getByTestId(TEST_IDS.unblockDedicated)).not.toBeChecked();

    write('Answer the block', 'it fits in one task');
    await settled(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer and unblock' }));
    });

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      body: JSON.stringify({ note: 'it fits in one task', dedicated: false, base: 'hash' }),
    });
  });

  it('answers a block and marks the finding in one write', async () => {
    const { fetchMock } = renderCard({
      finding: makeFinding({
        id: 'AI-1',
        state: 'ruled',
        options: [option()],
        ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
        progress: {
          status: 'blocked',
          updated: '2026-08-01',
          verified: false,
          notes: [{ at: '2026-08-01', by: 'agent', text: 'This is bigger than one task.' }],
        },
      }),
      sectionState: 'ruled',
    });

    fireEvent.click(screen.getByTestId(TEST_IDS.unblockDedicated));
    write('Answer the block', 'agreed, it needs a session');
    await settled(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Answer and unblock' }));
    });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      body: JSON.stringify({
        note: 'agreed, it needs a session',
        dedicated: true,
        base: 'hash',
      }),
    });
  });

  /**
   * The mark moves without the reader touching either control: a ruling on an
   * option carrying the marker sets it underneath them. Both controls re-seed
   * from the finding they are shown beside, or the next write sends back the
   * mark the card opened on.
   */
  it('re-seeds both controls when the mark moves under the same finding', () => {
    const unmarked = makeFinding({
      id: 'AI-1',
      state: 'ruled',
      options: [option()],
      ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
      progress: stopped,
    });
    const { rerenderWith } = renderCard({ finding: unmarked, sectionState: 'ruled' });
    expect(screen.getByTestId(TEST_IDS.dedicatedToggle)).not.toBeChecked();

    rerenderWith({ finding: { ...unmarked, dedicated: true } });

    expect(screen.getByTestId(TEST_IDS.dedicatedToggle)).toBeChecked();
    expect(screen.getByTestId(TEST_IDS.unblockDedicated)).toBeChecked();
  });
});
