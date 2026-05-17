import { test, expect, unsettledExpect } from '../fixtures.js';
import { ChatPage } from '../pages/index.js';
import { BudgetHelper } from '../helpers/budget.js';
import { sumDisplayedMessageCostCents } from '../helpers/cost-display.js';
import type { Page, Request } from '@playwright/test';

/** Read the cost badge for a specific persisted message by data-message-id. */
async function getMessageCostCents(page: Page, messageId: string): Promise<number> {
  const badge = page.locator(`[data-message-id="${messageId}"] [data-testid="message-cost"]`);
  const text = (await badge.textContent()) ?? '';
  const match = /\$?([\d.]+)/.exec(text);
  return match ? Math.round(Number.parseFloat(match[1] ?? '0') * 100) : 0;
}

/** Collect the (id, modelName) of every persisted assistant message currently rendered. */
async function snapshotAssistantTiles(page: Page): Promise<{ id: string; modelName: string }[]> {
  const tiles = page.locator('[data-role="assistant"][data-message-id]');
  const count = await tiles.count();
  const out: { id: string; modelName: string }[] = [];
  for (let index = 0; index < count; index++) {
    const tile = tiles.nth(index);
    const id = (await tile.getAttribute('data-message-id')) ?? '';
    const nametag = (await tile.getByTestId('model-nametag').textContent()) ?? '';
    if (id) out.push({ id, modelName: nametag.trim() });
  }
  return out;
}

interface RegenerateRequestBody {
  models?: string[];
  replaceAssistantId?: string;
  action?: string;
  targetMessageId?: string;
}

/** Capture and parse the next POST to /regenerate. Times out at 15s. */
function captureNextRegenerateRequest(page: Page): Promise<Request> {
  return page.waitForRequest(
    (req) => req.url().includes('/regenerate') && req.method() === 'POST',
    { timeout: 15_000 }
  );
}

function parseRegenerateBody(req: Request): RegenerateRequestBody {
  return JSON.parse(req.postData() ?? '{}') as RegenerateRequestBody;
}

test.describe('Multi-Model Regeneration', () => {
  test.describe.configure({ mode: 'serial' });

  // Retry on the user message of a multi-model turn fans out to ALL selected
  // models, deleting every existing sibling and creating one new tile per
  // model. Wallet debit must equal the sum of the new tiles' displayed costs.
  test('retry-all replaces every sibling and charges the sum of all new costs', async ({
    authenticatedPage,
    multiModelConversation: _multiModelConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    const budgetHelper = new BudgetHelper(authenticatedPage.request);

    const tilesBefore = await snapshotAssistantTiles(authenticatedPage);
    expect(tilesBefore).toHaveLength(2);
    const beforeIds = new Set(tilesBefore.map((t) => t.id));

    const beforeBalance = await budgetHelper.getBalance();
    const balanceBefore = Number.parseFloat(beforeBalance.balance);

    let body: RegenerateRequestBody = {};
    await test.step('click retry on the user message — capture the request body', async () => {
      const requestPromise = captureNextRegenerateRequest(authenticatedPage);
      // Index 0 in the fixture is always the user prompt.
      await chatPage.clickRetry(0);
      body = parseRegenerateBody(await requestPromise);
    });

    await test.step('request shape: models is the full sibling set, no replaceAssistantId', () => {
      expect(body.action).toBe('retry');
      expect(body.models?.length).toBe(2);
      expect(body.replaceAssistantId).toBeUndefined();
    });

    await test.step('wait for both new responses + their cost badges', async () => {
      await chatPage.waitForStreamComplete(30_000);
      await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
        timeout: 20_000,
      });
      await unsettledExpect(chatPage.messageList).toHaveAttribute('data-cost-count', '2', {
        timeout: 20_000,
      });
    });

    await test.step('both pre-existing tiles are gone, two brand-new tiles took their place', async () => {
      // `data-assistant-count='2'` alone is also true of the pre-regen state,
      // so it would silently pass if pruning failed. Compare ids directly.
      const tilesAfter = await snapshotAssistantTiles(authenticatedPage);
      expect(tilesAfter).toHaveLength(2);
      for (const tile of tilesAfter) {
        expect(beforeIds.has(tile.id)).toBe(false);
      }
    });

    await test.step('wallet debit equals the sum of the NEW per-tile costs', async () => {
      const afterBalance = await budgetHelper.getBalance();
      const balanceAfter = Number.parseFloat(afterBalance.balance);
      const debitCents = Math.round((balanceBefore - balanceAfter) * 100);
      const displayedCents = await sumDisplayedMessageCostCents(chatPage.messageList);
      // 1-cent rounding tolerance matches multi-model.spec.ts:388.
      expect(Math.abs(debitCents - displayedCents)).toBeLessThanOrEqual(1);
    });
  });

  // Per-tile Regenerate on ONE assistant of a multi-model turn replaces just
  // that tile. Surviving siblings keep their existing row, model nametag,
  // and cost badge — and the wallet only sees the new tile's cost.
  test('regenerate-one replaces just the clicked tile and preserves siblings', async ({
    authenticatedPage,
    multiModelConversation: _multiModelConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    const budgetHelper = new BudgetHelper(authenticatedPage.request);

    const tilesBefore = await snapshotAssistantTiles(authenticatedPage);
    expect(tilesBefore).toHaveLength(2);

    // Pick the second tile to regenerate; the first stays put.
    const survivor = tilesBefore[0]!;
    const toReplace = tilesBefore[1]!;
    const survivorCostBefore = await getMessageCostCents(authenticatedPage, survivor.id);
    expect(survivorCostBefore).toBeGreaterThan(0);

    const beforeBalance = await budgetHelper.getBalance();
    const balanceBefore = Number.parseFloat(beforeBalance.balance);

    let body: RegenerateRequestBody = {};
    await test.step('click Regenerate on the second tile — capture the request body', async () => {
      const requestPromise = captureNextRegenerateRequest(authenticatedPage);
      // Index 2 = second assistant in the rendered list (0=user, 1=first assistant, 2=second).
      await chatPage.clickRegenerate(2);
      body = parseRegenerateBody(await requestPromise);
    });

    await test.step('request shape: models is exactly the clicked tile, replaceAssistantId set', () => {
      expect(body.action).toBe('retry');
      expect(body.models?.length).toBe(1);
      expect(body.replaceAssistantId).toBe(toReplace.id);
    });

    await test.step('wait for the replacement to stream + persist', async () => {
      await chatPage.waitForStreamComplete(30_000);
      await unsettledExpect(chatPage.messageList).toHaveAttribute('data-assistant-count', '2', {
        timeout: 20_000,
      });
    });

    await test.step('survivor row is unchanged (same id, same cost)', async () => {
      const tilesAfter = await snapshotAssistantTiles(authenticatedPage);
      const survivorAfter = tilesAfter.find((t) => t.id === survivor.id);
      expect(survivorAfter).toBeDefined();
      expect(survivorAfter?.modelName).toBe(survivor.modelName);

      const survivorCostAfter = await getMessageCostCents(authenticatedPage, survivor.id);
      expect(survivorCostAfter).toBe(survivorCostBefore);
    });

    await test.step('replaced row is gone, exactly one new row appeared', async () => {
      const tilesAfter = await snapshotAssistantTiles(authenticatedPage);
      const replacedStillThere = tilesAfter.some((t) => t.id === toReplace.id);
      expect(replacedStillThere).toBe(false);
      // The only id that's different from `before` is the new tile.
      const newTiles = tilesAfter.filter((t) => !tilesBefore.some((b) => b.id === t.id));
      expect(newTiles).toHaveLength(1);
    });

    await test.step('wallet debit equals the new tile cost only', async () => {
      const afterBalance = await budgetHelper.getBalance();
      const balanceAfter = Number.parseFloat(afterBalance.balance);
      const debitCents = Math.round((balanceBefore - balanceAfter) * 100);
      const displayedTotal = await sumDisplayedMessageCostCents(chatPage.messageList);
      // displayedTotal = survivorCostBefore + newTileCost
      // debit should equal newTileCost (survivor wasn't re-charged).
      const newTileCost = displayedTotal - survivorCostBefore;
      expect(Math.abs(debitCents - newTileCost)).toBeLessThanOrEqual(1);
    });
  });
});
