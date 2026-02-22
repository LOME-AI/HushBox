import { test, expect } from '../fixtures.js';
import { ChatPage, DocumentPanelPage } from '../pages/index.js';

/** 15-line Python function — exactly meets MIN_LINES_FOR_DOCUMENT threshold */
const PYTHON_CODE_BLOCK = [
  '```python',
  'def fibonacci(n):',
  '    """Calculate fibonacci number."""',
  '    if n <= 0:',
  '        return 0',
  '    if n == 1:',
  '        return 1',
  '    a = 0',
  '    b = 1',
  '    for i in range(2, n + 1):',
  '        c = a + b',
  '        a = b',
  '        b = c',
  '    return b',
  '',
  'print(fibonacci(10))',
  '```',
].join('\n');

/** Small mermaid diagram — mermaid has no minimum line count */
const MERMAID_BLOCK = [
  '```mermaid',
  'graph TD',
  '    A[Start] --> B{Decision}',
  '    B -->|Yes| C[OK]',
  '    B -->|No| D[End]',
  '```',
].join('\n');

/** 5-line code block — below MIN_LINES_FOR_DOCUMENT, should NOT be extracted */
const SMALL_CODE_BLOCK = [
  '```python',
  'def add(a, b):',
  '    return a + b',
  '',
  'print(add(1, 2))',
  '```',
].join('\n');

test.describe('Document Panel', () => {
  test.describe.configure({ mode: 'serial' });

  test('code document: extraction, panel, copy, download, and close', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    const documentPanel = new DocumentPanelPage(authenticatedPage);

    await test.step('send code block and verify card', async () => {
      await chatPage.sendFollowUpMessage(PYTHON_CODE_BLOCK);
      await chatPage.waitForAIResponse('fibonacci', 20_000);

      await documentPanel.waitForCardAppear();
      const card = documentPanel.documentCard(0);
      await expect(card).toContainText('fibonacci');
      await expect(card).toContainText('python');
      await expect(card).toContainText('15 lines');
    });

    await test.step('click card opens panel', async () => {
      await documentPanel.clickCard(0);
      await documentPanel.waitForPanelOpen();

      await documentPanel.expectTitle('fibonacci');
      await expect(documentPanel.activeCard()).toBeVisible();
      await expect(documentPanel.highlightedCode).toBeVisible();
    });

    await test.step('copy button shows feedback', async () => {
      await documentPanel.copyButton().click();
      await expect(documentPanel.copiedButton()).toBeVisible();

      // Wait for feedback to revert (2000ms timer + buffer)
      await expect(documentPanel.copyButton()).toBeVisible({ timeout: 3000 });
    });

    await test.step('download button triggers file download', async () => {
      const downloadPromise = authenticatedPage.waitForEvent('download');
      await documentPanel.downloadButton.click();
      const download = await downloadPromise;

      expect(download.suggestedFilename()).toBe('fibonacci.py');
    });

    await test.step('close panel', async () => {
      await documentPanel.closePanel();
      await expect(documentPanel.panel).not.toBeVisible();
      await expect(documentPanel.activeCard()).not.toBeVisible();
    });
  });

  test('mermaid, multi-document switching, fullscreen, and extraction threshold', async ({
    authenticatedPage,
    testConversation: _testConversation,
  }) => {
    test.slow();
    const chatPage = new ChatPage(authenticatedPage);
    const documentPanel = new DocumentPanelPage(authenticatedPage);

    await test.step('send Python code block (for multi-document switching)', async () => {
      await chatPage.sendFollowUpMessage(PYTHON_CODE_BLOCK);
      await chatPage.waitForAIResponse('fibonacci', 20_000);
      await documentPanel.waitForCardAppear();
      expect(await documentPanel.getCardCount()).toBe(1);
    });

    await test.step('send mermaid and verify rendered diagram', async () => {
      await chatPage.sendFollowUpMessage(MERMAID_BLOCK);
      await chatPage.waitForAIResponse('Graph Diagram', 20_000);

      const cardCount = await documentPanel.getCardCount();
      expect(cardCount).toBe(2);

      // Click the mermaid card (second card)
      await documentPanel.clickCard(1);
      await documentPanel.waitForPanelOpen();

      await documentPanel.expectTitle('Graph Diagram');
      await documentPanel.waitForMermaidRendered();
      await expect(documentPanel.showRawButton()).toBeVisible();
    });

    await test.step('raw/rendered toggle', async () => {
      await documentPanel.showRawButton().click();

      await expect(documentPanel.highlightedCode).toBeVisible();
      await expect(documentPanel.mermaidDiagram).not.toBeVisible();
      await expect(documentPanel.showRenderedButton()).toBeVisible();

      await documentPanel.showRenderedButton().click();

      await documentPanel.waitForMermaidRendered();
      await expect(documentPanel.showRawButton()).toBeVisible();
    });

    await test.step('switch to Python card', async () => {
      await documentPanel.clickCard(0);

      await expect(documentPanel.documentCard(0)).toHaveAttribute('data-active', 'true');
      const lastCardIndex = (await documentPanel.getCardCount()) - 1;
      await expect(documentPanel.documentCard(lastCardIndex)).toHaveAttribute(
        'data-active',
        'false'
      );
      await documentPanel.expectTitle('fibonacci');
      // Raw toggle should not be visible for code documents
      await expect(documentPanel.showRawButton()).not.toBeVisible();
      await expect(documentPanel.showRenderedButton()).not.toBeVisible();
    });

    await test.step('switch back to mermaid resets raw toggle', async () => {
      const lastCardIndex = (await documentPanel.getCardCount()) - 1;
      await documentPanel.clickCard(lastCardIndex);

      // Should show rendered diagram (toggle resets on doc switch)
      await documentPanel.waitForMermaidRendered();
      await expect(documentPanel.showRawButton()).toBeVisible();
    });

    await test.step('fullscreen toggle', async () => {
      const initialWidth = await documentPanel.getPanelWidth();

      await documentPanel.fullscreenButton().click();
      // Wait for width transition
      await authenticatedPage.waitForTimeout(400);
      const fullscreenWidth = await documentPanel.getPanelWidth();
      expect(fullscreenWidth).toBeGreaterThan(initialWidth);
      await expect(documentPanel.exitFullscreenButton()).toBeVisible();

      await documentPanel.exitFullscreenButton().click();
      await authenticatedPage.waitForTimeout(400);
      const restoredWidth = await documentPanel.getPanelWidth();
      // Restored width should be close to initial (within 10px tolerance)
      expect(Math.abs(restoredWidth - initialWidth)).toBeLessThan(10);
      await expect(documentPanel.fullscreenButton()).toBeVisible();
    });

    await test.step('small code block not extracted', async () => {
      // Close panel first to avoid it interfering with message input
      await documentPanel.closePanel();

      await chatPage.sendFollowUpMessage(SMALL_CODE_BLOCK);
      await chatPage.waitForAIResponse('add', 20_000);

      // The echo of the small code block should NOT contain a document card
      // (5 lines is below MIN_LINES_FOR_DOCUMENT threshold)
      // Note: we check the last assistant message instead of total card count
      // because react-virtuoso removes off-screen messages from the DOM
      const lastAssistant = chatPage.messageList.locator('[data-role="assistant"]').last();
      await expect(lastAssistant.locator('[data-testid="document-card"]')).toHaveCount(0);
    });
  });
});
