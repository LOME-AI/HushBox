import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MAX_SELECTED_MODELS, type Model } from '@hushbox/shared';
import { ModelListBody } from '@/components/chat/model-selector/model-list-body';
import { modalityUnavailableMessage } from '@/components/chat/model-selector/modality-unavailable-message';
import type { ModelListBodyProps } from '@/components/chat/model-selector/model-list-body';

vi.mock('@/components/chat/model-selector/model-list-item', () => ({
  ModelListItem: ({ model, isDisabled }: { model: Model; isDisabled: boolean }) => (
    <div data-testid={`item-${model.id}`} data-disabled={String(isDisabled)}>
      {model.name}
    </div>
  ),
}));

function makeModel(id: string): Model {
  return {
    id,
    name: `Model ${id}`,
    description: 'A test model',
    provider: 'p',
    modality: 'text',
    contextLength: 1000,
    supportedParameters: [],
    pricing: { inputPerToken: '10000', outputPerToken: '20000' },
  };
}

function baseProps(overrides: Partial<ModelListBodyProps> = {}): ModelListBodyProps {
  return {
    filteredModels: [makeModel('a'), makeModel('b')],
    modalityIsEmpty: false,
    activeModality: 'text',
    pickerMode: 'single',
    selectedIds: new Set<string>(),
    localSelectedIds: new Set<string>(),
    focusedModelId: '',
    expandedModelId: null,
    availabilityOf: () => ({ available: true }),
    isMobile: false,
    pulsingModelId: null,
    getPinnedLabel: (): string | undefined => '',
    onActivate: vi.fn(),
    onHover: vi.fn(),
    onShowInfo: vi.fn(),
    onToggleExpand: vi.fn(),
    ...overrides,
  };
}

describe('ModelListBody', () => {
  it('renders one row per filtered model', () => {
    render(<ModelListBody {...baseProps()} />);
    expect(screen.getByTestId('item-a')).toBeInTheDocument();
    expect(screen.getByTestId('item-b')).toBeInTheDocument();
  });

  it('disables unselected rows once the multi-select limit is reached', () => {
    const selected = new Set(
      Array.from({ length: MAX_SELECTED_MODELS }, (_v, index) => `sel-${String(index)}`)
    );
    const models = [...[...selected].map((id) => makeModel(id)), makeModel('extra')];

    render(
      <ModelListBody
        {...baseProps({ pickerMode: 'multi', localSelectedIds: selected, filteredModels: models })}
      />
    );

    expect(screen.getByTestId('item-extra')).toHaveAttribute('data-disabled', 'true');
    expect(screen.getByTestId('item-sel-0')).toHaveAttribute('data-disabled', 'false');
  });

  it('shows an empty state when there are no models', () => {
    render(<ModelListBody {...baseProps({ filteredModels: [] })} />);
    expect(screen.getByText('No models found')).toBeInTheDocument();
  });

  it('states the capability is unavailable when the modality carries no models', () => {
    render(
      <ModelListBody
        {...baseProps({ filteredModels: [], modalityIsEmpty: true, activeModality: 'video' })}
      />
    );
    expect(screen.getByText(modalityUnavailableMessage('video'))).toBeInTheDocument();
  });

  // The regression this guards is worse than the bug it accompanies: a user who
  // mistypes a model name must never be told the capability is off for privacy.
  it('keeps the search empty state when the modality has models but none match', () => {
    render(<ModelListBody {...baseProps({ filteredModels: [] })} />);
    expect(screen.getByText('No models found')).toBeInTheDocument();
    expect(screen.queryByText(modalityUnavailableMessage('text'))).not.toBeInTheDocument();
  });

  it('announces the unavailability through a live region', () => {
    render(
      <ModelListBody
        {...baseProps({ filteredModels: [], modalityIsEmpty: true, activeModality: 'video' })}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent(modalityUnavailableMessage('video'));
  });

  it('keeps the unavailability message out of the listbox, where it is not an option', () => {
    render(
      <ModelListBody
        {...baseProps({ filteredModels: [], modalityIsEmpty: true, activeModality: 'video' })}
      />
    );
    const listbox = screen.getByRole('listbox', { name: 'Models' });
    expect(listbox).toBeEmptyDOMElement();
  });
});
