import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, expectTypeOf, it } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { buildRenderContext } from '@/components/chat/segments/render-context';
import { SegmentList } from '@/components/chat/segments/segment-list';
import { SEGMENT_RENDERERS } from '@/components/chat/segments/segment-renderers';
import { useSegmentViewState } from '@/components/chat/segments/segment-view-state';
import type { SegmentRendererTable } from '@/components/chat/segments/segment-renderers';
import type { MessageRenderFacts } from '@/components/chat/segments/render-context';
import type { Segment, SegmentKind } from '@hushbox/shared';

const FACTS: MessageRenderFacts = {
  messageId: 'm-1',
  isStreaming: false,
  modelName: 'Sonnet 4.5',
  reasoningTokens: undefined,
  reasoningEffort: undefined,
};

const ROW: Segment = {
  kind: 'webSearch',
  row: {
    v: 1,
    searches: [
      { query: 'q', status: 'done', sources: [{ title: 'Example', url: 'https://example.com/' }] },
    ],
    notRun: { limit: 0, invalidQuery: 0 },
  },
};

async function drawSettled(tree: readonly Segment[]): Promise<void> {
  const context = buildRenderContext(tree, FACTS);
  render(<SegmentList nodes={tree} context={context} parent="root" />);
  await act(async () => {
    await import('@/components/chat/message/markdown-renderer');
  });
}

beforeEach(() => {
  useSegmentViewState.setState({ open: new Set() });
});

describe('SEGMENT_RENDERERS', () => {
  it('has a renderer for every segment kind, so a kind without one fails to compile', () => {
    expectTypeOf<keyof SegmentRendererTable>().toEqualTypeOf<SegmentKind>();
    expect(Object.keys(SEGMENT_RENDERERS).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'reasoning',
      'text',
      'webSearch',
    ]);
  });
});

describe('SegmentList', () => {
  it('renders each root node through its kind renderer, in text order', async () => {
    await drawSettled([
      { kind: 'reasoning', children: [{ kind: 'text', text: 'thinking' }] },
      { kind: 'text', text: 'Lead-in.' },
      ROW,
      { kind: 'text', text: 'The rest.' },
    ]);
    const order = [
      screen.getByTestId(TEST_IDS.thinkingDisclosure),
      screen.getAllByTestId(TEST_IDS.markdownRenderer)[0],
      screen.getByTestId(TEST_IDS.webSearchRow),
      screen.getAllByTestId(TEST_IDS.markdownRenderer)[1],
    ];
    for (let index = 1; index < order.length; index += 1) {
      const previous = order[index - 1];
      const current = order[index];
      if (previous === undefined || current === undefined) throw new Error('four blocks drawn');
      expect(previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    }
  });

  it('keeps each block out of the answer region announcements', async () => {
    await drawSettled([{ kind: 'text', text: 'Lead-in.' }, ROW]);
    const block = screen.getByTestId(TEST_IDS.webSearchRow).parentElement;
    expect(block).toHaveAttribute('aria-live', 'off');
  });

  it('continues a numbered list across a row', async () => {
    await drawSettled([
      { kind: 'text', text: 'Before you upgrade:\n\n1. Read the notes.\n2. Check extensions.' },
      ROW,
      { kind: 'text', text: '\n1. Move accounts off MD5.' },
    ]);
    const lists = document.querySelectorAll('ol');
    expect(lists).toHaveLength(2);
    expect(lists[1]).toHaveAttribute('start', '3');
  });

  it('closes a code block before a row and reopens it after', async () => {
    await drawSettled([
      { kind: 'text', text: 'Run:\n\n```sql\nSELECT 1' },
      ROW,
      { kind: 'text', text: '\nFROM t;\n```\nDone.' },
    ]);
    const code = [...document.querySelectorAll('pre')].map((element) => element.textContent);
    expect(code).toHaveLength(2);
    expect(code[0]).toContain('SELECT 1');
    expect(code[1]).toContain('FROM t;');
    expect(document.body.textContent).not.toContain('```');
  });
});
