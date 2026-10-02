import { E2E_MODELS } from '../../scripts/lib/playwright/model-ids.js';
import type { ChatPage } from '../pages/index.js';

/**
 * The menu's word for the off rung. The page object drives the effort menu by
 * display word, and `Min` is the row that turns reasoning OFF rather than a low
 * level — the shared label map spells it that way for `REASONING_OFF`.
 */
const OFF_LEVEL = 'Min';

/**
 * The menu's word for the delegating row. It is always offered and it engages
 * nothing by itself, so it is what a menu presents when there is no ladder.
 */
const AUTO_LEVEL = 'Auto';

/**
 * The model this helper pins the turn to.
 *
 * Selecting by id rather than by list position is half the point: the picker's
 * first row is its "Strongest" pin, which the live catalog moves without a
 * commit here, and a pin that lands on a model whose reasoning is mandatory
 * presents no off rung for {@link pinOffRung} to take.
 *
 * The other half is which id. Two independent conditions govern a picker row and
 * neither implies the other — the reasoning ladder above, and the payer's TIER:
 * a premium row is refused to anyone below the paid tier however well funded,
 * and several specs reach this helper as a payer spending a free allowance. Both
 * conditions are asserted of every `E2E_MODELS.text` entry when the catalog is
 * refreshed, so either one drifting is a red pipeline rather than a spec whose
 * pinned model the picker refuses. Price is not among them: affordability is not the gate
 * a refused premium row failed.
 */
const PINNED_TEXT_MODEL_ID = E2E_MODELS.text[1];

/**
 * Make a text turn's SHAPE a property of the spec, for any spec whose assertion
 * prices that turn exactly.
 *
 * Two things decide how many generations a text send bills and how many
 * characters it persists, and neither is written in the spec that sends it:
 *
 *  - **The composer's default text selection is the Smart Model**, which routes.
 *    A routed turn bills a classifier generation alongside the answer, and that
 *    charge anchors onto the answer's content item — so it lands in the wallet
 *    delta AND in the conversation's cost, and an expectation priced for one
 *    generation is short by exactly one. Selecting a model explicitly removes it.
 *  - **Effort defaults to `auto` and rides every text send.** A model presenting
 *    two or more rungs then builds its own single-candidate classifier turn with
 *    its own charge, and an active effort wire makes the mock stream reasoning
 *    text into the persisted content, growing the storage term past the echo.
 *    Pinning the off rung removes both.
 *
 * Whether the second one fires depends on the live catalog's reasoning metadata
 * for the selected model, which no reader can decide from source — so the
 * ladder is read from the composer instead of assumed. A model presenting no
 * ladder hides the chip and sends no reasoning field at all, which is the same
 * end state that pinning off reaches.
 *
 * A ladder that cannot be turned off — reasoning mandatory, so the composer
 * hides the off row, or an off row present but refused — fails loudly and by
 * name: such a turn persists reasoning characters nothing in the assertion
 * vocabulary can size, so the derivation would be wrong rather than merely
 * unpinned. A menu with no rung to engage is a different thing and passes
 * through untouched.
 */
export async function pinTextTurnShape(chatPage: ChatPage): Promise<void> {
  await chatPage.selectSingleModel(PINNED_TEXT_MODEL_ID);
  await pinOffRung(chatPage);
}

/**
 * The effort half alone, for a spec that has already chosen its own selection —
 * a Smart Model send, whose routing classifier is part of what it is pricing and
 * must not be selected away.
 *
 * The reasoning-storage variable reaches every text derivation, not only the
 * ones whose model came from a client default: any active effort wire streams
 * the mock's reasoning text into the persisted content, whatever chose the model.
 *
 * Returns quietly in the two states that need no pin — no effort control, or a menu with
 * nothing beside the delegating row — and throws, by name, in the two it cannot
 * pin. Both throws exist so a menu this helper cannot satisfy reads as itself
 * rather than as a chip-label timeout somewhere downstream.
 */
export async function pinOffRung(chatPage: ChatPage): Promise<void> {
  // Two independent facts gate the reads below, and neither implies the other.
  // Until the affordability producer resolves, the catalog has not landed and a
  // hidden chip means "not yet" rather than "no ladder", and the graded set the
  // menu greys from carries no verdict — so `off.greyed` below would report an
  // unanswered query as a refusal. And until the chip's slide wrapper leaves
  // `collapsing`, an outgoing chip is still rendered under the same test id, so
  // a visibility read grades the ladder of the model that was replaced.
  await chatPage.waitForAffordabilitySettled();
  await chatPage.waitForEffortControlSettled();

  // The wrapper's signal, not the chip's visibility: a composer too narrow to
  // show the chip still carries the turn's effort, reached through the mode menu.
  if ((await chatPage.effortControlState()) !== 'present') return;

  const levels = await chatPage.effortMenuLevels();
  const menu = levels.map((level) => level.word).join(', ');

  // Conditioned on the WIRE, not on the row: `Auto` delegates and engages
  // nothing on its own, so a menu presenting nothing beside it has no rung to
  // run at and sends no reasoning — the state an unpinned derivation is already
  // correct in. Throwing here would fail a spec whose money is fine.
  if (levels.every((level) => level.word === AUTO_LEVEL)) return;

  const off = levels.find((level) => level.word === OFF_LEVEL);
  if (off === undefined) {
    throw new Error(
      `pinOffRung: the selection presents rungs but no off row (menu: ${menu}), so its turn ` +
        'runs reasoning whose persisted characters no derivation here can size'
    );
  }
  if (off.greyed) {
    // The cheapest rung, refused: funding, not the model, is what left it
    // unavailable. Named here rather than left to the chip-label assertion
    // inside the page object, which would time out saying only that the label
    // never changed.
    throw new Error(
      `pinOffRung: the off row is presented but unavailable (menu: ${menu}), so this turn ` +
        'cannot be pinned off'
    );
  }
  await chatPage.selectReasoningEffort(OFF_LEVEL);
}
