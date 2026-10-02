import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { serializeSegments, TEST_IDS } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { modelSwatch } from '@/lib/utils/model-color';
import { ModelNameplate, effortTagOf, nameplateFor } from './model-nameplate';
import type { Message } from '@/lib/api/api';
import type { EffortTagFacts, ModelNameplateProps } from './model-nameplate';
import type { Model, Segment } from '@hushbox/shared';

const SONNET_ID = 'anthropic/claude-sonnet-4.5';

function model(id: string, name: string, provider: string): Model {
  return {
    id,
    name,
    description: 'desc',
    provider,
    modality: 'text',
    contextLength: 8000,
    supportedParameters: [],
    pricing: { inputPerToken: '10000', outputPerToken: '30000' },
  };
}

const MODELS: readonly Model[] = [model(SONNET_ID, 'Claude Sonnet 4.5', 'Anthropic')];

function reply(extra: Partial<Message> = {}): Message {
  return {
    id: 'reply-1',
    conversationId: 'conv-1',
    role: 'assistant',
    content: 'An answer.',
    createdAt: isoAt(TEST_DAY_START),
    modelName: SONNET_ID,
    ...extra,
  };
}

const REASONED: Segment[] = [
  { kind: 'reasoning', children: [{ kind: 'text', text: 'think' }] },
  { kind: 'text', text: 'Answer' },
];

const REASONED_WITHOUT_ANSWER: Segment[] = [
  { kind: 'reasoning', children: [{ kind: 'text', text: 'think' }] },
];

function drawn(overrides: Partial<ModelNameplateProps> = {}): ReturnType<typeof render> {
  const props: ModelNameplateProps = {
    modelName: 'Claude Sonnet 4.5',
    provider: 'Anthropic',
    swatch: 3,
    ...overrides,
  };
  return render(<ModelNameplate {...props} />);
}

/** The nameplate's root, where its whole text reads in order. */
function plate(): HTMLElement {
  const root = document.querySelector<HTMLElement>('[data-slot="model-nameplate"]');
  if (root === null) throw new Error('no nameplate rendered');
  return root;
}

describe('ModelNameplate', () => {
  it('names the model', () => {
    drawn();
    expect(screen.getByTestId(TEST_IDS.modelNametag)).toHaveTextContent('Claude Sonnet 4.5');
  });

  it('sets the head in the UI face, not the reading face around it', () => {
    drawn();
    expect(plate()).toHaveClass('font-sans');
  });

  it('sets the model name in semibold', () => {
    drawn();
    expect(screen.getByTestId(TEST_IDS.modelNametag)).toHaveClass('font-semibold');
  });

  it('names the maker after the model', () => {
    drawn();
    expect(plate()).toHaveTextContent('Claude Sonnet 4.5Anthropic');
  });

  it('keeps the swatch on the same line as the name when the head wraps', () => {
    drawn();
    const name = screen.getByTestId(TEST_IDS.modelNametag);
    expect(name.parentElement?.querySelector('[data-slot="swatch"]')).not.toBeNull();
    expect(name.parentElement).toHaveClass('min-w-0', 'max-w-full');
  });

  it('draws the swatch it is given', () => {
    const { container } = drawn({ swatch: 5 });
    expect(container.querySelector('[data-slot="swatch"]')).toHaveClass('bg-model-5');
  });

  it('draws no maker when none is known', () => {
    drawn({ provider: '' });
    expect(plate()).toHaveTextContent(/^Claude Sonnet 4\.5$/);
  });

  it('shows the effort tag it is given', () => {
    drawn({ effortTag: 'Mid effort' });
    expect(screen.getByTestId(TEST_IDS.effortTag)).toHaveTextContent('Mid effort');
  });

  it('shows no effort tag without one', () => {
    drawn();
    expect(screen.queryByTestId(TEST_IDS.effortTag)).not.toBeInTheDocument();
  });

  it('marks a Smart-routed reply', () => {
    drawn({ smart: true });
    expect(screen.getByTestId(TEST_IDS.smartModelChip)).toHaveTextContent('Smart');
  });

  it('marks nothing as Smart by default', () => {
    drawn();
    expect(screen.queryByTestId(TEST_IDS.smartModelChip)).not.toBeInTheDocument();
  });

  it('places the replying-to label last in the head', () => {
    drawn({ effortTag: 'Mid effort', replyingTo: <span>replying to Bob</span> });
    expect(plate().textContent).toMatch(/replying to Bob$/);
  });

  it('gives the replying-to label its own indented row below 768px', () => {
    drawn({ replyingTo: <span>replying to Bob</span> });
    const slot = screen.getByText('replying to Bob').parentElement;
    expect(slot).toHaveClass('max-md:basis-full', 'max-md:pl-4');
  });
});

describe('nameplateFor', () => {
  it("names a reply by its model's catalog name", () => {
    expect(nameplateFor(reply(), MODELS).modelName).toBe('Claude Sonnet 4.5');
  });

  it("names the model's maker from the catalog", () => {
    expect(nameplateFor(reply(), MODELS).provider).toBe('Anthropic');
  });

  it('gives the model its own swatch', () => {
    expect(nameplateFor(reply(), MODELS).swatch).toBe(modelSwatch(SONNET_ID));
  });

  it('names a model the catalog lacks by its shortened id', () => {
    const plate = nameplateFor(reply({ modelName: 'vendor/model-x-20250101' }), MODELS);
    expect(plate.modelName).toBe('model-x');
  });

  it('names no maker for a model the catalog lacks', () => {
    expect(nameplateFor(reply({ modelName: 'vendor/model-x' }), MODELS).provider).toBe('');
  });

  it('names a reply with no model "AI"', () => {
    expect(nameplateFor(reply({ modelName: null }), MODELS).modelName).toBe('AI');
  });

  it('prefers the name a streaming reply resolved to over the catalog', () => {
    const plate = nameplateFor(reply({ resolvedModelName: 'Claude Opus 4.6' }), MODELS);
    expect(plate.modelName).toBe('Claude Opus 4.6');
  });

  it('marks a Smart-routed reply', () => {
    expect(nameplateFor(reply({ isSmartModel: true }), MODELS).smart).toBe(true);
  });

  it('marks a plain reply as not Smart', () => {
    expect(nameplateFor(reply(), MODELS).smart).toBeUndefined();
  });

  it('tags a reply that reasoned at a recorded level with that level', () => {
    const plate = nameplateFor(
      reply({ content: serializeSegments(REASONED), reasoningEffort: 'medium' }),
      MODELS
    );
    expect(plate.effortTag).toBe('Mid effort');
  });

  it('tags no reply that left no reasoning trace', () => {
    const plate = nameplateFor(reply({ reasoningEffort: 'medium' }), MODELS);
    expect(plate.effortTag).toBeUndefined();
  });

  it('tags no reply whose level was not recorded', () => {
    const plate = nameplateFor(reply({ content: serializeSegments(REASONED) }), MODELS);
    expect(plate.effortTag).toBeUndefined();
  });

  it('tags no reply that stopped before an answer', () => {
    const plate = nameplateFor(
      reply({ content: serializeSegments(REASONED_WITHOUT_ANSWER), reasoningEffort: 'high' }),
      MODELS
    );
    expect(plate.effortTag).toBeUndefined();
  });
});

describe('effortTagOf', () => {
  const SETTLED: EffortTagFacts = {
    firstReasoningKey: 'reasoning:0',
    liveReasoningKey: undefined,
    hasAnswer: true,
    isStreaming: false,
    reasoningEffort: 'low',
  };

  it('names the level of a settled trace', () => {
    expect(effortTagOf(SETTLED)).toBe('Low effort');
  });

  it('names no level while the first reasoning span is still live', () => {
    expect(
      effortTagOf({
        ...SETTLED,
        isStreaming: true,
        hasAnswer: false,
        liveReasoningKey: 'reasoning:0',
      })
    ).toBeUndefined();
  });

  it('names the level of a streaming reply whose reasoning has settled before any answer', () => {
    expect(effortTagOf({ ...SETTLED, isStreaming: true, hasAnswer: false })).toBe('Low effort');
  });
});
