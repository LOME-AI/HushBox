import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render as renderInDom, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeSegments, TEST_IDS } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { useTtsPlaybackStore } from '@hushbox/ui/accessibility/store';
import { AIMessageBlock } from '@/components/chat/message/ai-message-block';
import { chatKeys } from '@/hooks/chat/chat';
import { memberKeys } from '@/hooks/realtime/use-conversation-members';
import { linkKeys } from '@/hooks/realtime/use-conversation-links';
import { useAuthStore } from '@/lib/auth/auth';
import { modelSwatch } from '@/lib/utils/model-color';
import { useSegmentViewState } from '@/components/chat/segments/segment-view-state';
import type { Message } from '@/lib/api/api';
import type { ConversationDetailResponse } from '@/hooks/chat/chat';
import type {
  ConversationLinksData,
  ConversationMembersData,
} from '@/hooks/chat/use-replying-to-name';
import type { ModelsData } from '@/hooks/models/models';
import type { MessageResponse, Model, Segment, WebSearchRow } from '@hushbox/shared';

/** The query client every render gets; a test seeds it with the conversation's reads. */
let queryClient = new QueryClient();

function QueryWrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function render(ui: React.ReactElement): ReturnType<typeof renderInDom> {
  return renderInDom(ui, { wrapper: QueryWrapper });
}

vi.mock('@/lib/tts/chat-tts-stream', () => ({ stopTtsForMessage: vi.fn() }));
vi.mock('@/components/chat/indicators/tts-stopped-notice', () => ({
  TtsStoppedNotice: () => null,
}));

const PAGES = [
  { title: 'Example Domain', url: 'https://example.com/' },
  { title: 'Example Organization', url: 'https://example.org/' },
  { title: 'Example Network', url: 'https://example.net/' },
];

function search(...searches: WebSearchRow['searches']): Segment {
  return { kind: 'webSearch', row: { v: 1, searches, notRun: { limit: 0, invalidQuery: 0 } } };
}

/** Two finished searches that found three distinct pages between them. */
const TWO_SEARCHES = search(
  { query: 'first query', status: 'done', sources: PAGES.slice(0, 2) },
  { query: 'second query', status: 'done', sources: PAGES.slice(1) }
);

const NESTED_CONTENT = serializeSegments([
  { kind: 'reasoning', children: [{ kind: 'text', text: 'think' }, TWO_SEARCHES] },
  { kind: 'text', text: 'Answer' },
]);

function message(content: string, extra: Partial<Message> = {}): Message {
  return {
    id: 'a-1',
    conversationId: 'c-1',
    role: 'assistant',
    content,
    createdAt: isoAt(TEST_DAY_START),
    modelName: 'Sonnet 4.5',
    ...extra,
  };
}

async function draw(
  content: string,
  options: { isStreaming?: boolean; extra?: Partial<Message>; models?: ModelsData } = {}
): Promise<ReturnType<typeof render>> {
  const view = render(
    <AIMessageBlock
      primaryMessage={message(content, options.extra)}
      isStreaming={options.isStreaming}
      modelName={undefined}
      models={options.models}
    />
  );
  await act(async () => {
    await import('@/components/chat/message/markdown-renderer');
  });
  return view;
}

beforeEach(() => {
  useSegmentViewState.setState({ open: new Set() });
  queryClient = new QueryClient();
  useAuthStore.setState({ user: null });
  useTtsPlaybackStore.setState({ speakingStreamId: null });
});

describe('AIMessageBlock: a search made during reasoning', () => {
  it('rolls the search into the reasoning one-liner while collapsed', async () => {
    await draw(NESTED_CONTENT);
    const toggle = screen.getByTestId(TEST_IDS.thinkingDisclosureToggle);
    expect(toggle).toHaveTextContent('Reasoning · Searched 3 sources');
    expect(screen.queryByTestId(TEST_IDS.webSearchRow)).not.toBeInTheDocument();
  });

  it('shows the search nested inside the opened reasoning, after the thought it followed', async () => {
    await draw(NESTED_CONTENT);
    fireEvent.click(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle));
    await act(async () => {
      await import('@/components/chat/message/markdown-renderer');
    });
    const content = screen.getByTestId(TEST_IDS.thinkingDisclosureContent);
    const row = within(content).getByTestId(TEST_IDS.webSearchRow);
    expect(content.textContent.indexOf('think')).toBeLessThan(
      content.textContent.indexOf('Searched the web')
    );
    expect(row).toHaveTextContent('Searched the web · 3 sources');
  });

  it('renders the answer after the reasoning', async () => {
    await draw(NESTED_CONTENT);
    const disclosure = screen.getByTestId(TEST_IDS.thinkingDisclosure);
    const answer = screen.getByText('Answer');
    expect(disclosure.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});

describe('AIMessageBlock: a search made after the answer started', () => {
  const INLINE = serializeSegments([
    { kind: 'text', text: 'Let me look that up.' },
    search({ query: 'q', status: 'done', sources: PAGES }),
    { kind: 'text', text: 'Here is what I found.' },
  ]);

  it('sits inline in the answer, between the text either side', async () => {
    await draw(INLINE);
    const region = screen.getByTestId(TEST_IDS.aiMessageLiveRegion);
    const text = region.textContent;
    expect(text.indexOf('Let me look that up.')).toBeLessThan(text.indexOf('Searched the web'));
    expect(text.indexOf('Searched the web')).toBeLessThan(text.indexOf('Here is what I found.'));
    expect(screen.queryByTestId(TEST_IDS.thinkingDisclosure)).not.toBeInTheDocument();
  });

  it('counts a page a search inside the reasoning already found as found earlier', async () => {
    await draw(
      serializeSegments([
        {
          kind: 'reasoning',
          children: [search({ query: 'a', status: 'done', sources: PAGES.slice(0, 1) })],
        },
        { kind: 'text', text: 'Lead.' },
        search({ query: 'b', status: 'done', sources: PAGES.slice(0, 2) }),
      ])
    );
    const toggle = screen.getByTestId(TEST_IDS.webSearchRowToggle);
    expect(toggle).toHaveTextContent('Searched the web · 1 source');
    fireEvent.click(toggle);
    expect(screen.getByTestId(TEST_IDS.webSearchRowPanel)).toHaveTextContent(
      '+1 found by an earlier search'
    );
  });
});

describe('AIMessageBlock: the still-working cue', () => {
  it('shows the thinking indicator after a settled row while the turn still streams', async () => {
    await draw(
      serializeSegments([
        { kind: 'text', text: 'Lead.' },
        search({ query: 'q', status: 'done', sources: PAGES }),
      ]),
      { isStreaming: true }
    );
    const region = screen.getByTestId(TEST_IDS.aiMessageLiveRegion);
    const indicator = within(region).getByTestId(TEST_IDS.thinkingIndicator);
    const row = screen.getByTestId(TEST_IDS.webSearchRow);
    expect(row.compareDocumentPosition(indicator) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });

  it('shows no indicator while the row is still searching', async () => {
    await draw(
      serializeSegments([
        { kind: 'text', text: 'Lead.' },
        search({ query: 'q', status: 'searching' }),
      ]),
      { isStreaming: true }
    );
    expect(screen.queryByTestId(TEST_IDS.thinkingIndicator)).not.toBeInTheDocument();
  });
});

describe('AIMessageBlock: a stopped live tile', () => {
  it('keeps its settled tree above the error it failed with', async () => {
    await draw(
      serializeSegments([
        search({ query: 'q', status: 'interrupted' }),
        { kind: 'text', text: '' },
      ]),
      { extra: { errorCode: 'STREAM_ERROR' } }
    );
    const row = screen.getByTestId(TEST_IDS.webSearchRow);
    const error = screen.getByTestId(TEST_IDS.modelErrorMessage);
    expect(row).toHaveTextContent('Search stopped');
    expect(row.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    );
  });
});

describe('AIMessageBlock: one rendering for everyone', () => {
  /** useId values differ between two render roots; everything else must not. */
  function normalized(html: string): string {
    return html.replaceAll(/_r_[\da-z]+_/g, 'ID');
  }

  it('renders identical DOM for a live phantom and a persisted message with the same content', async () => {
    const phantom: Message = {
      id: 'a-1',
      conversationId: 'c-1',
      role: 'assistant',
      content: NESTED_CONTENT,
      createdAt: '',
      modelName: 'Sonnet 4.5',
      reasoningTokens: 40,
    };
    const persisted: Message = {
      ...message(NESTED_CONTENT),
      reasoningTokens: 40,
      senderId: 'assistant',
      epochNumber: 1,
      wrappedContentKey: 'wrapped',
      cost: '0.01',
    };
    const watcher = render(
      <AIMessageBlock
        primaryMessage={phantom}
        isStreaming
        modelName={undefined}
        models={undefined}
      />
    );
    const owner = render(
      <AIMessageBlock
        primaryMessage={persisted}
        isStreaming
        modelName={undefined}
        models={undefined}
      />
    );
    await act(async () => {
      await import('@/components/chat/message/markdown-renderer');
    });
    expect(normalized(watcher.container.innerHTML)).toBe(normalized(owner.container.innerHTML));
  });
});

/** Tailwind's spacing step: `p-1` is 0.25rem, 4px at the root size. */
const SPACING_STEP_PX = 4;

/** How far a focused control's ring reaches past its box: the outline plus its offset. */
function ringReach(control: HTMLElement): number {
  const width = /\bfocus-visible:outline-(\d+)\b/.exec(control.className)?.[1];
  const offset = /\bfocus-visible:outline-offset-(\d+)\b/.exec(control.className)?.[1];
  if (width === undefined || offset === undefined) throw new Error('the control draws no ring');
  return Number(width) + Number(offset);
}

/**
 * Whether an element cuts off what paints past its padding box on one side, by
 * CSS's rules: `clip` cuts only its own axis, while `hidden`, `auto` or
 * `scroll` on one axis turns a `visible` other axis into `auto`, which cuts too.
 */
function clips(element: HTMLElement, side: 't' | 'l'): boolean {
  const [own, other] = side === 't' ? ['y', 'x'] : ['x', 'y'];
  return [
    /\boverflow-(hidden|clip|auto|scroll)\b/,
    new RegExp(String.raw`\boverflow-${own}-(hidden|clip|auto|scroll)\b`),
    new RegExp(String.raw`\boverflow-${other}-(hidden|auto|scroll)\b`),
  ].some((pattern) => pattern.test(element.className));
}

/** An element's padding on one side, in px, as its utilities set it: a side beats an axis beats all. */
function padding(element: HTMLElement, side: 't' | 'l'): number {
  const axis = side === 't' ? 'y' : 'x';
  for (const pattern of [`p${side}`, `p${axis}`, 'p']) {
    const step = new RegExp(String.raw`(?:^|\s)${pattern}-(\d+(?:\.\d+)?)(?:\s|$)`).exec(
      element.className
    )?.[1];
    if (step !== undefined) return Number(step) * SPACING_STEP_PX;
  }
  return 0;
}

describe('AIMessageBlock: focus rings inside the answer', () => {
  function expectWholeRing(control: HTMLElement): void {
    const region = screen.getByTestId(TEST_IDS.aiMessageLiveRegion);
    const reach = ringReach(control);
    for (const side of ['t', 'l'] as const) {
      expect(clips(region, side) ? padding(region, side) : reach).toBeGreaterThanOrEqual(reach);
    }
  }

  it('keeps the whole ring of a reasoning toggle first in the answer inside the live region', async () => {
    await draw(NESTED_CONTENT);
    expectWholeRing(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle));
  });

  it('keeps the whole ring of a search row first in the answer inside the live region', async () => {
    await draw(serializeSegments([TWO_SEARCHES, { kind: 'text', text: 'Answer' }]));
    expectWholeRing(screen.getByTestId(TEST_IDS.webSearchRowToggle));
  });
});

const SONNET_ID = 'anthropic/claude-sonnet-4.5';

const SONNET: Model = {
  id: SONNET_ID,
  name: 'Claude Sonnet 4.5',
  description: 'desc',
  provider: 'Anthropic',
  modality: 'text',
  contextLength: 8000,
  supportedParameters: [],
  pricing: { inputPerToken: '10000', outputPerToken: '30000' },
};

const CATALOG: ModelsData = { models: [SONNET], premiumIds: new Set() };

const REASONED_ANSWER = serializeSegments([
  { kind: 'reasoning', children: [{ kind: 'text', text: 'think' }] },
  { kind: 'text', text: 'Answer' },
]);

const STILL_REASONING = serializeSegments([
  { kind: 'reasoning', children: [{ kind: 'text', text: 'think' }] },
]);

describe('AIMessageBlock: the nameplate', () => {
  it('names the model by its catalog name', async () => {
    await draw('Answer', { extra: { modelName: SONNET_ID }, models: CATALOG });
    expect(screen.getByTestId(TEST_IDS.modelNametag)).toHaveTextContent('Claude Sonnet 4.5');
  });

  it("names the model's maker", async () => {
    await draw('Answer', { extra: { modelName: SONNET_ID }, models: CATALOG });
    expect(screen.getByTestId(TEST_IDS.modelNametagContainer)).toHaveTextContent('Anthropic');
  });

  it("draws the model's own swatch", async () => {
    const { container } = await draw('Answer', {
      extra: { modelName: SONNET_ID },
      models: CATALOG,
    });
    expect(container.querySelector('[data-slot="swatch"]')).toHaveClass(
      `bg-model-${String(modelSwatch(SONNET_ID))}`
    );
  });

  it('names the model a Smart-routed reply resolved to while it streams', async () => {
    await draw('', {
      isStreaming: true,
      extra: { modelName: 'smart-model', resolvedModelName: 'Claude Opus 4.6', isSmartModel: true },
      models: CATALOG,
    });
    expect(screen.getByTestId(TEST_IDS.modelNametag)).toHaveTextContent('Claude Opus 4.6');
  });

  it('keeps the stop-reading control in the head while the reply is read aloud', async () => {
    useTtsPlaybackStore.getState().setSpeakingStream('a-1');
    await draw('Answer');
    const head = screen.getByTestId(TEST_IDS.modelNametagContainer);
    expect(within(head).getByRole('button', { name: /stop reading/i })).toBeInTheDocument();
  });

  it('keeps "Smart" on a Smart-routed reply', async () => {
    await draw('Answer', { extra: { isSmartModel: true } });
    expect(screen.getByTestId(TEST_IDS.smartModelChip)).toHaveTextContent('Smart');
  });

  it('tags a settled reply with the level it reasoned at', async () => {
    await draw(REASONED_ANSWER, { extra: { reasoningEffort: 'medium' } });
    expect(screen.getByTestId(TEST_IDS.effortTag)).toHaveTextContent('Mid effort');
  });

  it('tags no reply whose reasoning is still live', async () => {
    await draw(STILL_REASONING, { isStreaming: true, extra: { reasoningEffort: 'medium' } });
    expect(screen.queryByTestId(TEST_IDS.effortTag)).not.toBeInTheDocument();
  });

  it('tags a streaming reply once its reasoning has settled before the answer', async () => {
    await draw(
      serializeSegments([
        { kind: 'reasoning', children: [{ kind: 'text', text: 'think' }] },
        search({ query: 'q', status: 'done', sources: PAGES }),
      ]),
      { isStreaming: true, extra: { reasoningEffort: 'medium' } }
    );
    expect(screen.getByTestId(TEST_IDS.effortTag)).toHaveTextContent('Mid effort');
  });
});

describe('AIMessageBlock: when the nameplate shows', () => {
  it('shows no nameplate on a settled reply with nothing in it', async () => {
    await draw('');
    expect(screen.queryByTestId(TEST_IDS.modelNametagContainer)).not.toBeInTheDocument();
  });

  it('shows the nameplate on a media reply whose text is empty', async () => {
    await draw('', {
      extra: {
        mediaItems: [
          { id: 'img-1', position: 0, contentType: 'image', mimeType: 'image/png', sizeBytes: 10 },
        ],
      },
    });
    expect(screen.getByTestId(TEST_IDS.modelNametagContainer)).toBeInTheDocument();
  });

  it("names a reply that carries no model by the turn's selected model", () => {
    render(
      <AIMessageBlock
        primaryMessage={message('Answer', { modelName: null })}
        isStreaming={false}
        modelName={SONNET_ID}
        models={CATALOG}
      />
    );
    expect(screen.getByTestId(TEST_IDS.modelNametag)).toHaveTextContent('Claude Sonnet 4.5');
  });
});

describe('AIMessageBlock: a turn with nothing streamed yet', () => {
  it('says the model is thinking while nothing has streamed', async () => {
    await draw('', { isStreaming: true, extra: { modelName: SONNET_ID }, models: CATALOG });
    expect(screen.getByTestId(TEST_IDS.aiMessageLiveRegion)).toHaveTextContent('Claude Sonnet 4.5');
  });

  it('shows only the error for a turn that failed before streaming anything', async () => {
    await draw('', { extra: { modelName: null, errorCode: 'STREAM_ERROR' } });
    expect(screen.getByTestId(TEST_IDS.modelErrorMessage)).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.thinkingDisclosure)).not.toBeInTheDocument();
  });
});

describe('AIMessageBlock: a media turn in flight', () => {
  it('holds the media placeholder until the media lands', async () => {
    await draw('', {
      isStreaming: true,
      extra: {
        mediaInFlight: { mediaType: 'image', mimeType: 'image/png', aspectRatio: '16:9' },
        mediaProgress: { percent: 40 },
      },
    });
    expect(screen.getByText('Generating image…')).toBeInTheDocument();
  });

  it('holds the placeholder without a shape or progress while neither is known', async () => {
    await draw('', {
      isStreaming: true,
      extra: { mediaInFlight: { mediaType: 'audio', mimeType: 'audio/mpeg' } },
    });
    expect(screen.getByText('Generating audio…')).toBeInTheDocument();
  });
});

describe('AIMessageBlock: replying to', () => {
  const VIEWER_ID = 'user-alice';

  function member(userId: string, username: string): ConversationMembersData['members'][number] {
    return {
      id: `member-${userId}`,
      userId,
      linkId: null,
      username,
      privilege: 'write',
      visibleFromEpoch: 1,
      joinedAt: isoAt(TEST_DAY_START),
      accepted: true,
    };
  }

  function stored(id: string, senderId: string | null, parent: string | null): MessageResponse {
    return {
      id,
      parentMessageId: parent,
      sequenceNumber: 1,
      epochNumber: 1,
      senderType: senderId === null ? 'assistant' : 'user',
      senderId,
      wrappedContentKey: 'wrapped',
      batchId: 'batch-1',
      deleted: false,
      createdAt: isoAt(TEST_DAY_START),
      contentItems: [],
    };
  }

  const DETAIL: ConversationDetailResponse = {
    conversation: {
      id: 'c-1',
      title: 'encrypted-title',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 3,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
    },
    membership: {
      privilege: 'write',
      muted: false,
      pinned: false,
      accepted: true,
      visibleFromEpoch: 1,
      lastReadSeq: 0,
      linkId: null,
    },
    forks: [],
  };

  function seed(members: ConversationMembersData): void {
    useAuthStore.setState({
      user: {
        id: VIEWER_ID,
        email: 'alice@hushbox.ai',
        username: 'Alice',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: true,
      },
    });
    const noLinks: ConversationLinksData = { links: [] };
    queryClient.setQueryData(chatKeys.conversation('c-1'), DETAIL);
    queryClient.setQueryData(chatKeys.messages('c-1'), [
      stored('ask-1', 'user-bob', null),
      stored('a-1', null, 'ask-1'),
    ]);
    queryClient.setQueryData(memberKeys.list('c-1'), members);
    queryClient.setQueryData(linkKeys.list('c-1'), noLinks);
  }

  it('names the member a group reply answers', async () => {
    seed({ members: [member(VIEWER_ID, 'Alice'), member('user-bob', 'Bob')] });
    await draw('Answer', { extra: { parentMessageId: 'ask-1' } });
    expect(screen.getByTestId(TEST_IDS.modelNametagContainer)).toHaveTextContent('replying to Bob');
  });

  it('names nobody in a solo chat', async () => {
    seed({ members: [member(VIEWER_ID, 'Alice')] });
    await draw('Answer', { extra: { parentMessageId: 'ask-1' } });
    expect(screen.getByTestId(TEST_IDS.modelNametagContainer)).not.toHaveTextContent('replying to');
  });
});
