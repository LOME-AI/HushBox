// @vitest-environment jsdom
import * as React from 'react';
import { afterEach, describe, it, expect, vi, beforeEach, onTestFinished } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  MOBILE_BREAKPOINT,
  REASONING_EFFORT_DESCRIPTIONS,
  SMART_MODEL_ID,
  TEST_IDS,
  TEST_SIGNALS,
} from '@hushbox/shared';
import { noticeText } from '@hushbox/shared';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';
import {
  ReasoningEffortMenu,
  effortOptionsFrom,
} from '@/components/chat/input/reasoning-effort-menu';
import type { EffortModel } from '@/hooks/chat/use-reasoning-effort';

const { mockUseModels } = vi.hoisted(() => ({
  mockUseModels: vi.fn(() => ({ data: undefined as { models: EffortModel[] } | undefined })),
}));

vi.mock('@/hooks/models/models', () => ({
  useModels: mockUseModels,
}));

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };
function resetStub(overrides: Partial<ModelStoreStub> = {}): void {
  modelStoreStubRef.current = createModelStoreStub(overrides);
}

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = vi.fn((selector?: (s: ModelStoreStub) => unknown) =>
    selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current
  );
  (store as unknown as Record<string, unknown>)['setState'] = vi.fn();
  (store as unknown as Record<string, unknown>)['getState'] = () => modelStoreStubRef.current;
  return { ...actual, useModelStore: store };
});

import type { Availability, DimensionAvailability } from '@hushbox/shared';

const originalMatchMedia = globalThis.matchMedia;

/** A window one pixel under the desktop band, so the menu presents as a sheet. */
function installPhoneViewport(): void {
  const phoneQuery = `(max-width: ${String(MOBILE_BREAKPOINT - 1)}px)`;
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const list: Pick<
        MediaQueryList,
        'matches' | 'media' | 'addEventListener' | 'removeEventListener'
      > = {
        matches: query === phoneQuery,
        media: query,
        addEventListener: (): void => undefined,
        removeEventListener: (): void => undefined,
      };
      // The band and pointer hooks read only `matches` and the listener pair.
      return list as MediaQueryList;
    },
  });
}

afterEach(() => {
  Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
});

/** A produced effort dimension, exactly as `affordable.turnDimensions` carries it. */
function dim(rows: [string, string, boolean][]): DimensionAvailability {
  const options = rows.map(([optionId, label, available]) => ({
    optionId: optionId,
    label,
    availability: (available
      ? { available: true }
      : { available: false, reason: 'model_output_cap_too_low' }) satisfies Availability,
  }));
  const [first, ...rest] = options;
  if (first === undefined) throw new Error('a dimension always presents at least one option');
  return { dimensionId: 'effort', options: [first, ...rest] };
}

/** Effort-native model: high/medium/low ladder, generous context. */
const effortModel: EffortModel = {
  id: 'test-model',
  contextLength: 200_000,
  reasoning: { supportedEfforts: ['high', 'medium', 'low'] },
};

const plainModel: EffortModel = { id: 'test-model', contextLength: 8192 };

/** Budget-native sibling: offers the full five-rung ladder. */
const budgetNativeModel: EffortModel = {
  id: 'model-b',
  contextLength: 200_000,
  reasoning: {},
};

interface RenderMenuOptions {
  /** The produced dimension; defaults to a fully-available three-rung ladder. */
  dimension?: DimensionAvailability;
}

const DEFAULT_DIMENSION = dim([
  ['off', 'Min', true],
  ['low', 'Low', true],
  ['medium', 'Mid', true],
  ['high', 'High', true],
]);

const REFUSED_HIGH = dim([
  ['off', 'Min', true],
  ['low', 'Low', true],
  ['high', 'High', false],
]);

function renderMenu(options: RenderMenuOptions = {}): ReturnType<typeof render> {
  return render(<ReasoningEffortMenu effortDimension={options.dimension ?? DEFAULT_DIMENSION} />);
}

function setCatalog(models: EffortModel[]): void {
  mockUseModels.mockReturnValue({ data: { models } });
}

function chip(): HTMLElement {
  return screen.getByTestId(TEST_IDS.effortChip);
}

async function openMenu(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(chip());
  await screen.findByRole('menu');
}

function rung(name: string): HTMLElement {
  return screen.getByRole('menuitemradio', { name });
}

/** Each rung's accessible name in menu order: the element its `aria-labelledby` names. */
function rungNames(): string[] {
  return screen.getAllByRole('menuitemradio').map((row) => {
    const titleId = row.getAttribute('aria-labelledby') ?? '';
    return document.querySelector(`[id="${titleId}"]`)?.textContent ?? '';
  });
}

interface StubBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

// The root font is 16px here, so 0.5rem is 8px.
const VIEWPORT: StubBox = { left: 0, top: 0, width: 1024, height: 768 };
const CHIP: StubBox = { left: 150, top: 300, width: 70, height: 32 };
const COMPOSER: StubBox = { left: 100, top: 200, width: 600, height: 142 };
const MENU: StubBox = { left: 0, top: 0, width: 240, height: 260 };

/** Gives the chip, the composer and the open menu the boxes a laid-out page would. */
function stubBoxes(): void {
  const toRect = ({ left, top, width, height }: StubBox): DOMRect =>
    DOMRect.fromRect({ x: left, y: top, width, height });
  const isMenuBox = (element: HTMLElement): boolean =>
    'radixPopperContentWrapper' in element.dataset;
  const spies = [
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ): DOMRect {
      if (this.dataset['testid'] === TEST_IDS.effortChip) return toRect(CHIP);
      if (this.dataset['testid'] === 'composer-box') return toRect(COMPOSER);
      if (isMenuBox(this)) return toRect(MENU);
      if (this === document.documentElement || this === document.body) return toRect(VIEWPORT);
      return toRect({ left: 0, top: 0, width: 0, height: 0 });
    }),
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ): number {
      return this === document.documentElement ? VIEWPORT.width : 0;
    }),
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ): number {
      return this === document.documentElement ? VIEWPORT.height : 0;
    }),
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
      this: HTMLElement
    ): number {
      return isMenuBox(this) ? MENU.width : 0;
    }),
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ): number {
      return isMenuBox(this) ? MENU.height : 0;
    }),
  ];
  onTestFinished(() => {
    for (const spy of spies) spy.mockRestore();
  });
}

/** Where the positioning wrapper placed the open menu, as its translate's x and y. */
async function placedAt(): Promise<{ x: number; y: number }> {
  const menu = await screen.findByRole('menu');
  const wrapper = menu.closest<HTMLElement>('[data-radix-popper-content-wrapper]');
  let placed: { x: number; y: number } | undefined;
  await waitFor(() => {
    const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(wrapper?.style.transform ?? '');
    expect(match).not.toBeNull();
    placed = { x: Number(match?.[1]), y: Number(match?.[2]) };
  });
  if (placed === undefined) throw new Error('the menu was never placed');
  return placed;
}

describe("effortOptionsFrom — the producer's presented set, ordered", () => {
  it('renders the UNION, marking a rung only one sibling offers rather than hiding it', () => {
    // The intersection clamp this replaced was wrong in BOTH directions on one
    // selection. Sibling A offers {low, high}; sibling B adds {medium}.
    //   intersection = {low, high} → `medium` VANISHES from the menu, even
    //     though per-model resolution falls downward so the turn can honour it.
    //   producer     = {off, low, medium, high}, each graded by the same query
    //     the send gate runs — so `high` can be PRESENT AND GREYED when neither
    //     sibling can fund it, which the intersection would have enabled.
    const dimension = dim([
      ['off', 'Min', true],
      ['low', 'Low', true],
      ['medium', 'Mid', false],
      ['high', 'High', false],
    ]);

    const options = effortOptionsFrom(dimension);

    // Membership is the producer's: the union-only rung is present.
    expect(options.map((option) => option.selection)).toEqual([
      'auto',
      'high',
      'medium',
      'low',
      'off',
    ]);
    // And it is MARKED, not hidden — greyed-never-hidden, every tier.
    expect(options.find((option) => option.selection === 'medium')?.availability).toEqual({
      available: false,
      reason: 'model_output_cap_too_low',
    });
    // A rung both siblings name but neither can fund stays refused.
    expect(options.find((option) => option.selection === 'high')?.availability.available).toBe(
      false
    );
  });

  it('orders Auto first, rungs strongest-first, Min last — order is presentation only', () => {
    const options = effortOptionsFrom(
      dim([
        ['off', 'Min', true],
        ['low', 'Low', true],
        ['high', 'High', true],
      ])
    );

    expect(options.map((option) => option.selection)).toEqual(['auto', 'high', 'low', 'off']);
  });

  it('keeps Auto selectable with no dimension at all — it delegates the choice', () => {
    expect(effortOptionsFrom()).toEqual([{ selection: 'auto', availability: { available: true } }]);
  });

  it('omits Min when no selected model can disable reasoning', () => {
    const options = effortOptionsFrom(
      dim([
        ['low', 'Low', true],
        ['high', 'High', true],
      ])
    );

    expect(options.map((option) => option.selection)).toEqual(['auto', 'high', 'low']);
  });
});

describe('ReasoningEffortMenu', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'auto',
      enabledEffortChoices: undefined,
    });
    resetStub();
    setCatalog([effortModel]);
  });

  describe('the graded set this control publishes', () => {
    it('publishes exactly the choices the dimension it greys from enables', () => {
      renderMenu({
        dimension: dim([
          ['low', 'Low', true],
          ['medium', 'Mid', true],
          ['high', 'High', false],
        ]),
      });

      expect(useReasoningEffortStore.getState().enabledEffortChoices).toEqual(['low', 'medium']);
    });

    it('publishes nothing while no verdict exists, so an absent read greys nothing', () => {
      render(<ReasoningEffortMenu effortDimension={undefined} />);

      expect(useReasoningEffortStore.getState().enabledEffortChoices).toBeUndefined();
    });

    it('publishes even while the chip is hidden — a ladderless turn still owes an answer', () => {
      setCatalog([plainModel]);

      renderMenu({ dimension: dim([['low', 'Low', true]]) });

      expect(screen.queryByTestId(TEST_IDS.effortChip)).not.toBeInTheDocument();
      expect(useReasoningEffortStore.getState().enabledEffortChoices).toEqual(['low']);
    });
  });

  describe('the chip', () => {
    it('renders no chip for a non-reasoning model', () => {
      setCatalog([plainModel]);
      renderMenu();
      expect(screen.queryByTestId(TEST_IDS.effortChip)).not.toBeInTheDocument();
    });

    it('renders the chip for the Smart Model sentinel, so the slot can be pinned', () => {
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'high' });
      resetStub({
        selections: {
          text: [{ id: SMART_MODEL_ID, name: 'Smart' }],
          image: [],
          audio: [],
          video: [],
        },
      });
      // The catalog carries a candidate beside the sentinel: the slot's rungs are
      // the rungs the models it could resolve to declare, so a catalog holding the
      // sentinel alone describes a slot that could become nothing.
      setCatalog([{ id: SMART_MODEL_ID, contextLength: 0 }, effortModel]);
      renderMenu();
      expect(chip()).toHaveAccessibleName('Reasoning effort: High');
    });

    it('renders no chip on a non-text modality', () => {
      resetStub({ activeModality: 'image' });
      renderMenu();
      expect(screen.queryByTestId(TEST_IDS.effortChip)).not.toBeInTheDocument();
    });

    it('is named "Reasoning effort: Auto" by default', () => {
      renderMenu();
      expect(chip()).toHaveAccessibleName('Reasoning effort: Auto');
    });

    it('names the active level word', () => {
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'medium' });
      renderMenu();
      expect(chip()).toHaveAccessibleName('Reasoning effort: Mid');
    });

    it('shows the effective word as its label', () => {
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'medium' });
      renderMenu();
      const shown = [...chip().querySelectorAll('span')].filter(
        (node) => node.childElementCount === 0 && node.closest('[aria-hidden="true"]') === null
      );
      expect(shown.map((node) => node.textContent)).toEqual(['Mid']);
    });

    it('draws the gauge icon', () => {
      renderMenu();
      expect(chip().querySelector('svg.lucide-gauge')).not.toBeNull();
    });

    it('announces that it opens a menu', () => {
      renderMenu();
      expect(chip()).toHaveAttribute('aria-haspopup', 'menu');
    });

    it('reports itself expanded while its menu is open', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      expect(chip()).toHaveAttribute('aria-expanded', 'true');
    });

    it('shows the LOWERED word when the graded set disables the stored level', () => {
      // The greying and the value the send carries are one answer: a rung the
      // producer marked unavailable must not be what the chip reads back.
      useReasoningEffortStore.setState({
        preferredReasoningEffort: 'high',
        enabledEffortChoices: ['off', 'low', 'medium'],
      });
      renderMenu({
        dimension: dim([
          ['off', 'Min', true],
          ['low', 'Low', true],
          ['medium', 'Mid', true],
          ['high', 'High', false],
        ]),
      });
      expect(chip()).toHaveAccessibleName('Reasoning effort: Mid');
      expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('high');
    });

    it('lowers to the nearest offered rung when the preferred level is not offered', () => {
      // A preference the selection cannot serve walks DOWN to the nearest rung it
      // does offer, and reaches `auto` only when it offers none below — the same
      // rule the graded set's lowering follows (`docs/BILLING.md` §Reasoning
      // Effort 3), asked before any funding verdict exists.
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'max' });
      renderMenu();
      expect(chip()).toHaveAccessibleName('Reasoning effort: High');
    });

    it('reserves the widest word inside the chip so its width never changes', () => {
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'low' });
      renderMenu();
      // Every word is stacked invisibly in the same grid cell, so the chip is
      // always as wide as the widest word, regardless of selection.
      // 'Min' is the OFF row's display word (selection value `off`).
      for (const word of ['Auto', 'Lite', 'Low', 'Mid', 'High', 'Max', 'Min']) {
        const ghost = [...chip().querySelectorAll('[aria-hidden="true"]')].find(
          (node) => node.textContent === word
        );
        expect(ghost, `ghost for ${word}`).toBeDefined();
        expect(ghost?.className).toContain('invisible');
        expect(ghost?.className).toContain('col-start-1');
        expect(ghost?.className).toContain('row-start-1');
      }
      // The ghosts never leak into the accessible name.
      expect(chip()).toHaveAccessibleName('Reasoning effort: Low');
    });

    it('carries no money figure', () => {
      renderMenu();
      expect(chip().textContent).not.toContain('$');
    });
  });

  describe('its menu', () => {
    it('lists full-word rungs, Auto first and Min (the off row) last', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      expect(rungNames()).toEqual(['Auto', 'High', 'Mid', 'Low', 'Min']);
    });

    it('describes each rung by its line from the shared descriptions', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      expect(rung('High')).toHaveAccessibleDescription(REASONING_EFFORT_DESCRIPTIONS.high);
      expect(rung('Mid')).toHaveAccessibleDescription(REASONING_EFFORT_DESCRIPTIONS.medium);
      expect(rung('Min')).toHaveAccessibleDescription(REASONING_EFFORT_DESCRIPTIONS.off);
      expect(rung('Auto')).toHaveAccessibleDescription(REASONING_EFFORT_DESCRIPTIONS.auto);
    });

    it("shows each description as the row's second line", async () => {
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      expect(within(rung('Low')).getByText(REASONING_EFFORT_DESCRIPTIONS.low)).toBeVisible();
    });

    it('draws its rungs at the compact density, so the whole ladder fits below the composer', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      for (const name of rungNames()) {
        expect(rung(name)).toHaveClass('py-1.25');
      }
    });

    it('carries no money figure on any rung', async () => {
      const user = userEvent.setup();
      renderMenu({ dimension: REFUSED_HIGH });
      await openMenu(user);
      expect(screen.getByRole('menu').textContent).not.toContain('$');
    });

    it('opens below the chip', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      expect(screen.getByRole('menu')).toHaveAttribute('data-side', 'bottom');
    });

    it("opens 0.5rem below the element it is anchored to, at that element's left edge", async () => {
      stubBoxes();
      const anchor = document.createElement('div');
      anchor.dataset['testid'] = 'composer-box';
      document.body.append(anchor);
      const user = userEvent.setup();
      render(
        <ReasoningEffortMenu effortDimension={DEFAULT_DIMENSION} anchor={{ current: anchor }} />
      );

      await openMenu(user);

      expect(await placedAt()).toEqual({ x: COMPOSER.left, y: COMPOSER.top + COMPOSER.height + 8 });
      anchor.remove();
    });

    it('marks the effective selection as the checked rung', async () => {
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'medium' });
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      expect(rung('Mid')).toHaveAttribute('aria-checked', 'true');
      expect(rung('Auto')).toHaveAttribute('aria-checked', 'false');
    });

    it("draws the chosen rung's check in muted ink, not the dropdown's dot", async () => {
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'medium' });
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      const check = rung('Mid').querySelector('svg.lucide-check');
      expect(check).not.toBeNull();
      expect(check).toHaveClass('text-muted-foreground');
      expect(rung('Mid').querySelector('svg.lucide-circle')).toBeNull();
    });

    it('checks the lowered row, not the stored one', async () => {
      const user = userEvent.setup();
      useReasoningEffortStore.setState({
        preferredReasoningEffort: 'high',
        enabledEffortChoices: ['off', 'low', 'medium'],
      });
      renderMenu({
        dimension: dim([
          ['off', 'Min', true],
          ['low', 'Low', true],
          ['medium', 'Mid', true],
          ['high', 'High', false],
        ]),
      });
      await openMenu(user);
      expect(rung('Mid')).toHaveAttribute('aria-checked', 'true');
      expect(rung('High')).toHaveAttribute('aria-checked', 'false');
    });

    it('selects a level with a single click', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      await user.click(rung('Low'));
      expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('low');
    });

    it('closes once a level is chosen', async () => {
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      await user.click(rung('Low'));
      expect(screen.queryByRole('menuitemradio', { name: 'Low' })).not.toBeInTheDocument();
    });

    it('keeps Auto selectable when the stored level is greyed', async () => {
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'low' });
      const user = userEvent.setup();
      renderMenu();
      await openMenu(user);
      expect(rung('Auto')).not.toHaveAttribute('aria-disabled');
      await user.click(rung('Auto'));
      expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('auto');
    });

    it('renders the ladder union across a heterogeneous selection with union-only levels greyed', async () => {
      resetStub({
        selections: {
          text: [
            { id: 'test-model', name: 'A' },
            { id: 'model-b', name: 'B' },
          ],
          image: [],
          audio: [],
          video: [],
        },
      });
      setCatalog([effortModel, budgetNativeModel]);
      const user = userEvent.setup();
      renderMenu({
        dimension: dim([
          ['off', 'Min', true],
          ['lite', 'Lite', true],
          ['low', 'Low', true],
          ['medium', 'Mid', true],
          ['high', 'High', true],
          ['max', 'Max', false],
        ]),
      });
      await openMenu(user);
      expect(rungNames()).toEqual(['Auto', 'Max', 'High', 'Mid', 'Low', 'Lite', 'Min']);
      expect(rung('Max')).toHaveAttribute('aria-disabled', 'true');
      expect(rung('Max')).toHaveAccessibleDescription(noticeText('model_output_cap_too_low'));
    });
  });

  // The menu takes no auth input at all, so greying cannot vary by tier —
  // trial and guest users see the same greyed-never-hidden ladder.
  describe('a refused rung', () => {
    it('is marked aria-disabled while a feasible one stays enabled', async () => {
      const user = userEvent.setup();
      renderMenu({ dimension: REFUSED_HIGH });
      await openMenu(user);
      expect(rung('High')).toHaveAttribute('aria-disabled', 'true');
      expect(rung('Low')).not.toHaveAttribute('aria-disabled');
    });

    it('is described by the SHARED reason in place of its line', async () => {
      const user = userEvent.setup();
      renderMenu({ dimension: REFUSED_HIGH });
      await openMenu(user);
      // The one home for money copy — not a sentence this component authors.
      expect(rung('High')).toHaveAccessibleDescription(noticeText('model_output_cap_too_low'));
    });

    it('shows its reason in the row, in muted ink', async () => {
      const user = userEvent.setup();
      renderMenu({ dimension: REFUSED_HIGH });
      await openMenu(user);
      const reason = within(rung('High')).getByText(noticeText('model_output_cap_too_low'));
      expect(reason).toBeVisible();
      expect(reason).toHaveClass('text-muted-foreground');
    });

    it('dims only its word, never the whole row', async () => {
      const user = userEvent.setup();
      renderMenu({ dimension: REFUSED_HIGH });
      await openMenu(user);
      expect(rung('High').className).not.toMatch(/opacity-/u);
    });

    it('stays reachable from the keyboard', async () => {
      const user = userEvent.setup();
      renderMenu({ dimension: REFUSED_HIGH });
      await openMenu(user);
      act(() => {
        rung('Auto').focus();
      });
      await user.keyboard('{ArrowDown}');
      expect(rung('High')).toHaveFocus();
    });

    it('ignores activation', async () => {
      const user = userEvent.setup();
      renderMenu({ dimension: REFUSED_HIGH });
      await openMenu(user);
      await user.click(rung('High'));
      expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('auto');
    });
  });

  describe('below 768px', () => {
    it('opens a sheet named "Reasoning effort"', async () => {
      installPhoneViewport();
      const user = userEvent.setup();
      renderMenu();
      await user.click(chip());
      expect(await screen.findByRole('dialog', { name: 'Reasoning effort' })).toBeInTheDocument();
    });

    it('draws the sheet with no head', async () => {
      installPhoneViewport();
      const user = userEvent.setup();
      renderMenu();
      await user.click(chip());
      const sheet = await screen.findByRole('dialog', { name: 'Reasoning effort' });
      // The sheet keeps its name for readers only; no title row is drawn.
      for (const title of within(sheet).queryAllByText('Reasoning effort')) {
        expect(title).toHaveClass('sr-only');
      }
      expect(within(sheet).queryByRole('button', { name: /close/iu })).not.toBeInTheDocument();
    });

    it('keeps the rungs as radio items in the sheet', async () => {
      installPhoneViewport();
      useReasoningEffortStore.setState({ preferredReasoningEffort: 'medium' });
      const user = userEvent.setup();
      renderMenu();
      await user.click(chip());
      await screen.findByRole('dialog', { name: 'Reasoning effort' });
      expect(rung('Mid')).toHaveAttribute('aria-checked', 'true');
    });

    it('selects the rung chosen in the sheet', async () => {
      installPhoneViewport();
      const user = userEvent.setup();
      renderMenu();
      await user.click(chip());
      await screen.findByRole('dialog', { name: 'Reasoning effort' });
      fireEvent.click(rung('Low'));
      expect(useReasoningEffortStore.getState().preferredReasoningEffort).toBe('low');
    });
  });

  describe('opened by its caller', () => {
    it('opens while its open prop is set', async () => {
      render(
        <ReasoningEffortMenu effortDimension={DEFAULT_DIMENSION} open onOpenChange={vi.fn()} />
      );
      expect(await screen.findByRole('menu')).toBeInTheDocument();
    });

    it('returns focus to its fallback on close while its chip draws no box', async () => {
      // This DOM draws no boxes, so the chip stands in for one a narrow composer hides.
      function WithFallback(): React.JSX.Element {
        const fallback = React.useRef<HTMLButtonElement>(null);
        const [open, setOpen] = React.useState(true);
        return (
          <>
            <button ref={fallback} type="button">
              Change mode
            </button>
            <ReasoningEffortMenu
              effortDimension={DEFAULT_DIMENSION}
              open={open}
              onOpenChange={setOpen}
              fallbackFocus={fallback}
            />
          </>
        );
      }
      const user = userEvent.setup();
      render(<WithFallback />);
      await screen.findByRole('menu');

      await user.keyboard('{Escape}');

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Change mode' })).toHaveFocus();
      });
    });

    it('reports an open from its chip', async () => {
      const onOpenChange = vi.fn();
      const user = userEvent.setup();
      render(
        <ReasoningEffortMenu
          effortDimension={DEFAULT_DIMENSION}
          open={false}
          onOpenChange={onOpenChange}
        />
      );
      await user.click(chip());
      expect(onOpenChange).toHaveBeenCalledWith(true);
    });
  });

  describe('the slide wrapper', () => {
    it('keeps a collapsed slide wrapper mounted while the chip is hidden', () => {
      setCatalog([plainModel]);
      const { container } = renderMenu();
      const wrapper = container.firstElementChild;
      expect(wrapper).not.toBeNull();
      expect(wrapper?.className).toContain('transition-[grid-template-columns]');
      expect(wrapper?.className).toContain('grid-cols-[0fr]');
    });

    it('expands the slide wrapper when the chip is visible', () => {
      const { container } = renderMenu();
      const wrapper = container.firstElementChild;
      expect(wrapper?.className).toContain('grid-cols-[1fr]');
      expect(wrapper?.className).toContain('transition-[grid-template-columns]');
    });

    it('leaves the slide to the global reduced-motion kill (no motion-reduce override)', () => {
      // html.reduced-motion forces 0.01ms transitions but PRESERVES transitionend
      // (event-ordering by design); a motion-reduce:transition-none override
      // would drop the event and strand the outgoing chip — so it must not exist.
      const { container } = renderMenu();
      expect(container.firstElementChild?.className).not.toContain('motion-reduce');
    });

    it('keeps the outgoing chip mounted and inert until the collapse transition ends', () => {
      const view = renderMenu();
      expect(chip()).toBeInTheDocument();
      setCatalog([plainModel]);
      view.rerender(<ReasoningEffortMenu effortDimension={DEFAULT_DIMENSION} />);
      const wrapper = view.container.firstElementChild as HTMLElement;
      expect(wrapper.className).toContain('grid-cols-[0fr]');
      // Stale chip still slides out: present but inert (aria-hidden ancestor).
      expect(chip().closest('[aria-hidden="true"]')).not.toBeNull();
      fireEvent.transitionEnd(wrapper);
      expect(screen.queryByTestId(TEST_IDS.effortChip)).not.toBeInTheDocument();
    });

    it('ignores bubbled transitionend events from inner content during the collapse', () => {
      const view = renderMenu();
      setCatalog([plainModel]);
      view.rerender(<ReasoningEffortMenu effortDimension={DEFAULT_DIMENSION} />);
      const wrapper = view.container.firstElementChild as HTMLElement;
      const inner = wrapper.firstElementChild as HTMLElement;
      // A child transition (e.g. a hover color) bubbling up must not end the
      // slide early — only the wrapper's own grid-columns transition counts.
      fireEvent.transitionEnd(inner);
      expect(chip()).toBeInTheDocument();
      fireEvent.transitionEnd(wrapper);
      expect(screen.queryByTestId(TEST_IDS.effortChip)).not.toBeInTheDocument();
    });

    it('leaves the slide state alone when a transition ends while the chip is visible', () => {
      const view = renderMenu();
      const wrapper = view.container.firstElementChild as HTMLElement;
      fireEvent.transitionEnd(wrapper);
      expect(chip()).toBeInTheDocument();
      expect(wrapper.className).toContain('grid-cols-[1fr]');
    });

    it('publishes the control as present while the chip is visible', () => {
      const view = renderMenu();
      const wrapper = view.container.firstElementChild as HTMLElement;
      expect(wrapper).toHaveAttribute(TEST_SIGNALS.effortControl, 'present');
    });

    it('publishes the control as collapsing while the outgoing chip is still mounted', () => {
      // The window this signal exists for: the chip is on its way out and still
      // carries the previous ladder under the same test id, so a point-in-time
      // visibility read grades the model that was just replaced.
      const view = renderMenu();
      setCatalog([plainModel]);
      view.rerender(<ReasoningEffortMenu effortDimension={DEFAULT_DIMENSION} />);
      const wrapper = view.container.firstElementChild as HTMLElement;
      expect(chip()).toBeInTheDocument();
      expect(wrapper).toHaveAttribute(TEST_SIGNALS.effortControl, 'collapsing');
    });

    it('publishes the control as absent once the collapse transition has ended', () => {
      const view = renderMenu();
      setCatalog([plainModel]);
      view.rerender(<ReasoningEffortMenu effortDimension={DEFAULT_DIMENSION} />);
      const wrapper = view.container.firstElementChild as HTMLElement;
      fireEvent.transitionEnd(wrapper);
      expect(screen.queryByTestId(TEST_IDS.effortChip)).not.toBeInTheDocument();
      expect(wrapper).toHaveAttribute(TEST_SIGNALS.effortControl, 'absent');
    });

    it('publishes the control as absent for a model that never offered a ladder', () => {
      setCatalog([plainModel]);
      const view = renderMenu();
      const wrapper = view.container.firstElementChild as HTMLElement;
      expect(wrapper).toHaveAttribute(TEST_SIGNALS.effortControl, 'absent');
    });
  });
});

describe('single-choice model — Auto stays selectable (§Reasoning Effort 10c)', () => {
  beforeEach(() => {
    useReasoningEffortStore.setState({
      preferredReasoningEffort: 'auto',
      enabledEffortChoices: undefined,
    });
    resetStub();
    setCatalog([effortModel]);
  });

  /**
   * A model offering exactly ONE distinct resolved rung buys no classifier
   * call: the choice is deterministic. Auto must remain selectable anyway —
   * it means "let the turn decide", and with one option that decision is
   * simply made without a call. Disabling Auto here would tell the user their
   * persisted preference is invalid on a model that honours it perfectly.
   */
  it('renders Auto enabled beside the single rung', () => {
    const options = effortOptionsFrom(dim([['high', 'High', true]]));

    expect(options).toEqual([
      { selection: 'auto', availability: { available: true } },
      { selection: 'high', availability: { available: true } },
    ]);
  });

  it('keeps Auto enabled even when the one rung is refused', () => {
    // Auto is never graded by the producer — it is not an option in the
    // dimension, it is the absence of a pin. So it survives a rung that does not.
    const options = effortOptionsFrom(dim([['high', 'High', false]]));

    expect(options[0]).toEqual({ selection: 'auto', availability: { available: true } });
    expect(options[1]?.availability.available).toBe(false);
  });

  it('renders Auto selectable in the menu with a single-rung ladder', async () => {
    const user = userEvent.setup();
    renderMenu({ dimension: dim([['high', 'High', true]]) });
    await openMenu(user);

    expect(rungNames()).toEqual(['Auto', 'High']);
    expect(screen.getByRole('menuitemradio', { name: 'Auto' })).not.toHaveAttribute(
      'aria-disabled'
    );
  });
});
