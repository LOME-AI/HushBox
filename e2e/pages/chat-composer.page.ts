import { type Locator } from '@playwright/test';
import { TEST_IDS, TEST_ID_BUILDERS, TEST_SIGNALS, type ChatModality } from '@hushbox/shared';
import { expect } from '../helpers/expect.js';
import { TIMEOUTS } from '../config/timeouts.js';
import { ChatShellPage, escapeAttributeValue } from './chat-shell.page.js';

const MODEL_ITEM_PREFIX = `[data-testid^="${TEST_ID_BUILDERS.modelItem('')}"]`;
const LOCK_ICON_SELECTOR = `[data-testid="${TEST_IDS.lockIcon}"]`;

/** The mode menu's name, which its "+" carries and the phone sheet's title repeats. */
const MODE_MENU_NAME = 'Change mode';

/** The effort menu's name: its title in the phone sheet, the chip's "Reasoning effort: <word>" when anchored. */
const EFFORT_MENU_NAME = /^Reasoning effort/u;

/** The model chip's accessible name while several models are selected: it ends " + N". */
const SEVERAL_MODELS_LABEL = / \+ \d+$/u;

/** The action a picker row's main button names before its model: one per picker mode. */
const ROW_BUTTON_ACTION = /^(?:Use|Toggle selection for) /u;

/** The composer's ratio chip names itself "Aspect ratio: <ratio>", and its popover "Aspect ratio". */
const RATIO_CHIP_NAME = 'Aspect ratio';
const RATIO_CHIP_PATTERN = new RegExp(`^${RATIO_CHIP_NAME}: `, 'u');

/** Video's phone summary chip, which opens its generation settings sheet. */
const VIDEO_SUMMARY_CHIP_PATTERN = /^Video settings:/u;

/** The open generation settings: the image ratio popover, or video's phone sheet. */
const GENERATION_SETTINGS_NAME = new RegExp(`^${RATIO_CHIP_NAME}$|generation settings$`, 'iu');

/** The image ratio grid's tile that opens the ratios beyond the common ten. */
const MORE_RATIOS_NAME = /^\d+ more$/u;

/** Each mode's item name in the mode menu. */
const MODE_TITLES: Readonly<Record<ChatModality, string>> = {
  text: 'Text',
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
};

/**
 * An element's accessible name, read from its ARIA snapshot: the same observation
 * `toHaveAccessibleName` makes, taken once.
 */
async function accessibleNameOf(locator: Locator): Promise<string> {
  const snapshot = await locator.ariaSnapshot();
  const name = /"(?<name>[^"]*)"/u.exec(snapshot)?.groups?.['name'];
  if (name === undefined) {
    throw new Error(`the element exposes no accessible name: ${snapshot}`);
  }
  return name;
}

/**
 * Selects every selectable non-premium model row in the picker: any
 * `model-item-*` that isn't the Smart Model and doesn't carry a lock icon.
 * Derived entirely from the registry so a renamed id/builder breaks here too.
 */
const NON_PREMIUM_MODEL_ITEMS =
  MODEL_ITEM_PREFIX +
  `:not([data-testid="${TEST_ID_BUILDERS.modelItem('smart-model')}"])` +
  `:not(:has(${LOCK_ICON_SELECTOR}))`;

/**
 * The composer region: the prompt input and its send, the queued-message pills,
 * the modality switch and its generation settings, the model picker and the
 * effort chip.
 */
export class ChatComposerPage extends ChatShellPage {
  /**
   * Trap for tests asserting on transient streaming UI (classifier indicator,
   * first tokens, etc.): this method triggers a /chat → /chat/<new-id>
   * navigation that remounts MessageList. react-virtuoso applies
   * `visibility: hidden` to its item-list during its initial measure-and-scroll,
   * so content is in DOM but invisible during that ~1s window. Prefer a seeded
   * conversation (testConversation fixture) + sendFollowUpMessage instead.
   */
  async sendNewChatMessage(message: string): Promise<void> {
    await this.waitForAppStable();
    await this.promptInput.fill(message);
    await expect(this.sendButton).toBeEnabled({ timeout: TIMEOUTS.STREAM });
    await this.sendButton.click();
  }

  async sendFollowUpMessage(message: string): Promise<void> {
    await this.messageInput.fill(message);
    // Wait for streaming to complete (button enabled means canSubmit = true)
    await expect(this.sendButton).toBeEnabled({ timeout: TIMEOUTS.STREAM });
    await this.messageInput.press('Enter');
    await expect(this.messageInput).toHaveValue('');
  }

  async expectNewChatPageVisible(): Promise<void> {
    await expect(this.newChatPage).toBeVisible();
  }

  async expectPromptInputVisible(): Promise<void> {
    await expect(this.promptInput).toBeVisible();
  }

  async expectSuggestionChipsVisible(): Promise<void> {
    await expect(this.suggestionChips).toBeVisible();
  }

  // --- Message queue (pending sends while a run streams) ---

  /**
   * The queued-messages region above the composer. Only mounted while at least
   * one message is queued, so `not.toBeVisible()` on it proves the queue drained.
   */
  queuedRegion(): Locator {
    return this.page.getByTestId(TEST_IDS.queuedMessages);
  }

  /** The queued-message pill at `index` (0 = oldest, sends next). */
  queuedPill(index: number): Locator {
    return this.page.getByTestId(TEST_ID_BUILDERS.queuedMessageItem(index));
  }

  /** Number of queued pills currently rendered (0 when the region is unmounted). */
  async queuedPillCount(): Promise<number> {
    return this.queuedRegion().getByRole('listitem').count();
  }

  /** Cancel (dequeue) the queued pill at `index` via its X control. */
  async cancelQueuedPill(index: number): Promise<void> {
    await this.page.getByTestId(TEST_ID_BUILDERS.queuedMessageCancel(index)).click();
  }

  /**
   * Enqueue `text` while a run is streaming: type it and submit. During
   * `isProcessing` the composer routes Enter to the queue (onQueue) and clears
   * the input, so the text becomes a pending pill rather than a sent turn. Gate
   * on `waitForStreamingActive()` first so the run is genuinely in-flight —
   * submitting once the run has settled would send the message instead.
   */
  async enqueueWhileStreaming(text: string): Promise<void> {
    await this.messageInput.fill(text);
    await this.messageInput.press('Enter');
    await expect(this.messageInput).toHaveValue('');
  }

  /** The composer's "+" that opens the mode menu. */
  get modeMenuButton(): Locator {
    return this.page.getByTestId(TEST_IDS.modeMenuButton);
  }

  /** The open mode menu: anchored from 768px, inside a bottom sheet below it. */
  get modeMenu(): Locator {
    return this.page.getByRole('menu', { name: MODE_MENU_NAME });
  }

  /** One mode in the open mode menu, found by the same role and name in either presentation. */
  modeMenuItem(modality: ChatModality): Locator {
    return this.modeMenu.getByRole('menuitemradio', { name: MODE_TITLES[modality], exact: true });
  }

  /** Opens the mode menu from the composer's "+". */
  async openModeMenu(): Promise<void> {
    await this.waitForAppStable();
    await this.modeMenuButton.click();
    await expect(this.modeMenu).toBeVisible();
  }

  /** Puts the composer in `modality` through the "+" mode menu, which closes on the choice. */
  async selectMode(modality: ChatModality): Promise<void> {
    await this.openModeMenu();
    await this.modeMenuItem(modality).click();
    await expect(this.modeMenu).toBeHidden();
  }

  /** Switch the prompt input to image generation modality through the mode menu. */
  async switchToImageMode(): Promise<void> {
    await this.selectMode('image');
    // Confirmation: the composer's ratio chip, named for the default ratio.
    await expect(this.page.getByRole('button', { name: `${RATIO_CHIP_NAME}: 1:1` })).toBeVisible();
  }

  /** Switch the prompt input back to the text modality through the mode menu. */
  async switchToTextMode(): Promise<void> {
    await this.selectMode('text');
    // Confirmation: the image/video config pills unmount once text is active.
    await expect(this.page.getByRole('button', { name: /1:1|720p/i })).not.toBeVisible();
  }

  /** Switch the prompt input to video generation modality through the mode menu. */
  async switchToVideoMode(): Promise<void> {
    await this.selectMode('video');
    // Confirmation: either the inline 720p resolution pill (desktop) or the
    // GenerationSummaryChip (mobile, name embeds the default "720p"). Either
    // layout satisfies the substring match.
    await expect(this.page.getByRole('button', { name: /720p/i })).toBeVisible();
  }

  /**
   * The open generation settings, whichever surface holds them: image's "Aspect
   * ratio" popover (anchored, or a sheet below 768px), or video's phone sheet,
   * named "Video generation settings". Both expose `role=dialog` by that name,
   * which keeps them apart from the other dialogs that may share the tree.
   */
  private generationSettings(): Locator {
    return this.page.getByRole('dialog', { name: GENERATION_SETTINGS_NAME });
  }

  /**
   * Opens the generation settings when a control opens them and they are shut:
   * image's ratio chip, at every width, or video's summary chip, below 768px. A
   * no-op where the controls sit inline (video from 768px) and when the settings
   * are already open.
   *
   * Uses `waitFor` so a still-mounting DOM (e.g. caller invoked the helper
   * before the modality-switch render had committed) doesn't race a one-shot
   * `count()` and short-circuit into the wrong branch. Open settings either mark
   * the ratio chip expanded or, as a modal sheet, hide their chip from the
   * accessibility tree, so the chips are looked for only in their closed state
   * and the open case falls through to the no-op branch.
   */
  async openGenerationSheetIfNeeded(): Promise<void> {
    const control = this.page
      .getByRole('button', { name: RATIO_CHIP_PATTERN, expanded: false })
      .or(this.page.getByRole('button', { name: VIDEO_SUMMARY_CHIP_PATTERN }));
    const present = await control
      .first()
      .waitFor({ state: 'visible', timeout: TIMEOUTS.MODAL })
      .then(() => true)
      .catch(() => false);
    if (!present) return;
    await control.first().click();
    await expect(this.generationSettings()).toBeVisible();
  }

  /**
   * Closes the generation settings if they're open. No-op otherwise. Tests call
   * this between configuring generation settings and sending the prompt, so the
   * settings don't block the composer interaction.
   *
   * The presence probe is short by design: where the controls sit inline the
   * settings are never mounted, so the wait times out into the no-op branch and
   * shouldn't stall the suite.
   */
  async closeGenerationSheetIfOpen(): Promise<void> {
    const settings = this.generationSettings();
    const open = await settings
      .waitFor({ state: 'visible', timeout: TIMEOUTS.QUICK })
      .then(() => true)
      .catch(() => false);
    if (!open) return;
    await this.page.keyboard.press('Escape');
    await expect(settings).not.toBeVisible();
  }

  /**
   * Click an aspect-ratio option ('1:1' | '16:9' | '9:16' | '4:5' etc). A ratio
   * outside the image grid's common ten is reached through its "N more" tile.
   */
  async selectAspectRatio(ratio: string): Promise<void> {
    await this.openGenerationSheetIfNeeded();
    const pill = this.page.getByRole('button', { name: ratio, exact: true });
    const more = this.page.getByRole('button', { name: MORE_RATIOS_NAME });
    if (!(await pill.isVisible()) && (await more.isVisible())) {
      await more.click();
    }
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
  }

  /**
   * Click a video resolution toggle pill ('720p' | '1080p' | '4k'). The pill's
   * accessible name is the bare resolution string — the visible "HD"/"FHD"
   * label and price live elsewhere in the row. Exact match avoids colliding
   * with the mobile `GenerationSummaryChip`, whose name embeds the resolution.
   */
  async selectResolution(resolution: '720p' | '1080p' | '4k'): Promise<void> {
    await this.openGenerationSheetIfNeeded();
    const pill = this.page.getByRole('button', { name: resolution, exact: true });
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(pill).toHaveAttribute('aria-pressed', 'true');
  }

  /** Drag the video duration slider to N seconds (uses keyboard for determinism). */
  async setVideoDuration(seconds: number): Promise<void> {
    await this.openGenerationSheetIfNeeded();
    const slider = this.page.getByRole('slider', { name: /video duration in seconds/i });
    await expect(slider).toBeVisible();
    await slider.focus();
    // Range inputs are controlled by React state; setting `input.value` alone
    // is overwritten on the next render. Use the native HTMLInputElement value
    // setter so React's onChange synthetic event picks up the new value.
    await slider.evaluate((el, value) => {
      const input = el as HTMLInputElement;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      // eslint-disable-next-line @typescript-eslint/unbound-method -- descriptor.set is invoked via .call(input)
      const setter = descriptor?.set;
      setter?.call(input, String(value));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, seconds);
    await expect(slider).toHaveValue(String(seconds));
  }

  /** Model rows in the open selector matching the model-item id prefix plus a CSS suffix. */
  private modelItemsMatching(suffix: string): Locator {
    return this.page
      .getByTestId(TEST_IDS.modelSelectorModal)
      .locator(`${MODEL_ITEM_PREFIX}${suffix}`);
  }

  /** Model rows in the open model selector that are currently selected. */
  selectedModelItems(): Locator {
    return this.modelItemsMatching('[data-selected="true"]');
  }

  /** Unselected, selectable (not premium-locked) model rows in the open selector. */
  unselectedSelectableModelItems(): Locator {
    return this.modelItemsMatching(`[data-selected="false"]:not(:has(${LOCK_ICON_SELECTOR}))`);
  }

  /** Selectable (not premium-locked) model rows in the open selector. */
  selectableModelItems(): Locator {
    return this.modelItemsMatching(`:not(:has(${LOCK_ICON_SELECTOR}))`);
  }

  /** Selectable model rows excluding the Smart Model (a concrete provider model). */
  nonPremiumModelItems(): Locator {
    return this.page.getByTestId(TEST_IDS.modelSelectorModal).locator(NON_PREMIUM_MODEL_ITEMS);
  }

  /** All model rows in the open selector. */
  modelItems(): Locator {
    return this.modelItemsMatching('');
  }

  /** Premium-locked model rows in the open selector. */
  lockedModelItems(): Locator {
    return this.modelItemsMatching(`:has(${LOCK_ICON_SELECTOR})`);
  }

  /** Rows the open selector is presenting as unavailable (greyed with a cause). */
  unavailableModelItems(): Locator {
    return this.modelItemsMatching('[data-unavailable="true"]');
  }

  /**
   * The test ids of the rows the open selector is presenting as unavailable,
   * sorted so two readings compare as sets rather than as render orders. Opens
   * and closes the selector, leaving the committed selection untouched.
   */
  async greyedModelRowIds(): Promise<string[]> {
    await this.openModelSelector();
    const rows = this.unavailableModelItems();
    const count = await rows.count();
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      ids.push((await rows.nth(index).getAttribute('data-testid')) ?? '');
    }
    await this.confirmModelSelection();
    return ids.toSorted((left, right) => left.localeCompare(right));
  }

  /**
   * The effort words the chip's menu is presenting as greyed (`aria-disabled`
   * — the menu keeps them focusable so their cause stays reachable), sorted.
   * Opens the menu and closes it with Escape, so no selection is committed.
   */
  async greyedEffortLevels(): Promise<string[]> {
    const levels = await this.effortMenuLevels();
    return levels
      .filter((level) => level.greyed)
      .map((level) => level.word)
      .toSorted((left, right) => left.localeCompare(right));
  }

  /**
   * Every word the chip's menu is presenting, each paired with whether it renders
   * greyed. Same reading as {@link ChatComposerPage.greyedEffortLevels}, but it also reports the
   * words the menu is offering — a caller measuring one rung's state needs to
   * tell "offered and funded" apart from "not presented at all", which the greyed
   * list alone spells the same way. Each word is the row's accessible name: a
   * row's text also holds its description, or its reason while greyed. Opens the
   * menu and closes it with Escape, so no selection is committed.
   */
  async effortMenuLevels(): Promise<{ word: string; greyed: boolean }[]> {
    await this.openEffortMenu();
    const items = this.effortMenu().getByRole('menuitemradio');
    await expect(items.first()).toBeVisible();
    const count = await items.count();
    const levels: { word: string; greyed: boolean }[] = [];
    for (let index = 0; index < count; index++) {
      const item = items.nth(index);
      levels.push({
        word: await accessibleNameOf(item),
        greyed: (await item.getAttribute('aria-disabled')) === 'true',
      });
    }
    await this.page.keyboard.press('Escape');
    await expect(items.first()).not.toBeVisible({ timeout: TIMEOUTS.MODAL });
    return levels;
  }

  async isInputFocused(): Promise<boolean> {
    return this.messageInput.evaluate((el) => el === document.activeElement);
  }

  async selectNonPremiumModel(): Promise<void> {
    await this.selectModels(1);
  }

  /** Open the model selector modal by clicking the composer's model chip. */
  async openModelSelector(): Promise<void> {
    await this.page.getByTestId(TEST_IDS.modelSelectorButton).click();
    await expect(this.page.getByTestId(TEST_IDS.modelSelectorModal)).toBeVisible();
  }

  /**
   * Switch the picker between single and multi modes by clicking the
   * appropriate option in the segmented PickerModeToggle. The toggle renders
   * twice (once per responsive layout); click the first visible option.
   */
  async switchPickerMode(mode: 'single' | 'multi'): Promise<void> {
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);
    const targetTestId = mode === 'single' ? TEST_IDS.pickerModeSingle : TEST_IDS.pickerModeMulti;
    await modal.getByTestId(targetTestId).first().click();
    await expect(modal).toHaveAttribute('data-picker-mode', mode);
  }

  /**
   * Toggle a model in the picker. In single mode this commits + closes; in
   * multi mode it toggles a checkbox in the local pending selection. Either
   * way, the row body is the click target now (no more checkbox-only zone).
   */
  async toggleModelInModal(modelId: string): Promise<void> {
    const item = this.page.getByTestId(TEST_ID_BUILDERS.modelItem(modelId));
    // Click the row's main button (the part that holds the model name + checkbox).
    await item.locator('button').first().click();
  }

  /**
   * Confirm the multi-mode pending selection via the footer Use button. In
   * single mode, row clicks commit + close immediately so this helper is
   * unnecessary — it falls through to closing via X if the modal is still
   * open with no Use button.
   */
  async confirmModelSelection(): Promise<void> {
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);
    const useButton = modal.getByTestId(TEST_IDS.useModelsButton);
    if (await useButton.isVisible()) {
      await useButton.click();
    } else if (await modal.isVisible()) {
      // Single mode after a row click already closed the modal; nothing to do.
      // If it's still open (no row was clicked), close via X. The X is the
      // overlay dialog's own child and a SIBLING of the layout div that carries
      // the modal test id, so it is reachable only from the overlay content.
      const closeButton = this.page
        .getByTestId(TEST_IDS.overlayContent)
        .filter({ has: modal })
        .getByRole('button', { name: 'Close' });
      if (!(await closeButton.isVisible())) {
        throw new Error('the model selector is open with neither a Use button nor a Close button');
      }
      await closeButton.click();
    }
    await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  /**
   * The reasoning-effort chip in the composer controls row: the gauge and the
   * effective word, named "Reasoning effort: <word>".
   */
  effortChip(): Locator {
    return this.page.getByTestId(TEST_IDS.effortChip);
  }

  /**
   * The open effort menu: anchored from 768px, where the chip names it, and
   * inside a bottom sheet below it, where its title does.
   */
  effortMenu(): Locator {
    return this.page.getByRole('menu', { name: EFFORT_MENU_NAME });
  }

  /**
   * Whether the turn carries an effort selection: `present` while it does, `absent`
   * while it carries none, `collapsing` while an outgoing chip slides out. Read
   * from the chip's slide wrapper, which says so at every composer width, where
   * the chip itself is hidden on a composer too narrow to show it.
   */
  async effortControlState(): Promise<string | null> {
    return this.page
      .locator('main')
      .locator(`[${TEST_SIGNALS.effortControl}]`)
      .getAttribute(TEST_SIGNALS.effortControl);
  }

  /**
   * Opens the effort menu from its chip or, on a composer too narrow to show the
   * chip, from the mode menu's Effort row.
   */
  async openEffortMenu(): Promise<void> {
    if (await this.effortChip().isVisible()) {
      await this.effortChip().click();
    } else {
      await this.openModeMenu();
      await this.modeMenu.getByRole('menuitem', { name: /^Effort: /u }).click();
    }
    await expect(this.effortMenu()).toBeVisible();
  }

  /**
   * The chip's accessible name, read once — for a caller that must capture the
   * displayed rung at a chosen moment rather than assert it at whatever moment a
   * retrying assertion happens to poll. The chip's ghost-word stack is
   * aria-hidden, so `textContent()` would concatenate every possible word instead.
   */
  async effortChipAccessibleName(): Promise<string> {
    return accessibleNameOf(this.effortChip());
  }

  /**
   * Pick an effort level from the effort menu (open-then-pick): open it, click
   * the menuitemradio named by the full display word (Medium's display word is
   * "Mid"; "Min" is the OFF row — reasoning disabled, not a low effort level),
   * then assert the selection took through a control named at every width: the
   * chip where the composer shows it, else the mode menu's "Effort: <word>" row
   * — the app-emitted state, no wall-clock waits.
   */
  async selectReasoningEffort(
    level: 'Auto' | 'Min' | 'Lite' | 'Low' | 'Mid' | 'High' | 'Max'
  ): Promise<void> {
    await this.openEffortMenu();
    await this.effortMenu().getByRole('menuitemradio', { name: level, exact: true }).click();
    await expect(this.effortMenu()).toBeHidden();
    if (await this.effortChip().isVisible()) {
      await expect(this.effortChip()).toHaveAccessibleName(`Reasoning effort: ${level}`);
      return;
    }
    await this.openModeMenu();
    await expect(
      this.modeMenu.getByRole('menuitem', { name: `Effort: ${level}`, exact: true })
    ).toBeVisible();
    await this.page.keyboard.press('Escape');
    await expect(this.modeMenu).toBeHidden();
  }

  /**
   * Refuse, by name, a row the picker has already refused for this payer.
   *
   * A refused row is operable: clicking it routes the payer to the paywall
   * rather than selecting the model, so a click here leaves the selection
   * unmade and fails later on a symptom that names neither the model nor the
   * condition. The row is already displaying the answer, so it is read from
   * there.
   */
  private async refuseIfRowUnavailable(item: Locator, modelId: string): Promise<void> {
    if ((await item.getAttribute('data-unavailable')) !== 'true') return;
    const reasonId = await item.locator('button').first().getAttribute('aria-describedby');
    const reason =
      reasonId === null
        ? 'no reason is described on the row'
        : ((await item.locator(`[id="${escapeAttributeValue(reasonId)}"]`).textContent()) ?? '');
    throw new Error(
      `selectSingleModel: the picker refuses '${modelId}' for this payer — ${reason.trim()}`
    );
  }

  /**
   * Select a single model by name in single mode. Opens the picker, makes
   * sure single mode is active, clicks the row → commits + closes.
   */
  async selectSingleModel(modelId: string): Promise<void> {
    await this.openModelSelector();
    await this.switchPickerMode('single');
    // A row's verdict is the affordability producer's, and until it has run
    // every row reads as ungraded — so a refusal read before this point would
    // report "selectable" about a row nothing has graded yet.
    await this.waitForAffordabilitySettled();
    const item = this.page.getByTestId(TEST_ID_BUILDERS.modelItem(modelId));
    await this.refuseIfRowUnavailable(item, modelId);
    await item.locator('button').first().click();
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);
    await expect(modal).not.toBeVisible({ timeout: TIMEOUTS.MODAL });
  }

  /**
   * Select N non-premium models via the modal in multi mode. Opens, switches
   * to multi mode, clears any pending state, clicks the first N non-premium
   * rows, and confirms via Use.
   */
  async selectModels(count: number): Promise<void> {
    await this.openModelSelector();
    await this.switchPickerMode('multi');
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);

    const nonPremiumItems = modal.locator(NON_PREMIUM_MODEL_ITEMS);

    // Clear all pending selections to start from a known state.
    const clearButton = modal.getByTestId(TEST_IDS.clearSelectionButton).first();
    if (await clearButton.isVisible().catch(() => false)) {
      await clearButton.click();
      await expect(modal.locator('[data-selected="true"]')).toHaveCount(0);
    }

    const available = await nonPremiumItems.count();
    const toSelect = Math.min(count, available);
    for (let index = 0; index < toSelect; index++) {
      const item = nonPremiumItems.nth(index);
      const isSelected = (await item.getAttribute('data-selected')) === 'true';
      if (!isSelected) {
        await item.locator('button').first().click();
        await expect(item).toHaveAttribute('data-selected', 'true');
      }
    }

    await this.confirmModelSelection();
  }

  /**
   * Select an explicit list of models by id in multi mode (used by tests that
   * need a specific model combination, e.g. multi-model media). Opens the
   * picker, switches to multi mode, clears any pending selection, clicks each
   * model id, then confirms via Use.
   */
  async selectModelsByIds(ids: readonly string[]): Promise<void> {
    await this.openModelSelector();
    await this.switchPickerMode('multi');
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);

    const clearButton = modal.getByTestId(TEST_IDS.clearSelectionButton).first();
    if (await clearButton.isVisible().catch(() => false)) {
      await clearButton.click();
      await expect(modal.locator('[data-selected="true"]')).toHaveCount(0);
    }

    for (const id of ids) {
      const item = modal.getByTestId(TEST_ID_BUILDERS.modelItem(id));
      await expect(item).toBeVisible();
      await item.locator('button').first().click();
      await expect(item).toHaveAttribute('data-selected', 'true');
    }

    await this.confirmModelSelection();
  }

  /**
   * Select 2 models for partial failure testing:
   * - First non-premium model (will succeed)
   * - LAST non-premium model (will be configured to fail)
   * Returns { successModelId, failModelId }.
   * The fail model is never picked by selectModels(N) since that picks from the front.
   */
  async selectModelsWithFailTarget(): Promise<{ successModelId: string; failModelId: string }> {
    await this.openModelSelector();
    await this.switchPickerMode('multi');
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);
    const nonPremiumItems = modal.locator(NON_PREMIUM_MODEL_ITEMS);

    const clearButton = modal.getByTestId(TEST_IDS.clearSelectionButton).first();
    if (await clearButton.isVisible().catch(() => false)) {
      await clearButton.click();
      await expect(modal.locator('[data-selected="true"]')).toHaveCount(0);
    }

    const modelItemPrefix = TEST_ID_BUILDERS.modelItem('');
    const available = await nonPremiumItems.count();

    const firstItem = nonPremiumItems.nth(0);
    await firstItem.locator('button').first().click();
    await expect(firstItem).toHaveAttribute('data-selected', 'true');
    const firstTestId = await firstItem.getAttribute('data-testid');
    const successModelId = (firstTestId ?? '').replace(modelItemPrefix, '');

    // Select LAST model (fail target) — never picked by selectModels(N)
    const lastItem = nonPremiumItems.nth(available - 1);
    await lastItem.locator('button').first().click();
    await expect(lastItem).toHaveAttribute('data-selected', 'true');
    const lastTestId = await lastItem.getAttribute('data-testid');
    const failModelId = (lastTestId ?? '').replace(modelItemPrefix, '');

    await this.confirmModelSelection();
    return { successModelId, failModelId };
  }

  /** Count selected (checked) models in the open modal. */
  async getSelectedModelCount(): Promise<number> {
    const modal = this.page.getByTestId(TEST_IDS.modelSelectorModal);
    return modal
      .locator(`[data-testid^="${TEST_ID_BUILDERS.modelItem('')}"][data-selected="true"]`)
      .count();
  }

  /** Assert several models are selected: the model chip reads "<first> + N". */
  async expectSeveralModelsSelected(): Promise<void> {
    await expect(this.page.getByTestId(TEST_IDS.modelSelectorButton)).toHaveAccessibleName(
      SEVERAL_MODELS_LABEL
    );
  }

  /** Assert one model is selected: the model chip names it alone. */
  async expectOneModelSelected(): Promise<void> {
    await expect(this.page.getByTestId(TEST_IDS.modelSelectorButton)).not.toHaveAccessibleName(
      SEVERAL_MODELS_LABEL
    );
  }

  /**
   * Assert the model chip counts exactly `count` selected models. The accessible name keeps
   * the count even when the drawn text loses it, so several models also need the count drawn
   * as its own visible text.
   */
  async expectModelChipCount(count: number): Promise<void> {
    const chip = this.page.getByTestId(TEST_IDS.modelSelectorButton);
    if (count <= 1) {
      await expect(chip).not.toHaveAccessibleName(SEVERAL_MODELS_LABEL);
      return;
    }
    const more = String(count - 1);
    await expect(chip).toHaveAccessibleName(new RegExp(String.raw` \+ ${more}$`, 'u'));
    await expect(chip.getByText(`+ ${more}`, { exact: true })).toBeVisible();
  }

  /** Assert the model chip names exactly this one model, with no count. */
  async expectModelChipNames(modelName: string): Promise<void> {
    await expect(this.page.getByTestId(TEST_IDS.modelSelectorButton)).toHaveAccessibleName(
      `Model: ${modelName}`
    );
  }

  /** The model a picker row offers, read from its main button's accessible name. */
  async modelRowName(row: Locator): Promise<string> {
    const label = (await row.getByRole('button').first().getAttribute('aria-label')) ?? '';
    return label.replace(ROW_BUTTON_ACTION, '');
  }
}
