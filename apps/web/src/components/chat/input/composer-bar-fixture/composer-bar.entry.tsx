import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Button } from '@hushbox/ui/button';
import { ArrowUp, Globe, Icon, Image, Plus, Sparkles } from '@hushbox/ui/icons';
import { PromptInput } from '@/components/chat/input/prompt-input';
import { ComposerBar } from '@/components/chat/input/composer-bar';
import { Chip } from '@/components/shared/chip';
import { ModelChip } from '@/components/shared/model-chip';
import { showEffort } from './reasoning-effort-stub';
import './composer-bar.css';
import type { ChatModality } from '@hushbox/shared';

/**
 * Real-browser fixture for `composer-bar.browser.test.ts`. It mounts one of two things and
 * reads their geometry back:
 *
 * - the real `PromptInput` in a phone column's 1rem gutters, with the hooks that reach the
 *   catalog, the funding reads and the stores replaced by the stubs beside this file, so
 *   the bar holds today's real controls and today's real Send;
 * - the real `ComposerBar` in a bordered box of a set width, its slots filled with the
 *   composer chips, so each compaction step can be read on the controls it acts on.
 *
 * Test infrastructure, not shipped runtime, and not exempted from lint: it is served to a
 * real browser and never imported by the Node test process, so V8 coverage cannot observe
 * it executing; `apps/web/vitest.config.ts` excludes `src/**\/*-fixture/**` from the
 * coverage gate for that reason.
 */

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

interface ControlReading {
  /** The control's accessible label, or its text when it has none. */
  name: string;
  /** The bar slot it sits in, or `send`. */
  slot: string;
  box: Box;
  /** The text the control shows, read from the text a reader can see. */
  shownText: string;
  /** Whether any text inside the control is cut short by its box. */
  truncated: boolean;
}

interface ComposerReading {
  rootPx: number;
  composer: Box;
  field: Box;
  barGapPx: number;
  barPaddingInlinePx: number;
  /** Every bar control that takes up room, in document order. */
  controls: ControlReading[];
  /** How many lines the bar's controls sit on. */
  rows: number;
  pageScrollWidth: number;
}

interface ComposerOptions {
  effort: boolean;
  modality: ChatModality;
}

declare global {
  // Optional: unset until the entry has run — the property the driving test polls to know
  // the fixture page is ready.
  var __composerBar:
    | {
        mountComposer(options: ComposerOptions): void;
        mountChips(widthRem: number): void;
        read(): ComposerReading;
      }
    | undefined;
}

const PROMPT = 'Now add a pytest for two rows that share the same timestamp.';
const SEARCH = {
  webSearchEnabled: false,
  canUseWebSearch: true,
  onToggleWebSearch: (): undefined => undefined,
};

function boxOf(element: Element): Box {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    right: rect.right,
    top: rect.top,
    bottom: rect.bottom,
    width: rect.width,
  };
}

function takesRoom(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 1 && rect.height > 1;
}

function requireElement(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`the fixture has no ${selector}`);
  return element;
}

/** The text of every text node whose box a sighted reader can see. */
function shownText(control: Element): string {
  const walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (parent === null || !takesRoom(parent)) continue;
    if (getComputedStyle(parent).visibility === 'hidden') continue;
    parts.push(node.textContent ?? '');
  }
  return parts.join('').trim();
}

const SLOTS = ['mode', 'search', 'effort', 'model', 'estimate'] as const;
const SLOT_SELECTOR = SLOTS.map((slot) => `[data-slot="composer-${slot}"]`).join(', ');

/** The bar slot a control sits in; Send sits in the right group outside every slot. */
/** Whether a box inside the control holds more text than it shows. */
function isTruncated(control: Element): boolean {
  return [control, ...control.querySelectorAll('*')].some(
    (element) => takesRoom(element) && element.scrollWidth > element.clientWidth + 1
  );
}

/** Controls whose vertical centres lie apart by more than half a control share no line. */
function rowCount(controls: readonly ControlReading[]): number {
  const centres = controls
    .map((entry) => (entry.box.top + entry.box.bottom) / 2)
    .toSorted((a, b) => a - b);
  return centres.filter(
    (centre, index) => index === 0 || centre - (centres[index - 1] ?? centre) > 12
  ).length;
}

function slotOf(control: Element): string {
  const slot = control.closest<HTMLElement>(SLOT_SELECTOR)?.dataset['slot'];
  return slot?.replace(/^composer-/, '') ?? 'send';
}

function readControls(bar: Element): ControlReading[] {
  return [...bar.querySelectorAll('button, [role="button"]')]
    .filter(
      (control) =>
        takesRoom(control) &&
        control.closest('[aria-hidden="true"]') === null &&
        control.parentElement?.closest('button') == null
    )
    .map((control) => ({
      name: (control.getAttribute('aria-label') ?? control.textContent).trim(),
      slot: slotOf(control),
      box: boxOf(control),
      shownText: shownText(control),
      truncated: isTruncated(control),
    }));
}

function read(): ComposerReading {
  const composer = requireElement('[data-slot="composer"]');
  const field = requireElement('[data-slot="composer-field"]');
  const bar = requireElement('[data-slot="composer-bar"]');
  const barStyle = getComputedStyle(bar);
  const controls = readControls(bar);
  return {
    rootPx: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
    composer: boxOf(composer),
    field: boxOf(field),
    barGapPx: Number.parseFloat(barStyle.columnGap),
    barPaddingInlinePx: Number.parseFloat(barStyle.paddingLeft),
    controls,
    rows: rowCount(controls),
    pageScrollWidth: document.documentElement.scrollWidth,
  };
}

function RealComposer({ modality }: Readonly<{ modality: ChatModality }>): React.JSX.Element {
  const [value, setValue] = React.useState(PROMPT);
  return (
    <main className="px-4 pt-4">
      <PromptInput
        value={value}
        onChange={setValue}
        onSubmit={() => undefined}
        isAuthenticated
        activeModality={modality}
        onSelectModality={() => undefined}
        searchProps={modality === 'text' ? SEARCH : undefined}
      />
    </main>
  );
}

/** The composer chips in each slot, as the chip tasks draw them. */
function ChipBar(): React.JSX.Element {
  return (
    <ComposerBar
      modeControl={
        <>
          <Chip icon={Plus} iconOnly label="Change mode" />
          <Chip icon={Image} label="Image" pressed />
        </>
      }
      searchControl={<Chip icon={Globe} label="Search" pressed={false} />}
      effortControl={<Chip icon={Sparkles} label="Mid" />}
      modelControl={
        <ModelChip
          swatch={2}
          label="Claude Sonnet 4.5"
          shortLabel="Sonnet 4.5"
          expanded={false}
          onClick={() => undefined}
        />
      }
      estimate={
        <button type="button" className="text-ui-sm px-1 font-mono">
          ≈ $0.04
        </button>
      }
      send={
        <Button type="button" aria-label="Send" className="size-9 p-0 has-[>svg]:p-0">
          <Icon icon={ArrowUp} size="md-lg" />
        </Button>
      }
    />
  );
}

function ChipComposer({ widthRem }: Readonly<{ widthRem: number }>): React.JSX.Element {
  return (
    <main className="p-4">
      <div
        data-slot="composer"
        className="@container/composer relative"
        style={{ width: `${String(widthRem)}rem` }}
      >
        <div data-slot="composer-field" className="border-border-control rounded-xl border">
          <ChipBar />
        </div>
      </div>
    </main>
  );
}

let root: Root | undefined;

function render(node: React.ReactNode): void {
  root?.unmount();
  root = createRoot(requireElement('#root'));
  const mounted = root;
  flushSync(() => {
    mounted.render(node);
  });
}

globalThis.__composerBar = {
  mountComposer({ effort, modality }) {
    showEffort(effort);
    render(<RealComposer modality={modality} />);
  },
  mountChips(widthRem) {
    render(<ChipComposer widthRem={widthRem} />);
  },
  read,
};
