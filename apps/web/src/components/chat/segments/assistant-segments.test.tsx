import { render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { serializeSegments, TEST_IDS } from '@hushbox/shared';
import {
  AssistantSegments,
  useAssistantRender,
} from '@/components/chat/segments/assistant-segments';
import type { MessageRenderFacts } from '@/components/chat/segments/render-context';

const FACTS: MessageRenderFacts = {
  messageId: 'm-1',
  isStreaming: false,
  modelName: undefined,
  reasoningTokens: undefined,
  reasoningEffort: undefined,
};

const SETTLED_ROW_LAST = serializeSegments([
  { kind: 'text', text: 'Lead.' },
  {
    kind: 'webSearch',
    row: {
      v: 1,
      searches: [{ query: 'q', status: 'done', sources: [] }],
      notRun: { limit: 0, invalidQuery: 0 },
    },
  },
]);

function drawSegments(content: string, facts: Partial<MessageRenderFacts> = {}): void {
  const { result } = renderHook(() => useAssistantRender(content, { ...FACTS, ...facts }));
  render(<AssistantSegments {...result.current} />);
}

describe('AssistantSegments', () => {
  it('states withheld reasoning for a turn billed for reasoning it never showed', () => {
    drawSegments('An answer.', { reasoningTokens: 900 });
    expect(screen.getByTestId(TEST_IDS.reasoningNotShared)).toHaveTextContent(
      'Reasoning not shared · 900 tokens'
    );
  });

  it('draws no withheld line when the message shows its reasoning', () => {
    drawSegments(
      serializeSegments([
        { kind: 'reasoning', children: [{ kind: 'text', text: 'hm' }] },
        { kind: 'text', text: 'An answer.' },
      ]),
      { reasoningTokens: 900 }
    );
    expect(screen.queryByTestId(TEST_IDS.reasoningNotShared)).not.toBeInTheDocument();
  });

  it('names an unnamed model as AI in the still-working cue', () => {
    drawSegments(SETTLED_ROW_LAST, { isStreaming: true });
    expect(screen.getByTestId(TEST_IDS.thinkingIndicator)).toHaveTextContent('AI is thinking');
  });

  it('parses the text once per content and keeps the tree across renders', () => {
    const { result, rerender } = renderHook(
      ({ content }: { content: string }) => useAssistantRender(content, FACTS),
      { initialProps: { content: 'An answer.' } }
    );
    const first = result.current.tree;
    rerender({ content: 'An answer.' });
    expect(result.current.tree).toBe(first);
  });
});
