import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import type { Model } from '@hushbox/shared';
import { ModelInfoPanel } from './model-info-panel';

function buildModel(overrides: Partial<Model> = {}): Model {
  return {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    provider: 'OpenAI',
    contextLength: 128_000,
    pricePerInputToken: 0.000_002_5,
    pricePerOutputToken: 0.000_01,
    capabilities: [],
    description: 'Fast and capable model from OpenAI.',
    supportedParameters: [],
    ...overrides,
  };
}

describe('ModelInfoPanel', () => {
  describe('full mode (default)', () => {
    it('renders provider name', () => {
      render(<ModelInfoPanel model={buildModel({ provider: 'Anthropic' })} />);
      expect(screen.getByText('Anthropic')).toBeInTheDocument();
    });

    it('renders input and output prices with fees applied', () => {
      render(<ModelInfoPanel model={buildModel()} />);
      expect(screen.getByText('Input Price / Token')).toBeInTheDocument();
      expect(screen.getByText('Output Price / Token')).toBeInTheDocument();
    });

    it('renders capacity in tokens', () => {
      render(<ModelInfoPanel model={buildModel({ contextLength: 128_000 })} />);
      expect(screen.getByText(/128,000 tokens/)).toBeInTheDocument();
    });

    it('renders capability badges', () => {
      render(<ModelInfoPanel model={buildModel({ capabilities: ['internet-search'] })} />);
      expect(screen.getByText('Internet Search')).toBeInTheDocument();
    });

    it('renders description', () => {
      render(<ModelInfoPanel model={buildModel({ description: 'A test description.' })} />);
      expect(screen.getByText('A test description.')).toBeInTheDocument();
    });

    it('renders expensive model warning for costly models', () => {
      render(
        <ModelInfoPanel
          model={buildModel({
            pricePerInputToken: 0.000_06,
            pricePerOutputToken: 0.000_24,
          })}
        />
      );
      expect(screen.getByTestId('expensive-model-warning')).toBeInTheDocument();
    });

    it('does not render expensive model warning for affordable models', () => {
      render(<ModelInfoPanel model={buildModel()} />);
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });
  });

  describe('compact mode', () => {
    it('omits description', () => {
      render(<ModelInfoPanel model={buildModel({ description: 'Should not appear.' })} compact />);
      expect(screen.queryByText('Should not appear.')).not.toBeInTheDocument();
      expect(screen.queryByText('Description')).not.toBeInTheDocument();
    });

    it('omits expensive model warning', () => {
      render(
        <ModelInfoPanel
          model={buildModel({
            pricePerInputToken: 0.000_06,
            pricePerOutputToken: 0.000_24,
          })}
          compact
        />
      );
      expect(screen.queryByTestId('expensive-model-warning')).not.toBeInTheDocument();
    });

    it('renders provider name', () => {
      render(<ModelInfoPanel model={buildModel({ provider: 'Google' })} compact />);
      expect(screen.getByText('Google')).toBeInTheDocument();
    });

    it('renders pricing', () => {
      render(<ModelInfoPanel model={buildModel()} compact />);
      expect(screen.getByText('Input Price / Token')).toBeInTheDocument();
      expect(screen.getByText('Output Price / Token')).toBeInTheDocument();
    });

    it('renders capacity', () => {
      render(<ModelInfoPanel model={buildModel({ contextLength: 200_000 })} compact />);
      expect(screen.getByText(/200,000 tokens/)).toBeInTheDocument();
    });

    it('renders capability badges', () => {
      render(<ModelInfoPanel model={buildModel({ capabilities: ['internet-search'] })} compact />);
      expect(screen.getByText('Internet Search')).toBeInTheDocument();
    });
  });

  describe('Smart Model entry', () => {
    const smartModel = buildModel({
      id: 'smart-model',
      name: 'Auto (best for prompt)',
      isSmartModel: true,
      minPricePerInputToken: 0.000_001,
      maxPricePerInputToken: 0.000_06,
      minPricePerOutputToken: 0.000_002,
      maxPricePerOutputToken: 0.000_24,
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

    it('compact Smart Model omits how it works', () => {
      render(<ModelInfoPanel model={smartModel} compact />);
      expect(screen.queryByText('How It Works')).not.toBeInTheDocument();
      expect(screen.getByText('Input Price Range')).toBeInTheDocument();
    });
  });
});
