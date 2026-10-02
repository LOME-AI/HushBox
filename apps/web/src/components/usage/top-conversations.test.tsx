import * as React from 'react';
import { render, renderHook, screen, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TEST_IDS } from '@hushbox/shared';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { TopConversations } from './top-conversations';
import { UsageModelSet, useUsageModelLabels } from './use-usage-model-labels';
import type { Model, SpendingByConversationResponse } from '@hushbox/shared';
import type { UseModelsStub } from '@/test-utils/models-hook-stub';

const { catalogRef } = vi.hoisted(() => {
  const catalog: { current: Model[] | undefined } = { current: undefined };
  return { catalogRef: catalog };
});

vi.mock('@/hooks/models/models', () => ({
  useModels: (): UseModelsStub => ({
    data:
      catalogRef.current === undefined
        ? undefined
        : { models: catalogRef.current, premiumIds: new Set<string>() },
  }),
}));

function catalogModel(id: string, name: string): Model {
  return {
    id,
    name,
    provider: 'Fictional',
    description: 'Text generation model.',
    modality: 'text',
    supportedParameters: [],
    contextLength: 128_000,
    created: OLD_RELEASE_SECONDS,
    maxOutputTokens: 4096,
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
  };
}

type Row = SpendingByConversationResponse['data'][number];

function makeData(rows: Partial<Row>[]): SpendingByConversationResponse {
  return {
    data: rows.map((row, index) => ({
      conversationId: `conv-${String(index).padStart(6, '0')}`,
      totalSpent: '1000000000',
      messageCount: 2,
      modelIds: [LARGE],
      ...row,
    })),
  };
}

const LARGE = 'fictional/large-4.1';
const SMALL = 'fictional/small-2.5';
const UNLISTED = 'fictional/unlisted';

const PAGE_MODELS = [LARGE, SMALL, UNLISTED];

function pageWrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <UsageModelSet value={PAGE_MODELS}>{children}</UsageModelSet>;
}

function renderList(
  props: Partial<React.ComponentProps<typeof TopConversations>> = {}
): ReturnType<typeof render> {
  return render(<TopConversations data={undefined} isLoading={false} {...props} />, {
    wrapper: pageWrapper,
  });
}

function rows(): HTMLElement[] {
  return within(screen.getByTestId(TEST_IDS.topConversations)).getAllByRole('listitem');
}

function onlyRow(): HTMLElement {
  const [row] = rows();
  if (!row) throw new Error('expected one Top Conversations row');
  return row;
}

beforeEach(() => {
  catalogRef.current = [catalogModel(LARGE, 'Large 4.1'), catalogModel(SMALL, 'Small 2.5')];
});

describe('TopConversations', () => {
  describe('states', () => {
    it('shows the placeholder while loading', () => {
      renderList({ isLoading: true });

      expect(screen.getByTestId(TEST_IDS.skeletonBlock)).toBeInTheDocument();
    });

    it('shows the empty message when there is no data', () => {
      renderList({ data: undefined });

      expect(screen.getByText('No conversation data')).toBeInTheDocument();
    });

    it('shows the empty message when the range has no conversations', () => {
      renderList({ data: makeData([]) });

      expect(screen.getByText('No conversation data')).toBeInTheDocument();
    });

    it('replaces the empty message with a retryable error', () => {
      renderList({ isError: true, onRetry: vi.fn() });

      expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load this chart");
      expect(screen.queryByText('No conversation data')).not.toBeInTheDocument();
    });
  });

  describe('the block', () => {
    it('carries the Top Conversations test id', () => {
      renderList({ data: makeData([{}]) });

      expect(screen.getByTestId(TEST_IDS.topConversations)).toBeInTheDocument();
    });

    it('names its list role outright, since WebKit drops it from a list drawn without markers', () => {
      renderList({ data: makeData([{}]) });

      expect(screen.getByTestId(TEST_IDS.topConversations).querySelector('ol')).toHaveAttribute(
        'role',
        'list'
      );
    });

    it('is a section named by its Top Conversations heading', () => {
      renderList({ data: makeData([{}]) });

      expect(screen.getByRole('region', { name: 'Top Conversations' })).toBeInTheDocument();
    });
  });

  describe('titles', () => {
    let consoleError: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleError.mockRestore();
    });

    it('lists the conversations in the order the server ranks them', () => {
      renderList({
        data: makeData([{ conversationId: 'conv-first' }, { conversationId: 'conv-second' }]),
        conversationTitles: [
          { id: 'conv-second', title: 'Dinner recipes' },
          { id: 'conv-first', title: 'Tax planning chat' },
        ],
      });

      expect(
        rows().map((row) => row.querySelector('[data-slot="top-title"]')?.textContent)
      ).toEqual(['Tax planning chat', 'Dinner recipes']);
    });

    it('keeps a long title whole for the line to truncate', () => {
      const title = 'A very long conversation title well beyond any one line';
      renderList({
        data: makeData([{ conversationId: 'conv-long' }]),
        conversationTitles: [{ id: 'conv-long', title }],
      });

      const titleLine = within(onlyRow()).getByText(title);
      expect(titleLine).toHaveClass('truncate');
    });

    it('lists two conversations that share a title without a duplicate key', () => {
      renderList({
        data: makeData([{ conversationId: 'conv-one' }, { conversationId: 'conv-two' }]),
        conversationTitles: [
          { id: 'conv-one', title: 'Untitled plan' },
          { id: 'conv-two', title: 'Untitled plan' },
        ],
      });

      expect(rows()).toHaveLength(2);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('labels a conversation with no decrypted title by the end of its id', () => {
      renderList({ data: makeData([{ conversationId: 'conv-aaaaaa' }]) });

      expect(within(onlyRow()).getByText('conv-aaaaaa')).toBeInTheDocument();
    });

    it('labels a conversation still decrypting by the end of its id', () => {
      renderList({
        data: makeData([{ conversationId: 'conv-cccccc' }]),
        conversationTitles: [{ id: 'conv-cccccc', title: 'Decrypting...' }],
      });

      expect(within(onlyRow()).getByText('conv-cccccc')).toBeInTheDocument();
    });

    it('labels a conversation that cannot be decrypted by the end of its id', () => {
      renderList({
        data: makeData([{ conversationId: 'conv-dddddd' }]),
        conversationTitles: [{ id: 'conv-dddddd', title: 'Encrypted conversation' }],
      });

      expect(within(onlyRow()).getByText('conv-dddddd')).toBeInTheDocument();
    });
  });

  describe('the model line', () => {
    it("names a single-model conversation's model by its display name", () => {
      renderList({ data: makeData([{ modelIds: [SMALL] }]) });

      expect(within(onlyRow()).getByText('Small 2.5')).toBeInTheDocument();
    });

    it("marks a single-model conversation's model with the swatch the page gives it", () => {
      const { result } = renderHook(() => useUsageModelLabels(), { wrapper: pageWrapper });
      renderList({ data: makeData([{ modelIds: [SMALL] }]) });

      const swatch = onlyRow().querySelector('[data-slot="swatch"]');
      expect(swatch).toHaveClass(`bg-model-${String(result.current.swatch(SMALL))}`);
    });

    it('names a model the catalog no longer lists by its id', () => {
      renderList({ data: makeData([{ modelIds: [UNLISTED] }]) });

      expect(within(onlyRow()).getByText(UNLISTED)).toBeInTheDocument();
    });

    it('counts the models of a multi-model conversation', () => {
      renderList({ data: makeData([{ modelIds: [LARGE, SMALL, UNLISTED] }]) });

      expect(within(onlyRow()).getByText('3 models')).toBeInTheDocument();
    });

    it('draws no swatch for a multi-model conversation', () => {
      renderList({ data: makeData([{ modelIds: [LARGE, SMALL] }]) });

      expect(onlyRow().querySelector('[data-slot="swatch"]')).toBeNull();
    });

    it('marks a multi-model conversation with the people icon', () => {
      renderList({ data: makeData([{ modelIds: [LARGE, SMALL] }]) });

      expect(onlyRow().querySelector('svg.lucide-users')).not.toBeNull();
    });

    it('names no model for a conversation whose replies name none', () => {
      renderList({ data: makeData([{ modelIds: [], messageCount: 3 }]) });

      expect(onlyRow().querySelector('[data-slot="top-sub"]')).toHaveTextContent(/^3 messages$/);
    });
  });

  describe('the message count', () => {
    it("follows the model with the conversation's message count", () => {
      renderList({ data: makeData([{ modelIds: [SMALL], messageCount: 14 }]) });

      expect(onlyRow().querySelector('[data-slot="top-sub"]')).toHaveTextContent(
        /^Small 2\.5\s*·\s*14 messages$/
      );
    });

    it('counts a single message in the singular', () => {
      renderList({ data: makeData([{ messageCount: 1 }]) });

      expect(within(onlyRow()).getByText('1 message')).toBeInTheDocument();
    });
  });

  describe('the spend', () => {
    // Money crosses the wire as canonical nano-USD integer strings: 2140000000 nano is $2.14.
    it("shows the conversation's spend in dollars", () => {
      renderList({ data: makeData([{ totalSpent: '2140000000' }]) });

      expect(within(onlyRow()).getByText('$2.1400')).toBeInTheDocument();
    });

    it('keeps a sub-cent spend rather than collapsing it to zero', () => {
      renderList({ data: makeData([{ totalSpent: '1360000' }]) });

      expect(within(onlyRow()).getByText('$0.0014')).toBeInTheDocument();
    });

    it('sets the spend in mono', () => {
      renderList({ data: makeData([{ totalSpent: '2140000000' }]) });

      expect(within(onlyRow()).getByText('$2.1400')).toHaveClass('font-mono');
    });
  });
});
