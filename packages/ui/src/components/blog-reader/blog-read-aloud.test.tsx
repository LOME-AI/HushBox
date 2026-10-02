import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderToStaticMarkup } from 'react-dom/server';

import { TEST_SIGNALS, TTS_MODEL_DOWNLOAD_MB } from '@hushbox/shared';

import { BlogReadAloud } from './blog-read-aloud';
import { useA11yStore } from '../accessibility/store';
import { A11Y_CLASS_RULES, A11Y_FONT_OVERRIDE_CLASS } from '../accessibility/lib/class-toggles';
import type { CreateDocumentReaderOptions } from '../accessibility/lib/document-reader';

const h = vi.hoisted(() => ({
  captured: { value: null as CreateDocumentReaderOptions | null },
  reader: { start: vi.fn(), stop: vi.fn(), pause: vi.fn(), resume: vi.fn(), chunkCount: 3 },
  highlighter: { highlight: vi.fn(), clear: vi.fn() },
  createDocumentReader: vi.fn(),
  createChunkHighlighter: vi.fn(),
}));

vi.mock('../accessibility/lib/document-reader', () => ({
  createDocumentReader: h.createDocumentReader,
}));

vi.mock('../accessibility/lib/chunk-highlighter', () => ({
  createChunkHighlighter: h.createChunkHighlighter,
}));

/** The reader options the component passed to `createDocumentReader`. */
function readerOptions(): CreateDocumentReaderOptions {
  if (h.captured.value === null) throw new Error('createDocumentReader was not called');
  return h.captured.value;
}

/** One of the component's band parts, by its `data-slot` name. */
function bandPart(name: 'status' | 'stack' | 'disclosure'): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-slot="blog-reader-${name}"]`);
  if (el === null) throw new Error(`missing blog-reader-${name}`);
  return el;
}

function listenButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Listen to this post' });
}

/**
 * A control as it stands in the server-rendered markup, parsed into a real
 * element. Asserting on the parsed node rather than on the markup string is
 * what keeps the disabled pin honest: `disabled` also occurs in these controls'
 * class lists as the `disabled:` variant prefix, so a string match for it holds
 * whether or not the attribute is there.
 */
function serverControl(name: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(<BlogReadAloud />);
  const el = host.querySelector<HTMLElement>(`button[aria-label="${name}"]`);
  if (el === null) throw new Error(`missing server-rendered control: ${name}`);
  return el;
}

function highlightToggle(): HTMLElement {
  return screen.getByRole('switch', { name: 'Highlight while reading' });
}

function stopButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Stop' });
}

function pauseButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Pause' });
}

function resumeButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Resume' });
}

/** The pill's divider between its two parts. */
function pillHairline(): HTMLElement {
  const el = screen
    .getByRole('group', { name: 'Read aloud' })
    .querySelector<HTMLElement>(':scope > span[aria-hidden="true"]');
  if (el === null) throw new Error('missing pill hairline');
  return el;
}

/** The container-query variant under which the pill switches to its stacked layout. */
function narrowQuery(pill: HTMLElement): string {
  const match = /(?:^|\s)(@max-\[[^\]\s]+\]\/reader):flex-col(?:\s|$)/.exec(pill.className);
  if (match?.[1] === undefined) throw new Error('the pill has no narrow-column layout');
  return match[1];
}

/** How many characters the widest transport label ("Resume") spaces out. */
const WIDEST_LABEL_CHARACTERS = 6;
/** The labels' text size in rem, which a letter spacing in em multiplies. */
const LABEL_TEXT_REM = 0.875;

/**
 * The widget's rule for one letter spacing, found by the value the pill's
 * thresholds were derived from, so a changed spacing fails here rather than
 * leaving a threshold measured against a spacing the widget no longer sets.
 */
function letterSpacingRule(value: '0.05' | '0.12'): { className: string; em: number } {
  const rule = A11Y_CLASS_RULES.find(
    (each) => each.field === 'letterSpacing' && (each.when as readonly string[]).includes(value)
  );
  if (rule === undefined) throw new Error(`the widget sets no class for letter spacing ${value}`);
  return { className: rule.className, em: Number.parseFloat(value) };
}

const LOOSE = letterSpacingRule('0.05');
const LOOSEST = letterSpacingRule('0.12');
const FONT_OVERRIDE = `.${A11Y_FONT_OVERRIDE_CLASS}`;

/**
 * The rem part of the column width below which the pill stacks, for the rule
 * gated on `gate` (a selector the widget's classes on `<html>` match) or the
 * ungated default rule when `gate` is null. Its pixel part is returned apart so
 * a test can hold it fixed.
 */
function stackThreshold(gate: string | null): { rem: number; px: number } {
  const pill = screen.getByRole('group', { name: 'Read aloud' });
  const prefix = gate === null ? '' : `[${gate}_&]:`;
  const token = pill.className
    .split(/\s+/)
    .find((each) => each.startsWith(`${prefix}@max-[calc(`) && each.endsWith(')]/reader:flex-col'));
  if (token === undefined) throw new Error(`no stacking rule for ${gate ?? 'the default'}`);
  const terms = token
    .slice(`${prefix}@max-[calc(`.length, -')]/reader:flex-col'.length)
    .split('_+_');
  const sum = (unit: 'rem' | 'px'): number =>
    terms.filter((t) => t.endsWith(unit)).reduce((n, t) => n + Number.parseFloat(t), 0);
  return { rem: sum('rem'), px: sum('px') };
}

/** Every state's label the transport carries, in the order the states arise. */
const TRANSPORT_LABELS = ['Listen', 'Stop', 'Pause', 'Resume'] as const;

/**
 * The transport labels a sighted reader sees. The control carries every state's
 * label so its width never changes, and hides all but the current one.
 */
function visibleTransportLabels(control: HTMLElement): string[] {
  return TRANSPORT_LABELS.filter((label) => {
    const el = within(control).getByText(label);
    return !el.classList.contains('invisible');
  });
}

interface FakeAudioSource {
  readonly connect: ReturnType<typeof vi.fn>;
  readonly start: ReturnType<typeof vi.fn>;
}

interface FakeAudioContext {
  state: AudioContextState;
  readonly destination: object;
  readonly createBuffer: ReturnType<typeof vi.fn>;
  readonly createBufferSource: ReturnType<typeof vi.fn>;
  readonly resume: ReturnType<typeof vi.fn>;
}

let createdContexts: FakeAudioContext[] = [];
let primedSources: FakeAudioSource[] = [];
const OriginalAudioContext = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;

function makeAudioContext(): FakeAudioContext {
  // Born suspended, as it is on iOS Safari until something unlocks it.
  const ctx: FakeAudioContext = {
    state: 'suspended',
    destination: {},
    createBuffer: vi.fn(() => ({})),
    createBufferSource: vi.fn(() => {
      const source: FakeAudioSource = { connect: vi.fn(), start: vi.fn() };
      primedSources.push(source);
      return source;
    }),
    resume: vi.fn(() => {
      ctx.state = 'running';
      return Promise.resolve();
    }),
  };
  createdContexts.push(ctx);
  return ctx;
}

function blockEl(): HTMLElement {
  const el = document.querySelector<HTMLElement>('article[data-reading] p');
  if (el === null) throw new Error('missing article paragraph');
  return el;
}

/** Click Listen and wait until the (mocked) reader has been constructed. */
async function startReading(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(listenButton());
  await waitFor(() => {
    expect(h.createDocumentReader).toHaveBeenCalled();
  });
}

/**
 * Longer than the component's cache-hit dwell, so advancing by it always lands
 * past the gate. Kept local rather than imported: the test pins the observable
 * behavior, not the exact constant the component chose.
 */
const PAST_DWELL_MS = 1000;

/**
 * Click Listen under fake timers and let the click's dynamic import settle.
 * Testing Library's `waitFor` polls on timers, so it cannot be used here;
 * `advanceTimersByTimeAsync` yields to the real task queue instead, draining
 * the pending microtasks that resolve the import.
 */
async function startReadingWithFakeTimers(): Promise<void> {
  fireEvent.click(listenButton());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(h.createDocumentReader).toHaveBeenCalled();
}

beforeEach(() => {
  createdContexts = [];
  primedSources = [];
  (globalThis as { AudioContext?: unknown }).AudioContext = vi.fn(makeAudioContext);
  h.captured.value = null;
  h.reader.start.mockReset();
  h.reader.stop.mockReset();
  h.reader.pause.mockReset();
  h.reader.resume.mockReset().mockImplementation(() => Promise.resolve());
  h.highlighter.highlight.mockReset();
  h.highlighter.clear.mockReset();
  h.createDocumentReader.mockReset().mockImplementation((options: CreateDocumentReaderOptions) => {
    h.captured.value = options;
    return h.reader;
  });
  h.createChunkHighlighter.mockReset().mockReturnValue(h.highlighter);

  // Fresh article container each test. Testing Library's automatic afterEach
  // cleanup unmounts prior render trees (and any open radix portals) before
  // this runs, so replacing body content here is safe; wiping it in an
  // afterEach instead would orphan an open tooltip portal mid-cleanup.
  document.body.innerHTML = '<article data-reading><p>Every message is encrypted.</p></article>';
  act(() => {
    useA11yStore.getState().reset();
  });
});

afterEach(() => {
  vi.useRealTimers();
  if (OriginalAudioContext === undefined) {
    delete (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  } else {
    (globalThis as { AudioContext?: typeof AudioContext }).AudioContext = OriginalAudioContext;
  }
});

describe('BlogReadAloud — idle', () => {
  it('renders the Listen control and no active-state chrome', () => {
    render(<BlogReadAloud />);
    expect(listenButton()).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the canonical local-privacy disclosure verbatim', () => {
    render(<BlogReadAloud />);
    // Number sourced from the shared figure so it cannot drift from the widget.
    expect(bandPart('disclosure')).toHaveTextContent(
      `Local text to speech. First listen downloads the voice model (about ${TTS_MODEL_DOWNLOAD_MB.toString()} MB, one time).`
    );
  });

  it('defaults the highlight switch to on', () => {
    render(<BlogReadAloud />);
    expect(highlightToggle()).toHaveAttribute('aria-checked', 'true');
  });

  it('shows Listen as the only visible transport label', () => {
    render(<BlogReadAloud />);
    expect(visibleTransportLabels(listenButton())).toEqual(['Listen']);
  });

  it('shows Highlight as the switch visible label', () => {
    render(<BlogReadAloud />);
    expect(highlightToggle()).toHaveTextContent('Highlight');
  });
});

describe('BlogReadAloud — read-aloud pill', () => {
  it('groups the transport and the highlight switch under the name Read aloud', () => {
    render(<BlogReadAloud />);
    const pill = screen.getByRole('group', { name: 'Read aloud' });
    expect(within(pill).getByRole('button', { name: 'Listen to this post' })).toBe(listenButton());
    expect(within(pill).getByRole('switch', { name: 'Highlight while reading' })).toBe(
      highlightToggle()
    );
  });

  it('caps the pill at its column width so large text cannot push it off screen', () => {
    render(<BlogReadAloud />);
    expect(screen.getByRole('group', { name: 'Read aloud' })).toHaveClass('max-w-full');
  });

  it('grows with its content rather than holding a fixed height', () => {
    render(<BlogReadAloud />);
    const pill = screen.getByRole('group', { name: 'Read aloud' });
    // A fixed height would leave the second row hanging outside the border.
    expect(pill.className).not.toMatch(/(^|\s)h-\d/);
  });

  it('never wraps its parts implicitly, where a row could end in a stray hairline', () => {
    render(<BlogReadAloud />);
    expect(screen.getByRole('group', { name: 'Read aloud' })).not.toHaveClass('flex-wrap');
  });

  it('makes the reader column the container the pill measures itself against', () => {
    render(<BlogReadAloud />);
    const column = screen.getByRole('group', { name: 'Read aloud' }).parentElement;
    expect(column).toHaveClass('@container/reader');
  });

  it('lays the parts out in one row by default', () => {
    render(<BlogReadAloud />);
    const pill = screen.getByRole('group', { name: 'Read aloud' });
    expect(pill).toHaveClass('inline-flex');
    expect(pill.className).not.toMatch(/(^|\s)flex-col(\s|$)/);
  });

  it('stacks the parts when the column is narrower than the one-row pill', () => {
    render(<BlogReadAloud />);
    const pill = screen.getByRole('group', { name: 'Read aloud' });
    expect(pill).toHaveClass(`${narrowQuery(pill)}:flex-col`);
  });

  it('turns the hairline with the pill, one class list serving both layouts', () => {
    render(<BlogReadAloud />);
    const hairline = pillHairline();
    // A 1px basis on the main axis and a stretch on the cross axis make it a
    // vertical line in a row and a horizontal one in a column.
    expect(hairline).toHaveClass('flex-[0_0_1px]', 'self-stretch', 'mx-0.5', 'my-1.5');
    expect(hairline.className).not.toMatch(/@max-|a11y-/);
  });

  it('spaces the stacked rows so neither part reaches the other with its touch extension', () => {
    render(<BlogReadAloud />);
    // Each part's coarse-pointer layer reaches 0.375rem past its box, so each
    // side of the hairline needs at least that much space.
    expect(listenButton()).toHaveClass('pointer-coarse:before:-inset-y-1.5');
    expect(pillHairline()).toHaveClass('my-1.5');
  });

  it('gates its stacking rules on exactly the classes the accessibility widget sets', () => {
    render(<BlogReadAloud />);
    const pill = screen.getByRole('group', { name: 'Read aloud' });
    // Tailwind reads the class strings literally, so the gates are written out
    // in the component; this holds each one to the widget's own names.
    const gates = pill.className
      .split(/\s+/)
      .map((token) => /^\[([^\]]+)_&\]:@max-/.exec(token)?.[1])
      .filter((gate): gate is string => gate !== undefined)
      .toSorted((a, b) => a.localeCompare(b));
    expect(gates).toEqual(
      [
        `.${LOOSE.className}`,
        `.${LOOSEST.className}`,
        FONT_OVERRIDE,
        `${FONT_OVERRIDE}.${LOOSE.className}`,
        `${FONT_OVERRIDE}.${LOOSEST.className}`,
      ].toSorted((a, b) => a.localeCompare(b))
    );
  });

  it('stacks earlier under the loose letter spacing, by that spacing over the widest label', () => {
    render(<BlogReadAloud />);
    const base = stackThreshold(null);
    const loose = stackThreshold(`.${LOOSE.className}`);
    expect(loose.rem - base.rem).toBeCloseTo(
      WIDEST_LABEL_CHARACTERS * LOOSE.em * LABEL_TEXT_REM,
      4
    );
    expect(loose.px).toBe(base.px);
  });

  it('stacks earlier under the loosest letter spacing, by that spacing over the widest label', () => {
    render(<BlogReadAloud />);
    const base = stackThreshold(null);
    const loosest = stackThreshold(`.${LOOSEST.className}`);
    expect(loosest.rem - base.rem).toBeCloseTo(
      WIDEST_LABEL_CHARACTERS * LOOSEST.em * LABEL_TEXT_REM,
      4
    );
    expect(loosest.px).toBe(base.px);
  });

  it('stacks earlier while the widget overrides the font, since its widest face is wider', () => {
    render(<BlogReadAloud />);
    const base = stackThreshold(null);
    const font = stackThreshold(FONT_OVERRIDE);
    expect(font.rem).toBeGreaterThan(base.rem);
    expect(font.px).toBe(base.px);
  });

  it('adds the loose spacing to the font override threshold when both are on', () => {
    render(<BlogReadAloud />);
    const font = stackThreshold(FONT_OVERRIDE);
    const both = stackThreshold(`${FONT_OVERRIDE}.${LOOSE.className}`);
    expect(both.rem - font.rem).toBeCloseTo(WIDEST_LABEL_CHARACTERS * LOOSE.em * LABEL_TEXT_REM, 4);
    expect(both.px).toBe(font.px);
  });

  it('adds the loosest spacing to the font override threshold when both are on', () => {
    render(<BlogReadAloud />);
    const font = stackThreshold(FONT_OVERRIDE);
    const both = stackThreshold(`${FONT_OVERRIDE}.${LOOSEST.className}`);
    expect(both.rem - font.rem).toBeCloseTo(
      WIDEST_LABEL_CHARACTERS * LOOSEST.em * LABEL_TEXT_REM,
      4
    );
    expect(both.px).toBe(font.px);
  });

  it('keeps the hairline between the two parts in both layouts', () => {
    render(<BlogReadAloud />);
    const hairline = pillHairline();
    expect(hairline.previousElementSibling).toBe(listenButton());
    expect(hairline.nextElementSibling).toBe(highlightToggle());
  });

  it('keeps the disclosure outside the pill', () => {
    render(<BlogReadAloud />);
    expect(screen.getByRole('group', { name: 'Read aloud' })).not.toContainElement(
      bandPart('disclosure')
    );
  });

  it('reserves every state label in the transport so relabelling cannot resize the pill', () => {
    render(<BlogReadAloud />);
    for (const label of TRANSPORT_LABELS) {
      expect(within(listenButton()).getByText(label)).toBeInTheDocument();
    }
  });

  it('draws the transport glyph inside a disc hidden from assistive technology', () => {
    render(<BlogReadAloud />);
    const disc = listenButton().querySelector('svg')?.parentElement;
    expect(disc).not.toBe(listenButton());
    expect(disc).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('BlogReadAloud — band layout', () => {
  it('renders the status slot as a sibling of the reader stack, not inside it', () => {
    render(<BlogReadAloud />);

    const status = bandPart('status');
    const stack = bandPart('stack');
    expect(stack).not.toContainElement(status);
    expect(status).not.toContainElement(stack);
    expect(status.parentElement).toBe(stack.parentElement);
  });

  it('keeps the status slot present and empty while idle', () => {
    render(<BlogReadAloud />);

    // Reserved, not conditional: the slot the download bar lands in already
    // occupies the band's gap, so its arrival reflows nothing.
    expect(bandPart('status')).toBeEmptyDOMElement();
  });

  it('renders the download bar in the status slot rather than the reader stack', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();

    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
      readerOptions().onDownloadProgress({ pct: 40 });
    });

    const bar = screen.getByRole('progressbar');
    expect(bandPart('status')).toContainElement(bar);
    expect(bandPart('stack')).not.toContainElement(bar);
  });

  it('renders the error line in the status slot rather than the reader stack', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('error');
    });

    const alert = screen.getByRole('alert');
    expect(bandPart('status')).toContainElement(alert);
    expect(bandPart('stack')).not.toContainElement(alert);
  });

  it('breaks the disclosure into exactly two elements so the desktop break is fixed', () => {
    render(<BlogReadAloud />);

    const lines = bandPart('disclosure').querySelectorAll('span');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent('Local text to speech. First listen downloads');
    expect(lines[1]).toHaveTextContent(
      `the voice model (about ${TTS_MODEL_DOWNLOAD_MB.toString()} MB, one time).`
    );
  });

  it('keeps the pill and disclosure in flow so the band grows to fit them instead of clipping them', () => {
    render(<BlogReadAloud />);
    const contents = bandPart('stack').firstElementChild;
    if (contents === null) throw new Error('missing reader stack contents');
    // The pill is taller than the byline block leaves room for, so a contents
    // box taken out of flow and clipped to the band would cut its border.
    expect(contents.className).not.toMatch(/(^|\s)(md:)?absolute(\s|$)/);
    expect(contents).not.toHaveClass('overflow-hidden');
  });

  it('sets each disclosure line on its own line on desktop and joins them on mobile', () => {
    render(<BlogReadAloud />);

    // The two/three-line split is pure layout, which happy-dom does not compute;
    // the classes carrying it are the only part assertable here.
    for (const line of bandPart('disclosure').querySelectorAll('span')) {
      expect(line).toHaveClass('block');
      expect(line).toHaveClass('max-md:inline');
    }
  });

  it('lets each disclosure line wrap where it cannot fit rather than overflow the page', () => {
    render(<BlogReadAloud />);
    for (const line of bandPart('disclosure').querySelectorAll('span')) {
      expect(line).not.toHaveClass('whitespace-nowrap');
    }
  });
});

describe('BlogReadAloud — speaking signal', () => {
  it('carries no speaking signal while idle', () => {
    render(<BlogReadAloud />);

    expect(document.querySelector(`[${TEST_SIGNALS.blogSpeaking}]`)).toBeNull();
  });

  it('carries no speaking signal while loading', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    expect(document.querySelector(`[${TEST_SIGNALS.blogSpeaking}]`)).toBeNull();
  });

  it('carries no speaking signal once the reader enters its speaking phase, before any audio starts', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    // The reader's 'speaking' state fires before playChunks() even issues its
    // first speak(): reaching this state means the engine finished loading,
    // not that audio is playing.
    act(() => {
      readerOptions().onState('speaking');
    });

    expect(document.querySelector(`[${TEST_SIGNALS.blogSpeaking}]`)).toBeNull();
  });

  it('emits the speaking signal once audio actually starts', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onAudioStart();
    });

    expect(bandPart('stack')).toHaveAttribute(TEST_SIGNALS.blogSpeaking, 'true');
  });

  it('drops the speaking signal on pause', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onAudioStart();
      readerOptions().onState('paused');
    });

    expect(document.querySelector(`[${TEST_SIGNALS.blogSpeaking}]`)).toBeNull();
  });

  it('drops the speaking signal on stop', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onAudioStart();
      readerOptions().onState('stopped');
    });

    expect(document.querySelector(`[${TEST_SIGNALS.blogSpeaking}]`)).toBeNull();
  });

  it('drops the speaking signal on error', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onAudioStart();
      readerOptions().onState('error');
    });

    expect(document.querySelector(`[${TEST_SIGNALS.blogSpeaking}]`)).toBeNull();
  });

  it('re-arms the speaking signal on resume after pause', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onAudioStart();
      readerOptions().onState('paused');
    });
    expect(document.querySelector(`[${TEST_SIGNALS.blogSpeaking}]`)).toBeNull();

    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onAudioStart();
    });

    expect(bandPart('stack')).toHaveAttribute(TEST_SIGNALS.blogSpeaking, 'true');
  });
});

describe('BlogReadAloud — highlight toggle', () => {
  it('flips aria-checked and persists the preference on click', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    const toggle = highlightToggle();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(useA11yStore.getState().readingHighlight).toBe(false);
  });

  it('shows the on-state tooltip copy on hover', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);

    await user.hover(highlightToggle());

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Highlight while reading: on');
  });

  it('shows the off-state tooltip copy when highlighting is off', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    act(() => {
      useA11yStore.getState().update({ readingHighlight: false });
    });

    await user.hover(highlightToggle());

    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent('Highlight while reading: off');
  });
});

describe('BlogReadAloud — highlight switch track', () => {
  /** The switch's track and its thumb, the two decorative parts that carry its state. */
  function trackParts(): { track: Element; thumb: Element } {
    const track = highlightToggle().querySelector('[aria-hidden="true"]');
    const thumb = track?.firstElementChild;
    if (track === null || thumb === null || thumb === undefined) {
      throw new Error('missing switch track');
    }
    return { track, thumb };
  }

  it('keeps the checked track red in dark, where the dark off colour would otherwise win', () => {
    render(<BlogReadAloud />);
    // A stacked dark variant outranks a lone group variant, so the checked colour
    // is declared under dark as well or the dark off colour paints over it.
    expect(trackParts().track).toHaveClass('dark:group-aria-checked:bg-primary');
  });

  it('draws the off thumb in ink in dark so it stands out from the dark track', () => {
    render(<BlogReadAloud />);
    const { thumb } = trackParts();
    expect(thumb).toHaveClass('dark:bg-foreground');
    expect(thumb).toHaveClass('dark:group-aria-checked:bg-primary-foreground');
  });
});

describe('BlogReadAloud — audio unlock', () => {
  it('creates and primes the AudioContext inside the click, before the import resolves', async () => {
    render(<BlogReadAloud />);

    fireEvent.click(listenButton());

    // Nothing is awaited between the click dispatch and these assertions, so
    // everything they observe happened inside the gesture's synchronous call
    // stack — the only place iOS Safari lets an AudioContext unlock.
    expect(createdContexts).toHaveLength(1);
    expect(primedSources).toHaveLength(1);
    const source = primedSources[0]!;
    expect(source.connect).toHaveBeenCalledWith(createdContexts[0]!.destination);
    expect(source.start).toHaveBeenCalled();
    // The dynamic import has not resolved yet: the unlock strictly precedes it.
    expect(h.createDocumentReader).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(h.createDocumentReader).toHaveBeenCalled();
    });
  });

  it('restarts a non-running context inside the click, before the import resolves', async () => {
    render(<BlogReadAloud />);

    fireEvent.click(listenButton());

    // Nothing is awaited before this assertion, so the restart happened inside
    // the gesture's synchronous stack — the only place WebKit honours it, and
    // the only recovery for a context the browser interrupted while the tab
    // was in the background.
    expect(createdContexts[0]!.resume).toHaveBeenCalled();
    expect(h.createDocumentReader).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(h.createDocumentReader).toHaveBeenCalled();
    });
  });

  it('leaves an already-running context alone on a later listen', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    await user.click(stopButton());
    const ctx = createdContexts[0]!;
    expect(ctx.state).toBe('running');
    ctx.resume.mockClear();

    await startReading(user);

    expect(ctx.resume).not.toHaveBeenCalled();
  });

  it('restarts an interrupted context inside the resume click, before the reader resumes', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onState('paused');
    });
    // Backgrounding the tab while paused is what leaves it in this state, and
    // the reader's resume() takes no context, so nothing downstream restarts it.
    const ctx = createdContexts[0]!;
    ctx.state = 'suspended';
    ctx.resume.mockClear();

    fireEvent.click(resumeButton());

    // Asserted with nothing awaited in between, so this all happened in the
    // gesture's own synchronous stack, and the unlock strictly precedes the
    // reader call that will schedule audio on it.
    expect(ctx.resume).toHaveBeenCalled();
    expect(h.reader.resume).toHaveBeenCalled();
    expect(ctx.resume.mock.invocationCallOrder[0]!).toBeLessThan(
      h.reader.resume.mock.invocationCallOrder[0]!
    );
  });

  it('hands the primed context to the reader so the engine adopts it', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);

    await startReading(user);

    expect(h.reader.start).toHaveBeenCalledWith(createdContexts[0]);
  });

  it('re-primes the one context on a later listen instead of creating another', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    await user.click(stopButton());

    await startReading(user);

    expect(createdContexts).toHaveLength(1);
    expect(primedSources).toHaveLength(2);
  });
});

describe('BlogReadAloud — starting playback', () => {
  it('shows the Stop control immediately on first click', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);

    await user.click(listenButton());

    expect(stopButton()).toBeInTheDocument();
  });

  it('shows Stop as the only visible transport label while loading', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);

    await user.click(listenButton());

    expect(visibleTransportLabels(stopButton())).toEqual(['Stop']);
  });

  it('constructs the reader with the container, store voice, and a highlighter', async () => {
    const user = userEvent.setup();
    act(() => {
      useA11yStore.getState().update({ ttsVoice: 'bf_emma' });
    });
    render(<BlogReadAloud />);

    await startReading(user);

    const options = readerOptions();
    expect(options.container).toBe(document.querySelector('article[data-reading]'));
    expect(options.voice).toBe('bf_emma');
    expect(h.createChunkHighlighter).toHaveBeenCalledWith(
      document.querySelector('article[data-reading]')
    );
    expect(h.reader.start).toHaveBeenCalledTimes(1);
  });

  it('sets error and skips the reader when the article is absent', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    document.body.innerHTML = '';
    render(<BlogReadAloud />);

    await user.click(listenButton());

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't start playback. Try again.");
    expect(h.createDocumentReader).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const [message] = consoleSpy.mock.calls[0]!;
    expect(message).toMatch(/article|selector/i);
    consoleSpy.mockRestore();
  });

  it('surfaces an error when constructing the reader throws', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    const readerError = new Error('boom');
    h.createDocumentReader.mockImplementation(() => {
      throw readerError;
    });
    render(<BlogReadAloud />);

    await user.click(listenButton());

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't start playback. Try again.");
    });
    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const [message, loggedError] = consoleSpy.mock.calls[0]!;
    expect(message).not.toMatch(/article|selector/i);
    expect(loggedError).toBe(readerError);
    consoleSpy.mockRestore();
  });
});

describe('BlogReadAloud — reader lifecycle', () => {
  it('keeps the download bar visible when the reader reports loading', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();

    act(() => {
      readerOptions().onState('loading');
      vi.advanceTimersByTime(PAST_DWELL_MS);
    });

    expect(screen.getByRole('progressbar')).toBeInTheDocument();
  });

  it('forwards download progress to the bar', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();

    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
      readerOptions().onDownloadProgress({ pct: 42 });
    });

    expect(screen.getByText('42%')).toBeInTheDocument();
  });

  it('hides the download bar once speaking begins', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();
    // The bar must genuinely be on screen first, or the assertion below would
    // hold for a bar that was never rendered at all.
    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
      readerOptions().onDownloadProgress({ pct: 40 });
    });
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    act(() => {
      readerOptions().onState('speaking');
    });

    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(pauseButton()).toBeInTheDocument();
  });

  it('highlights each spoken chunk while highlighting is on', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    const p = blockEl();

    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onChunk({ index: 0, blockEl: p, text: 'x', startOffset: 0, endOffset: 5 });
    });

    expect(h.highlighter.highlight).toHaveBeenCalledWith({
      blockEl: p,
      startOffset: 0,
      endOffset: 5,
    });
  });

  it('clears instead of highlighting when highlighting is off', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await user.click(highlightToggle());
    await startReading(user);
    const p = blockEl();

    act(() => {
      readerOptions().onChunk({ index: 0, blockEl: p, text: 'x', startOffset: 0, endOffset: 5 });
    });

    expect(h.highlighter.highlight).not.toHaveBeenCalled();
    expect(h.highlighter.clear).toHaveBeenCalled();
  });

  it('clears the current highlight when toggled off mid-read', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
    });
    h.highlighter.clear.mockClear();

    await user.click(highlightToggle());

    expect(h.highlighter.clear).toHaveBeenCalled();
  });

  it('returns to idle and clears the highlight when the read completes', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('idle');
    });

    expect(listenButton()).toBeInTheDocument();
    expect(h.highlighter.clear).toHaveBeenCalled();
  });

  it('returns to idle when the reader reports it stopped', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('stopped');
    });

    expect(listenButton()).toBeInTheDocument();
  });

  it('shows the error line and clears the highlight on reader error', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('error');
    });

    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't start playback. Try again.");
    expect(h.highlighter.clear).toHaveBeenCalled();
  });
});

describe('BlogReadAloud — cached-model download bar', () => {
  it('does not show the download bar immediately on first click', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);

    await startReadingWithFakeTimers();

    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('shows the download bar once the load outlasts the cache-hit dwell', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();

    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
    });

    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-label', 'Preparing the voice');
  });

  it('never shows the download bar for a cached load that completes before the dwell', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();

    act(() => {
      vi.advanceTimersByTime(200);
      readerOptions().onDownloadProgress({ pct: 100 });
    });
    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
    });

    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('unmounts the download bar at 100% without waiting for speaking', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();
    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
      readerOptions().onDownloadProgress({ pct: 40 });
    });
    expect(screen.getByRole('progressbar')).toBeInTheDocument();

    act(() => {
      readerOptions().onDownloadProgress({ pct: 100 });
    });

    expect(screen.queryByRole('progressbar')).toBeNull();
    // Still loading (warmup): the bar left on its own, not because of `speaking`.
    expect(stopButton()).toBeInTheDocument();
  });

  it('replaces the download bar with the error line when the load fails short of 100%', async () => {
    vi.useFakeTimers();
    render(<BlogReadAloud />);
    await startReadingWithFakeTimers();
    act(() => {
      vi.advanceTimersByTime(PAST_DWELL_MS);
      readerOptions().onDownloadProgress({ pct: 40 });
    });

    act(() => {
      readerOptions().onState('error');
    });

    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't start playback. Try again.");
  });
});

describe('BlogReadAloud — highlight repaint', () => {
  it('repaints the current chunk when highlighting is toggled back on mid-read', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    const p = blockEl();
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onChunk({ index: 0, blockEl: p, text: 'x', startOffset: 0, endOffset: 5 });
    });
    const toggle = highlightToggle();
    await user.click(toggle);
    h.highlighter.highlight.mockClear();

    await user.click(toggle);

    expect(h.highlighter.highlight).toHaveBeenCalledWith({
      blockEl: p,
      startOffset: 0,
      endOffset: 5,
    });
  });

  it('does not repaint a finished read when highlighting is toggled back on', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onChunk({
        index: 0,
        blockEl: blockEl(),
        text: 'x',
        startOffset: 0,
        endOffset: 5,
      });
      readerOptions().onState('idle');
    });
    const toggle = highlightToggle();
    await user.click(toggle);
    h.highlighter.highlight.mockClear();

    await user.click(toggle);

    expect(h.highlighter.highlight).not.toHaveBeenCalled();
  });
});

describe('BlogReadAloud — stopping', () => {
  // Stopping is what the control offers while the model loads, since that load
  // cannot be cancelled or paused. Once audio plays the control pauses instead.
  it('stops the reader and returns to idle when Stop is clicked during the load', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    await user.click(stopButton());

    expect(h.reader.stop).toHaveBeenCalled();
    expect(listenButton()).toBeInTheDocument();
  });

  it('stops on Escape while the model loads', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    await user.keyboard('{Escape}');

    expect(h.reader.stop).toHaveBeenCalled();
    expect(listenButton()).toBeInTheDocument();
  });

  it('ignores Escape while idle', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);

    await user.keyboard('{Escape}');

    expect(h.reader.stop).not.toHaveBeenCalled();
  });

  it('ignores stale reader callbacks after a stop', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    const options = readerOptions();
    await user.click(stopButton());

    act(() => {
      options.onState('speaking');
    });

    expect(listenButton()).toBeInTheDocument();
  });

  it('replays from the start on a second Listen after stopping', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    await user.click(stopButton());

    await user.click(listenButton());

    await waitFor(() => {
      expect(h.createDocumentReader).toHaveBeenCalledTimes(2);
    });
  });

  it('stops the reader on unmount', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<BlogReadAloud />);
    await startReading(user);

    unmount();

    expect(h.reader.stop).toHaveBeenCalled();
  });
});

/** Drive the mocked reader into `speaking` with one chunk painted. */
function speakChunk(span: { readonly startOffset: number; readonly endOffset: number }): void {
  act(() => {
    readerOptions().onState('speaking');
    readerOptions().onChunk({ index: 0, blockEl: blockEl(), text: 'x', ...span });
  });
}

describe('BlogReadAloud — pause and resume', () => {
  it('labels the control Pause while speaking', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);

    act(() => {
      readerOptions().onState('speaking');
    });

    expect(visibleTransportLabels(pauseButton())).toEqual(['Pause']);
  });

  it('pauses the reader when the control is clicked while speaking', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
    });

    await user.click(pauseButton());

    expect(h.reader.pause).toHaveBeenCalledTimes(1);
    // Pausing already stops the engine once; a stop() here would be a second one.
    expect(h.reader.stop).not.toHaveBeenCalled();
  });

  it('labels the control Resume once the reader reports paused', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onState('paused');
    });

    expect(visibleTransportLabels(resumeButton())).toEqual(['Resume']);
  });

  it('resumes the reader when the control is clicked while paused', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onState('paused');
    });

    await user.click(resumeButton());

    expect(h.reader.resume).toHaveBeenCalledTimes(1);
  });

  it('keeps the reader connected across a pause, so the resumed read still paints', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    speakChunk({ startOffset: 0, endOffset: 5 });
    await user.click(pauseButton());
    act(() => {
      readerOptions().onState('paused');
    });

    await user.click(resumeButton());
    // Everything the resumed read reports: a run token bumped by the pause, or
    // a highlighter dropped by it, would silently discard all of this and leave
    // a control reading "Resume" over dead air.
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onChunk({
        index: 1,
        blockEl: blockEl(),
        text: 'y',
        startOffset: 6,
        endOffset: 11,
      });
    });

    expect(h.reader.resume).toHaveBeenCalledTimes(1);
    expect(h.highlighter.highlight).toHaveBeenCalledWith({
      blockEl: blockEl(),
      startOffset: 6,
      endOffset: 11,
    });
    expect(pauseButton()).toBeInTheDocument();
  });

  it('leaves the paused sentence highlighted', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    speakChunk({ startOffset: 0, endOffset: 5 });
    h.highlighter.clear.mockClear();

    act(() => {
      readerOptions().onState('paused');
    });

    // The painted sentence is the only marker of where the read will resume.
    expect(h.highlighter.clear).not.toHaveBeenCalled();
  });

  it('repaints the paused sentence when highlighting is toggled off and back on', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    speakChunk({ startOffset: 0, endOffset: 5 });
    act(() => {
      readerOptions().onState('paused');
    });
    const toggle = highlightToggle();

    await user.click(toggle);
    expect(h.highlighter.clear).toHaveBeenCalled();
    h.highlighter.highlight.mockClear();
    await user.click(toggle);

    expect(h.highlighter.highlight).toHaveBeenCalledWith({
      blockEl: blockEl(),
      startOffset: 0,
      endOffset: 5,
    });
  });

  it('pauses rather than stops on Escape while speaking', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
    });

    await user.keyboard('{Escape}');

    expect(h.reader.pause).toHaveBeenCalledTimes(1);
    expect(h.reader.stop).not.toHaveBeenCalled();
  });

  it('ignores keys other than Escape while speaking', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
    });

    // Not Space or Enter: those activate the focused control, which is the
    // button the click left focused, so they pause by design rather than by
    // this listener.
    await user.keyboard('a{ArrowDown}');

    expect(h.reader.pause).not.toHaveBeenCalled();
    expect(h.reader.stop).not.toHaveBeenCalled();
  });

  it('ignores Escape while paused', async () => {
    const user = userEvent.setup();
    render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
      readerOptions().onState('paused');
    });

    await user.keyboard('{Escape}');

    expect(h.reader.pause).not.toHaveBeenCalled();
    expect(h.reader.stop).not.toHaveBeenCalled();
    expect(resumeButton()).toBeInTheDocument();
  });

  it('stops the reader on unmount while paused', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<BlogReadAloud />);
    await startReading(user);
    act(() => {
      readerOptions().onState('speaking');
    });
    await user.click(pauseButton());
    act(() => {
      readerOptions().onState('paused');
    });

    unmount();

    // Once, by the teardown: the pause itself must not have stopped anything.
    expect(h.reader.stop).toHaveBeenCalledTimes(1);
  });
});

describe('BlogReadAloud — pre-hydration', () => {
  it('marks the transport control disabled in the server-rendered markup', () => {
    expect(serverControl('Listen to this post')).toBeDisabled();
  });

  it('marks the highlight toggle disabled in the server-rendered markup', () => {
    expect(serverControl('Highlight while reading')).toBeDisabled();
  });

  it('enables the transport control once the island has hydrated', () => {
    render(<BlogReadAloud />);

    expect(listenButton()).toBeEnabled();
  });

  it('enables the highlight toggle once the island has hydrated', () => {
    render(<BlogReadAloud />);

    expect(highlightToggle()).toBeEnabled();
  });

  it('carries the transport control disabled look as a paint-only variant of one class list', () => {
    const serverClasses = serverControl('Listen to this post').className;
    render(<BlogReadAloud />);

    // One class list across both states, dimming through the `disabled:`
    // variant, is what makes the dead window incapable of reflowing the band:
    // a conditional class swap could change the control's box, this cannot.
    expect(serverClasses).toContain('disabled:opacity-50');
    expect(serverClasses).toBe(listenButton().className);
  });

  it('carries the highlight toggle disabled look as a paint-only variant of one class list', () => {
    const serverClasses = serverControl('Highlight while reading').className;
    render(<BlogReadAloud />);

    expect(serverClasses).toContain('disabled:opacity-50');
    expect(serverClasses).toBe(highlightToggle().className);
  });
});

describe('BlogReadAloud — custom selector', () => {
  it('reads the container named by articleSelector', async () => {
    const user = userEvent.setup();
    document.body.innerHTML = '<section id="doc"><p>Hello.</p></section>';
    render(<BlogReadAloud articleSelector="#doc" />);

    await startReading(user);

    expect(readerOptions().container).toBe(document.querySelector('#doc'));
  });
});
