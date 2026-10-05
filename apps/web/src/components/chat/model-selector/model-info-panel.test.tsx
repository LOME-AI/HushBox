import { render, screen, within } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { modelSchema, TEST_IDS } from '@hushbox/shared';
import { ModelInfoPanel } from '@/components/chat/model-selector/model-info-panel';
import { priceDisplayOf } from '@/lib/chat/model-info-facts';
import type { Model } from '@hushbox/shared';

const actualFacts = await vi.importActual<typeof import('@/lib/chat/model-info-facts')>(
  '@/lib/chat/model-info-facts'
);

// The one display seam the panel reads, wrapping the real producer. A test
// replaces its answer only to reach a display no served row can produce, such
// as one side of a rate without the other; `afterEach` restores the producer.
vi.mock('@/lib/chat/model-info-facts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat/model-info-facts')>();
  return { ...actual, priceDisplayOf: vi.fn(actual.priceDisplayOf) };
});

afterEach(() => {
  vi.mocked(priceDisplayOf).mockImplementation(actualFacts.priceDisplayOf);
});

// Model fixtures carry BILLABLE (fee-inclusive) nano-USD rates in `pricing`
// (the wire shape; fees are baked at catalog ingestion). The shared nano
// formatters are pure renderers, so the rendered dollar values are the rate
// (e.g. a $0.04 base per-image rate displays as $0.046).

function buildModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    provider: 'OpenAI',
    modality: 'text' as const,
    contextLength: 128_000,
    pricing: { anchorContextTokens: 1_000_000, inputPerToken: '2500', outputPerToken: '10000' },
    description: 'Fast and capable model from OpenAI.',
    supportedParameters: [],
    ...overrides,
  };
}

const PRICE_REFERENCE =
  'Prices are references. The exact rate can vary with where your reply is served.';

const sonnet = buildModel({
  id: 'anthropic/claude-sonnet-4.5',
  name: 'Claude Sonnet 4.5',
  provider: 'Anthropic',
  contextLength: 1_000_000,
  pricing: {
    anchorContextTokens: 1_000_000,
    inputPerToken: '3450',
    outputPerToken: '17250',
    longContextRates: [
      { abovePromptTokens: 200_000, inputPerToken: '6900', outputPerToken: '25875' },
    ],
  },
});

const twoThresholds = buildModel({
  contextLength: 1_050_000,
  pricing: {
    anchorContextTokens: 1_000_000,
    inputPerToken: '1250',
    outputPerToken: '10000',
    longContextRates: [
      { abovePromptTokens: 128_000, inputPerToken: '2500', outputPerToken: '15000' },
      { abovePromptTokens: 272_000, inputPerToken: '5000', outputPerToken: '20000' },
    ],
  },
});

const expensiveTiered = buildModel({
  pricing: {
    anchorContextTokens: 1_000_000,
    inputPerToken: '60000',
    outputPerToken: '240000',
    longContextRates: [
      { abovePromptTokens: 200_000, inputPerToken: '120000', outputPerToken: '360000' },
    ],
  },
});

const offRoundThreshold = buildModel({
  id: 'qwen/qwen3-32b',
  name: 'Qwen3 32B',
  provider: 'Qwen',
  contextLength: 131_072,
  pricing: {
    anchorContextTokens: 1_000_000,
    inputPerToken: '92',
    outputPerToken: '368',
    longContextRates: [{ abovePromptTokens: 40_960, inputPerToken: '161', outputPerToken: '656' }],
  },
});

function precedes(first: Element, second: Element): boolean {
  return (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function longContextGroup(): HTMLElement {
  return screen.getByTestId(TEST_IDS.modelLongContextRates);
}

describe('ModelInfoPanel', () => {
  describe('full mode (default)', () => {
    it('renders provider name', () => {
      render(<ModelInfoPanel model={buildModel({ provider: 'Anthropic' })} />);
      expect(screen.getByText('Anthropic')).toBeInTheDocument();
    });

    it('renders input and output price labels', () => {
      render(<ModelInfoPanel model={buildModel()} />);
      expect(screen.getByText('Input Price / 1k Tokens')).toBeInTheDocument();
      expect(screen.getByText('Output Price / 1k Tokens')).toBeInTheDocument();
    });

    it('labels the base input rate as a price per 1k tokens, the unit its figure is in', () => {
      render(<ModelInfoPanel model={buildModel()} />);
      const label = screen.getByText('Input Price / 1k Tokens');
      expect(label.nextElementSibling?.textContent).toBe('$0.0025 / 1k');
    });

    it('labels the base output rate as a price per 1k tokens, the unit its figure is in', () => {
      render(<ModelInfoPanel model={buildModel()} />);
      const label = screen.getByText('Output Price / 1k Tokens');
      expect(label.nextElementSibling?.textContent).toBe('$0.01 / 1k');
    });

    it('renders capacity in tokens', () => {
      render(<ModelInfoPanel model={buildModel({ contextLength: 128_000 })} />);
      expect(screen.getByText(/128,000 tokens/)).toBeInTheDocument();
    });

    it('renders description', () => {
      render(<ModelInfoPanel model={buildModel({ description: 'A test description.' })} />);
      expect(screen.getByText('A test description.')).toBeInTheDocument();
    });

    it('renders expensive model warning for costly models', () => {
      render(
        <ModelInfoPanel
          model={buildModel({
            pricing: {
              anchorContextTokens: 1_000_000,
              inputPerToken: '60000',
              outputPerToken: '240000',
            },
          })}
        />
      );
      expect(screen.getByTestId('expensive-model-warning')).toBeInTheDocument();
    });

    it('does not render expensive model warning for affordable models', () => {
      render(<ModelInfoPanel model={buildModel()} />);
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('shows no token price at all when a text model carries no rates', () => {
      // A rate the catalog does not carry is not a rate of zero: "$0 / 1k" tells
      // the user this model is free to run.
      render(<ModelInfoPanel model={buildModel({ pricing: {} })} />);
      expect(screen.queryByText('Input Price / 1k Tokens')).not.toBeInTheDocument();
      expect(screen.queryByText('Output Price / 1k Tokens')).not.toBeInTheDocument();
      expect(screen.queryByText('$0 / 1k')).not.toBeInTheDocument();
    });

    it('drops both rates when a text model carries only one, which prices nothing', () => {
      // A row priced on one leg has no price the money layer can parse: showing
      // the leg it serves would present a model whose other leg reads as free.
      render(<ModelInfoPanel model={buildModel({ pricing: { outputPerToken: '10000' } })} />);
      expect(screen.queryByText('Input Price / 1k Tokens')).not.toBeInTheDocument();
      expect(screen.queryByText('Output Price / 1k Tokens')).not.toBeInTheDocument();
    });

    it('shows no rate for a row served at zero, which no price can carry', () => {
      render(
        <ModelInfoPanel
          model={buildModel({
            pricing: { anchorContextTokens: 1_000_000, inputPerToken: '0', outputPerToken: '0' },
          })}
        />
      );
      expect(screen.queryByText('$0 / 1k')).not.toBeInTheDocument();
    });

    it('raises no expensive-model warning when a text model carries no rates', () => {
      render(<ModelInfoPanel model={buildModel({ pricing: {} })} />);
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('treats a rate the money layer will not parse as no price at all', () => {
      // `0x186A0` is 100_000 to a bare `BigInt()` — enough to earn the warning —
      // and is not canonical nano-USD. The panel reads a produced verdict, so a
      // rate the money layer rejects never becomes one here.
      const nonCanonical = {
        anchorContextTokens: 1_000_000,
        inputPerToken: '0x186A0',
        outputPerToken: '100000',
      };

      render(<ModelInfoPanel model={buildModel({ pricing: nonCanonical })} />);

      expect(screen.queryByText('Input Price / 1k Tokens')).not.toBeInTheDocument();
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });
  });

  describe('compact mode', () => {
    it('omits description', () => {
      render(<ModelInfoPanel model={buildModel({ description: 'Should not appear.' })} compact />);
      expect(screen.queryByText('Should not appear.')).not.toBeInTheDocument();
      expect(screen.queryByText('Description')).not.toBeInTheDocument();
    });

    it('renders expensive model warning for costly models', () => {
      render(
        <ModelInfoPanel
          model={buildModel({
            pricing: {
              anchorContextTokens: 1_000_000,
              inputPerToken: '60000',
              outputPerToken: '240000',
            },
          })}
          compact
        />
      );
      expect(screen.getByTestId('expensive-model-warning')).toHaveTextContent(
        'Long chats with this model can be costly'
      );
    });

    it('does not render expensive model warning for affordable models', () => {
      render(<ModelInfoPanel model={buildModel()} compact />);
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('renders provider name', () => {
      render(<ModelInfoPanel model={buildModel({ provider: 'Google' })} compact />);
      expect(screen.getByText('Google')).toBeInTheDocument();
    });

    it('renders pricing labels', () => {
      render(<ModelInfoPanel model={buildModel()} compact />);
      expect(screen.getByText('Input Price / 1k Tokens')).toBeInTheDocument();
      expect(screen.getByText('Output Price / 1k Tokens')).toBeInTheDocument();
    });

    it('renders capacity', () => {
      render(<ModelInfoPanel model={buildModel({ contextLength: 200_000 })} compact />);
      expect(screen.getByText(/200,000 tokens/)).toBeInTheDocument();
    });
  });

  describe('Smart Model entry', () => {
    const smartModel = buildModel({
      id: 'smart-model',
      name: 'Auto (best for prompt)',
      isSmartModel: true,
      minPricing: { inputPerToken: '1000', outputPerToken: '2000' },
      maxPricing: {
        inputPerToken: '60000',
        outputPerToken: '240000',
      },
    });

    it('renders how it works section', () => {
      render(<ModelInfoPanel model={smartModel} />);
      expect(screen.getByText('How It Works')).toBeInTheDocument();
      expect(screen.getByText(/Analyzes each message/)).toBeInTheDocument();
    });

    it('renders price ranges', () => {
      render(<ModelInfoPanel model={smartModel} />);
      expect(screen.getByText('Input Price Range')).toBeInTheDocument();
      expect(screen.getByText('Output Price Range')).toBeInTheDocument();
    });

    it('renders capacity', () => {
      render(<ModelInfoPanel model={smartModel} />);
      expect(screen.getByText(/128,000 tokens/)).toBeInTheDocument();
    });

    it('shows Varies when a pool bound is absent', () => {
      render(<ModelInfoPanel model={buildModel({ isSmartModel: true })} />);
      expect(screen.getAllByText('Varies').length).toBeGreaterThan(0);
    });

    it('compact Smart Model omits how it works', () => {
      render(<ModelInfoPanel model={smartModel} compact />);
      expect(screen.queryByText('How It Works')).not.toBeInTheDocument();
      expect(screen.getByText('Input Price Range')).toBeInTheDocument();
    });
  });

  describe('image modality', () => {
    const imageModel: Model = {
      id: 'google/imagen-4',
      name: 'Imagen 4',
      provider: 'Google',
      modality: 'image' as const,
      contextLength: 0,
      pricing: { perImage: '40000000', dearestPerImage: '40000000' },
      description: 'Image generation model.',
      supportedParameters: [],
    };

    it('renders provider', () => {
      render(<ModelInfoPanel model={imageModel} />);
      expect(screen.getByText('Google')).toBeInTheDocument();
    });

    it('renders the billable price per image', () => {
      render(<ModelInfoPanel model={imageModel} />);
      expect(screen.getByText('Price per Image')).toBeInTheDocument();
      // Billable $0.04 renders as-is at 3 decimals.
      expect(screen.getByText('$0.040/image')).toBeInTheDocument();
    });

    it('renders description', () => {
      render(<ModelInfoPanel model={imageModel} />);
      expect(screen.getByText('Image generation model.')).toBeInTheDocument();
    });

    it('does not render token-based pricing', () => {
      render(<ModelInfoPanel model={imageModel} />);
      expect(screen.queryByText('Input Price / 1k Tokens')).not.toBeInTheDocument();
      expect(screen.queryByText('Output Price / 1k Tokens')).not.toBeInTheDocument();
    });

    it('does not render capacity', () => {
      render(<ModelInfoPanel model={imageModel} />);
      expect(screen.queryByText('Capacity Limit')).not.toBeInTheDocument();
    });

    it('does not render expensive model warning', () => {
      render(<ModelInfoPanel model={imageModel} />);
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('renders compactly without a description', () => {
      render(<ModelInfoPanel model={imageModel} compact />);
      expect(screen.getByText('Price per Image')).toBeInTheDocument();
      expect(screen.queryByText('Image generation model.')).not.toBeInTheDocument();
    });

    it('shows no per-image price at all when the catalog carries no rate', () => {
      // A rate the catalog does not carry is not a rate of zero: displaying
      // "$0.000/image" tells the user this model is free.
      const ratelessImage: Model = { ...imageModel, pricing: {} };
      // Parsing both rows pins the premise this guard rests on: the wire
      // contract refuses an image row carrying no per-image rate, so no endpoint
      // can emit one and the panel is being handed input only a bug could
      // produce. The priced row is the control that keeps the check from passing
      // vacuously; should the contract ever admit the rateless one, this fails
      // instead of the guard quietly going idle.
      expect([imageModel, ratelessImage].map((m) => modelSchema.safeParse(m).success)).toEqual([
        true,
        false,
      ]);

      render(<ModelInfoPanel model={ratelessImage} />);
      expect(screen.queryByText('Price per Image')).not.toBeInTheDocument();
      expect(screen.queryByText(/\$0\.000\/image/)).not.toBeInTheDocument();
    });
  });

  describe('video modality', () => {
    const videoModel: Model = {
      id: 'google/veo-3.1',
      name: 'Veo 3.1',
      provider: 'Google',
      modality: 'video' as const,
      contextLength: 0,
      pricing: {
        perSecondByResolution: { '720p': '200000000', '1080p': '400000000', '4k': '800000000' },
        dearestPerSecondByResolution: {
          '720p': '200000000',
          '1080p': '400000000',
          '4k': '800000000',
        },
      },
      description: 'Video generation model.',
      supportedParameters: [],
    };

    it('renders provider', () => {
      render(<ModelInfoPanel model={videoModel} />);
      expect(screen.getByText('Google')).toBeInTheDocument();
    });

    it('renders pricing-by-resolution table', () => {
      render(<ModelInfoPanel model={videoModel} />);
      expect(screen.getByText('Resolution')).toBeInTheDocument();
      expect(screen.getByText('$/second')).toBeInTheDocument();
    });

    it('renders each resolution row with the billable price', () => {
      render(<ModelInfoPanel model={videoModel} />);
      // Billable $/s renders as-is: 0.20, 0.40, 0.80.
      expect(screen.getByText('720p')).toBeInTheDocument();
      expect(screen.getByText('$0.20/s')).toBeInTheDocument();
      expect(screen.getByText('1080p')).toBeInTheDocument();
      expect(screen.getByText('$0.40/s')).toBeInTheDocument();
      expect(screen.getByText('4k')).toBeInTheDocument();
      expect(screen.getByText('$0.80/s')).toBeInTheDocument();
    });

    it('orders resolutions 720p before 1080p before 4k', () => {
      render(<ModelInfoPanel model={videoModel} />);
      const sd = screen.getByText('720p');
      const hd = screen.getByText('1080p');
      const ultra = screen.getByText('4k');
      expect(sd.compareDocumentPosition(hd) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(hd.compareDocumentPosition(ultra) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('renders description', () => {
      render(<ModelInfoPanel model={videoModel} />);
      expect(screen.getByText('Video generation model.')).toBeInTheDocument();
    });

    it('does not render token-based pricing', () => {
      render(<ModelInfoPanel model={videoModel} />);
      expect(screen.queryByText('Input Price / 1k Tokens')).not.toBeInTheDocument();
      expect(screen.queryByText('Output Price / 1k Tokens')).not.toBeInTheDocument();
    });

    it('does not render capacity', () => {
      render(<ModelInfoPanel model={videoModel} />);
      expect(screen.queryByText('Capacity Limit')).not.toBeInTheDocument();
    });

    it('does not render expensive model warning', () => {
      render(<ModelInfoPanel model={videoModel} />);
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('renders compactly', () => {
      render(<ModelInfoPanel model={videoModel} compact />);
      expect(screen.getByText('720p')).toBeInTheDocument();
      expect(screen.queryByText('Video generation model.')).not.toBeInTheDocument();
    });

    it('sorts unknown resolutions after known ones and alphabetically among themselves', () => {
      const mixed: Model = {
        ...videoModel,
        pricing: {
          perSecondByResolution: { zeta: '500000000', '720p': '200000000', alpha: '300000000' },
          dearestPerSecondByResolution: {
            zeta: '500000000',
            '720p': '200000000',
            alpha: '300000000',
          },
        },
      };
      render(<ModelInfoPanel model={mixed} />);

      const known = screen.getByText('720p');
      const alpha = screen.getByText('alpha');
      const zeta = screen.getByText('zeta');
      // Known resolution precedes both unknowns; unknowns sort alphabetically.
      expect(known.compareDocumentPosition(alpha) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(alpha.compareDocumentPosition(zeta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('shows no pricing table at all when the catalog carries no rates', () => {
      // An empty price table is a price surface for a model that has no price;
      // absent rates show nothing rather than an unpriced table.
      const ratelessVideo: Model = { ...videoModel, pricing: {} };
      expect([videoModel, ratelessVideo].map((m) => modelSchema.safeParse(m).success)).toEqual([
        true,
        false,
      ]);

      render(<ModelInfoPanel model={ratelessVideo} />);
      expect(screen.queryByText('Pricing by Resolution')).not.toBeInTheDocument();
      expect(screen.queryByText('$/second')).not.toBeInTheDocument();
    });
  });

  describe('audio modality', () => {
    const audioModel: Model = {
      id: 'openai/tts-1',
      name: 'TTS 1',
      provider: 'OpenAI',
      modality: 'audio' as const,
      contextLength: 0,
      pricing: {},
      description: 'Audio synthesis model.',
      supportedParameters: [],
    };

    it('renders provider', () => {
      render(<ModelInfoPanel model={audioModel} />);
      expect(screen.getByText('OpenAI')).toBeInTheDocument();
    });

    it('renders no price row (audio carries no wire pricing)', () => {
      render(<ModelInfoPanel model={audioModel} />);
      expect(screen.queryByText('Price per Second')).not.toBeInTheDocument();
    });

    it('renders description', () => {
      render(<ModelInfoPanel model={audioModel} />);
      expect(screen.getByText('Audio synthesis model.')).toBeInTheDocument();
    });

    it('does not render token-based pricing', () => {
      render(<ModelInfoPanel model={audioModel} />);
      expect(screen.queryByText('Input Price / 1k Tokens')).not.toBeInTheDocument();
      expect(screen.queryByText('Output Price / 1k Tokens')).not.toBeInTheDocument();
    });

    it('does not render capacity', () => {
      render(<ModelInfoPanel model={audioModel} />);
      expect(screen.queryByText('Capacity Limit')).not.toBeInTheDocument();
    });

    it('does not render expensive model warning', () => {
      render(<ModelInfoPanel model={audioModel} />);
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('renders compactly without a description', () => {
      render(<ModelInfoPanel model={audioModel} compact />);
      expect(screen.getByText('OpenAI')).toBeInTheDocument();
      expect(screen.queryByText('Audio synthesis model.')).not.toBeInTheDocument();
    });
  });

  describe('long conversations', () => {
    it('shows a long-context rate with its threshold', () => {
      render(<ModelInfoPanel model={sonnet} />);
      const group = longContextGroup();
      expect(within(group).getByText(/200,000/)).toBeInTheDocument();
      expect(within(group).getByText('$0.0069 / 1k')).toBeInTheDocument();
      expect(within(group).getByText('$0.025875 / 1k')).toBeInTheDocument();
    });

    it('labels the group as long conversations', () => {
      render(<ModelInfoPanel model={sonnet} />);
      expect(within(longContextGroup()).getByText('Long Conversations')).toBeInTheDocument();
    });

    it('says the rate applies to the whole reply once the threshold is passed', () => {
      render(<ModelInfoPanel model={sonnet} />);
      expect(
        within(longContextGroup()).getByText(
          'Once a conversation passes 200,000 tokens, the whole reply is billed at:'
        )
      ).toBeInTheDocument();
    });

    it('states a threshold that is not a round thousand as its exact token count', () => {
      render(<ModelInfoPanel model={offRoundThreshold} />);
      expect(
        within(longContextGroup()).getByText(
          'Once a conversation passes 40,960 tokens, the whole reply is billed at:'
        )
      ).toBeInTheDocument();
    });

    it('names each side of the long-context rate as a term', () => {
      render(<ModelInfoPanel model={sonnet} />);
      const terms = within(longContextGroup())
        .getAllByRole('term')
        .map((term) => term.textContent);
      expect(terms).toEqual(['Input', 'Output']);
    });

    it('shows no long-conversation group for a model without a long-context rate', () => {
      render(<ModelInfoPanel model={buildModel()} />);
      expect(screen.queryByTestId(TEST_IDS.modelLongContextRates)).not.toBeInTheDocument();
    });

    it('shows every long-context rate in ascending threshold order', () => {
      render(<ModelInfoPanel model={twoThresholds} />);
      const group = longContextGroup();
      const lower = within(group).getByText(/passes 128,000 tokens/);
      const higher = within(group).getByText(/passes 272,000 tokens/);
      expect(precedes(lower, higher)).toBe(true);
    });

    it('shows each threshold its own rates', () => {
      render(<ModelInfoPanel model={twoThresholds} />);
      const definitions = within(longContextGroup())
        .getAllByRole('definition')
        .map((definition) => definition.textContent);
      expect(definitions).toEqual(['$0.0025 / 1k', '$0.015 / 1k', '$0.005 / 1k', '$0.02 / 1k']);
    });

    it('drops the side of a long-context rate that carries no figure', () => {
      vi.mocked(priceDisplayOf).mockImplementation((model) => ({
        ...actualFacts.priceDisplayOf(model),
        longContext: [{ abovePromptTokens: 200_000, inputPer1k: '$0.0069' }],
      }));
      render(<ModelInfoPanel model={sonnet} />);
      const terms = within(longContextGroup())
        .getAllByRole('term')
        .map((term) => term.textContent);
      expect(terms).toEqual(['Input']);
    });

    it('shows the long-conversation group in compact mode', () => {
      render(<ModelInfoPanel model={sonnet} compact />);
      expect(within(longContextGroup()).getByText('$0.025875 / 1k')).toBeInTheDocument();
    });

    it.each([
      ['full', false],
      ['compact', true],
    ])(
      'places the group after the expensive warning and before the note (%s)',
      (_mode, compact) => {
        render(<ModelInfoPanel model={expensiveTiered} compact={compact} />);
        const output = screen.getByText('Output Price / 1k Tokens');
        const warning = screen.getByTestId(TEST_IDS.expensiveModelWarning);
        const group = longContextGroup();
        const note = screen.getByTestId(TEST_IDS.modelPriceReference);
        expect([
          precedes(output, warning),
          precedes(warning, group),
          precedes(group, note),
        ]).toEqual([true, true, true]);
      }
    );
  });

  describe('price reference note', () => {
    const imageModel: Model = {
      id: 'google/imagen-4',
      name: 'Imagen 4',
      provider: 'Google',
      modality: 'image' as const,
      contextLength: 0,
      pricing: { perImage: '40000000', dearestPerImage: '40000000' },
      description: 'Image generation model.',
      supportedParameters: [],
    };
    const videoModel: Model = {
      id: 'google/veo-3.1',
      name: 'Veo 3.1',
      provider: 'Google',
      modality: 'video' as const,
      contextLength: 0,
      pricing: {
        perSecondByResolution: { '720p': '200000000' },
        dearestPerSecondByResolution: { '720p': '200000000' },
      },
      description: 'Video generation model.',
      supportedParameters: [],
    };
    const audioModel: Model = {
      id: 'openai/tts-1',
      name: 'TTS 1',
      provider: 'OpenAI',
      modality: 'audio' as const,
      contextLength: 0,
      pricing: {},
      description: 'Audio synthesis model.',
      supportedParameters: [],
    };
    const smartModel = buildModel({
      id: 'smart-model',
      name: 'Smart Model',
      isSmartModel: true,
      minPricing: { inputPerToken: '1000', outputPerToken: '2000' },
      maxPricing: {
        inputPerToken: '60000',
        outputPerToken: '240000',
      },
    });

    it.each([
      ['a text model', buildModel(), false],
      ['a text model in compact mode', buildModel(), true],
      ['a long-context text model', sonnet, false],
      ['an image model', imageModel, false],
      ['an image model in compact mode', imageModel, true],
      ['a video model', videoModel, false],
      ['a video model in compact mode', videoModel, true],
      ['the Smart Model', smartModel, false],
      ['the Smart Model in compact mode', smartModel, true],
    ])('says once that prices are references for %s', (_name, model, compact) => {
      render(<ModelInfoPanel model={model} compact={compact} />);
      const notes = screen.getAllByTestId(TEST_IDS.modelPriceReference);
      expect(notes.map((note) => note.textContent)).toEqual([PRICE_REFERENCE]);
    });

    it.each([
      ['an audio model', audioModel],
      ['a text model with no rates', buildModel({ pricing: {} })],
      ['an image model with no per-image rate', { ...imageModel, pricing: {} }],
      ['a video model with no resolution rates', { ...videoModel, pricing: {} }],
      ['the Smart Model with no pool bounds', buildModel({ isSmartModel: true })],
    ])('shows no price reference for %s, which shows no price', (_name, model) => {
      render(<ModelInfoPanel model={model} />);
      expect(screen.queryByTestId(TEST_IDS.modelPriceReference)).not.toBeInTheDocument();
    });

    it.each([
      [
        'input',
        { anchorContextTokens: 1_000_000, inputPerToken: '1000' },
        { anchorContextTokens: 1_000_000, inputPerToken: '60000' },
      ],
      ['output', { outputPerToken: '2000' }, { outputPerToken: '240000' }],
    ])(
      'says once that prices are references for a Smart Model pool serving only its %s range',
      (_side, minPricing, maxPricing) => {
        render(
          <ModelInfoPanel model={buildModel({ isSmartModel: true, minPricing, maxPricing })} />
        );
        expect(screen.getAllByTestId(TEST_IDS.modelPriceReference)).toHaveLength(1);
      }
    );

    it.each([
      ['input', { inputPer1k: '$0.0025' }],
      ['output', { outputPer1k: '$0.01' }],
    ])(
      'says once that prices are references for a text model whose display carries only its %s rate',
      (_side, rate) => {
        vi.mocked(priceDisplayOf).mockImplementation(() => ({
          longContext: [],
          expensive: false,
          ...rate,
        }));
        render(<ModelInfoPanel model={buildModel()} />);
        expect(screen.getAllByTestId(TEST_IDS.modelPriceReference)).toHaveLength(1);
      }
    );

    it('places the note after the text rates and before capacity', () => {
      render(<ModelInfoPanel model={buildModel()} />);
      const note = screen.getByTestId(TEST_IDS.modelPriceReference);
      expect([
        precedes(screen.getByText('Output Price / 1k Tokens'), note),
        precedes(note, screen.getByText('Capacity Limit')),
      ]).toEqual([true, true]);
    });

    it('places the note after the per-image price and before the description', () => {
      render(<ModelInfoPanel model={imageModel} />);
      const note = screen.getByTestId(TEST_IDS.modelPriceReference);
      expect([
        precedes(screen.getByText('$0.040/image'), note),
        precedes(note, screen.getByText('Image generation model.')),
      ]).toEqual([true, true]);
    });

    it('places the note after the resolution table and before the description', () => {
      render(<ModelInfoPanel model={videoModel} />);
      const note = screen.getByTestId(TEST_IDS.modelPriceReference);
      expect([
        precedes(screen.getByText('$0.20/s'), note),
        precedes(note, screen.getByText('Video generation model.')),
      ]).toEqual([true, true]);
    });

    it('places the note after the Smart Model ranges and before capacity', () => {
      render(<ModelInfoPanel model={smartModel} />);
      const note = screen.getByTestId(TEST_IDS.modelPriceReference);
      expect([
        precedes(screen.getByText('Output Price Range'), note),
        precedes(note, screen.getByText('Capacity Limit')),
      ]).toEqual([true, true]);
    });

    it('writes the long-conversation explanation and the price-reference note without a long dash', () => {
      render(<ModelInfoPanel model={sonnet} />);
      const sentences = [
        within(longContextGroup()).getByText(/^Once a conversation passes/).textContent,
        screen.getByTestId(TEST_IDS.modelPriceReference).textContent,
      ].join(' ');
      expect(sentences).not.toMatch(/[\u2013\u2014]/);
    });
  });
});
