import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useOverlayPresentation } from '@hushbox/ui/overlay';
import { TEST_IDS, type Model } from '@hushbox/shared';
import {
  ModelSelectorFrame,
  ModelSelectorModalLayout,
} from '@/components/chat/model-selector/model-selector-layout';
import type { ModelSelectorModalLayoutProps } from '@/components/chat/model-selector/model-selector-layout';
import type { SearchAndSortSectionProps } from '@/components/chat/model-selector/search-and-sort-section';
import type { ModelListBodyProps } from '@/components/chat/model-selector/model-list-body';

vi.mock('@hushbox/ui/overlay', () => ({
  useOverlayPresentation: vi.fn<typeof useOverlayPresentation>(() => 'dialog'),
}));

vi.mock('@/components/chat/model-selector/model-info-panel', () => ({
  ModelInfoPanel: ({ model }: { model: Model }) => (
    <div data-testid="model-info-panel">{model.name}</div>
  ),
}));

vi.mock('@/components/chat/model-selector/picker-mode-toggle', () => ({
  PickerModeToggle: () => <div data-testid="picker-mode-toggle" />,
}));

vi.mock('@/components/chat/model-selector/search-and-sort-section', () => ({
  SearchAndSortSection: () => <div data-testid="search-and-sort" />,
}));

vi.mock('@/components/chat/model-selector/model-list-body', () => ({
  ModelListBody: () => <div data-testid="model-list-body" />,
}));

const searchAndSortProps = {} as unknown as SearchAndSortSectionProps;
const modelListBodyProps = {} as unknown as ModelListBodyProps;

function baseProps(
  overrides: Partial<ModelSelectorModalLayoutProps> = {}
): ModelSelectorModalLayoutProps {
  return {
    isMobile: false,
    pickerMode: 'single',
    multiLabel: 'Multi',
    searchAndSortProps,
    handleModeChange: vi.fn(),
    focusedModel: undefined,
    modelListBodyProps,
    footer: <div data-testid="footer" />,
    ...overrides,
  };
}

describe('ModelSelectorModalLayout', () => {
  it('renders the desktop details panel with model info when a model is focused', () => {
    const focusedModel: Model = {
      id: 'm1',
      name: 'Focused Model',
      description: 'Focused Model',
      provider: 'Acme',
      modality: 'text',
      contextLength: 1000,
      supportedParameters: [],
      pricing: { inputPerToken: '1000000000', outputPerToken: '2000000000' },
    };
    render(<ModelSelectorModalLayout {...baseProps({ focusedModel })} />);

    expect(screen.getByTestId(TEST_IDS.modelDetailsPanel)).toBeInTheDocument();
    expect(screen.getByTestId('model-info-panel')).toHaveTextContent('Focused Model');
  });

  it('renders the desktop details panel empty when no model is focused', () => {
    render(<ModelSelectorModalLayout {...baseProps({ focusedModel: undefined })} />);

    expect(screen.getByTestId(TEST_IDS.modelDetailsPanel)).toBeInTheDocument();
    expect(screen.queryByTestId('model-info-panel')).not.toBeInTheDocument();
  });

  it('renders the mobile top section and no desktop right column on mobile', () => {
    render(<ModelSelectorModalLayout {...baseProps({ isMobile: true })} />);

    expect(screen.getByTestId(TEST_IDS.pickerModeToggleWrapper)).toBeInTheDocument();
    expect(screen.queryByTestId(TEST_IDS.modelDetailsPanel)).not.toBeInTheDocument();
  });

  it('renders the footer', () => {
    render(<ModelSelectorModalLayout {...baseProps()} />);
    expect(screen.getByTestId('footer')).toBeInTheDocument();
  });

  describe('its frame', () => {
    afterEach(() => {
      vi.mocked(useOverlayPresentation).mockReturnValue('dialog');
    });

    it('draws its own card in a dialog', () => {
      vi.mocked(useOverlayPresentation).mockReturnValue('dialog');
      render(<ModelSelectorModalLayout {...baseProps()} />);

      expect(screen.getByTestId(TEST_IDS.modelSelectorModal)).toHaveClass(
        'w-[90vw]',
        'max-w-4xl',
        'rounded-lg',
        'border',
        'shadow-lg'
      );
    });

    it('spans a sheet with no rule under the handle', () => {
      vi.mocked(useOverlayPresentation).mockReturnValue('sheet');
      render(<ModelSelectorModalLayout {...baseProps({ isMobile: true })} />);

      const frame = screen.getByTestId(TEST_IDS.modelSelectorModal);
      expect(frame).toHaveClass('w-full', 'min-h-0');
      // The rule's 1px stays in the layout, undrawn, so nothing below it moves.
      expect(frame).toHaveClass('border-t', 'border-transparent');
      for (const card of ['w-[90vw]', 'max-w-4xl', 'rounded-lg', 'border', 'shadow-lg']) {
        expect(frame).not.toHaveClass(card);
      }
    });

    it('publishes the frame it draws, for a harness to render', () => {
      vi.mocked(useOverlayPresentation).mockReturnValue('sheet');
      render(
        <ModelSelectorFrame isMobile>
          <p>rows</p>
        </ModelSelectorFrame>
      );

      const frame = screen.getByText('rows').parentElement;
      expect(frame).toHaveClass('w-full', 'min-h-0', 'h-[92dvh]');
    });
  });
});
