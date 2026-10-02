import * as React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { OLD_RELEASE_SECONDS } from '@hushbox/shared/test-time';
import { UsageFilters, type DateRangePreset } from './usage-filters';
import type { Model } from '@hushbox/shared';
import type { Mock } from 'vitest';
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

// Radix Select drives its listbox through pointer-capture APIs the test DOM
// lacks, so the select field is swapped for a native <select> that keeps its
// label (hidden as the field hides it), trigger test id, value, options and
// `onValueChange` observable.
vi.mock('@hushbox/ui/field', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui/field')>();

  function SelectFieldMock({
    label,
    labelHidden = false,
    triggerTestId,
    value,
    onValueChange,
    options,
  }: Readonly<{
    label: string;
    labelHidden?: boolean;
    triggerTestId?: string;
    value: string;
    onValueChange: (next: string) => void;
    options: readonly { value: string; label: string }[];
  }>): React.JSX.Element {
    const id = React.useId();
    return (
      <div>
        <label htmlFor={id} className={labelHidden ? 'sr-only' : undefined}>
          {label}
        </label>
        <select
          id={id}
          data-testid={triggerTestId}
          value={value}
          onChange={(event) => {
            onValueChange(event.target.value);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
    );
  }

  return { ...actual, SelectField: SelectFieldMock };
});

function modelSelect(): HTMLSelectElement {
  return screen.getByTestId<HTMLSelectElement>(TEST_IDS.modelFilter);
}

function setup(overrides: Partial<React.ComponentProps<typeof UsageFilters>> = {}): {
  onRangeChange: Mock;
  onModelChange: Mock;
} {
  const onRangeChange = vi.fn();
  const onModelChange = vi.fn();
  const props: React.ComponentProps<typeof UsageFilters> = {
    range: '30d',
    onRangeChange,
    model: undefined,
    onModelChange,
    availableModels: ['GPT-4', 'Claude'],
    ...overrides,
  };
  render(<UsageFilters {...props} />);
  return { onRangeChange, onModelChange };
}

describe('UsageFilters', () => {
  beforeEach(() => {
    catalogRef.current = undefined;
  });

  it('renders the filter container', () => {
    setup();
    expect(screen.getByTestId(TEST_IDS.usageFilters)).toBeInTheDocument();
  });

  it('renders every date-range preset button', () => {
    setup();
    for (const preset of ['7d', '30d', '90d', 'all'] as DateRangePreset[]) {
      expect(screen.getByTestId(TEST_ID_BUILDERS.range(preset))).toBeInTheDocument();
    }
  });

  it('calls onRangeChange with the clicked preset', () => {
    const { onRangeChange } = setup();
    fireEvent.click(screen.getByTestId(TEST_ID_BUILDERS.range('7d')));
    expect(onRangeChange).toHaveBeenCalledWith('7d');
  });

  it('groups the presets under the name "Date range"', () => {
    setup();
    const group = screen.getByRole('group', { name: 'Date range' });
    expect(within(group).getAllByRole('button')).toHaveLength(4);
  });

  it('marks the active preset pressed', () => {
    setup({ range: '90d' });
    expect(screen.getByRole('button', { name: '90d' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('marks every other preset not pressed', () => {
    setup({ range: '90d' });
    for (const name of ['7d', '30d', 'All']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('names the model filter "Model"', () => {
    setup();
    expect(screen.getByRole('combobox', { name: 'Model' })).toBe(modelSelect());
  });

  it('keeps the model label out of view', () => {
    setup();
    expect(screen.getByText('Model')).toHaveClass('sr-only');
  });

  it('offers "All Models" first', () => {
    setup();
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('All Models');
  });

  it('marks the active preset with the default variant', () => {
    setup({ range: '90d' });
    const active = screen.getByTestId(TEST_ID_BUILDERS.range('90d'));
    const inactive = screen.getByTestId(TEST_ID_BUILDERS.range('7d'));
    // The default button variant lacks the outline border class the inactive ones carry.
    expect(active.className).not.toEqual(inactive.className);
  });

  it('renders an option per available model', () => {
    setup({ availableModels: ['GPT-4', 'Claude'] });
    expect(screen.getByRole('option', { name: 'GPT-4' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Claude' })).toBeInTheDocument();
  });

  it('selects "all" when no model is set', () => {
    setup({ model: undefined });
    expect(modelSelect().value).toBe('all');
  });

  it('reflects the currently selected model', () => {
    setup({ model: 'GPT-4' });
    expect(modelSelect().value).toBe('GPT-4');
  });

  it('calls onModelChange with the chosen model', () => {
    const { onModelChange } = setup();
    fireEvent.change(modelSelect(), { target: { value: 'Claude' } });
    expect(onModelChange).toHaveBeenCalledWith('Claude');
  });

  it('maps the "all" option back to undefined', () => {
    const { onModelChange } = setup({ model: 'GPT-4' });
    fireEvent.change(modelSelect(), { target: { value: 'all' } });
    expect(onModelChange).toHaveBeenCalledWith(undefined);
  });

  it('names each model option by its catalog display name', () => {
    catalogRef.current = [catalogModel('fictional/large-4.1', 'Large Model 4.1')];
    setup({ availableModels: ['fictional/large-4.1'] });
    expect(screen.getByRole('option', { name: 'Large Model 4.1' })).toBeInTheDocument();
  });

  it('keeps the model id as the value of a display-named option', () => {
    catalogRef.current = [catalogModel('fictional/large-4.1', 'Large Model 4.1')];
    const { onModelChange } = setup({ availableModels: ['fictional/large-4.1'] });
    fireEvent.change(modelSelect(), { target: { value: 'fictional/large-4.1' } });
    expect(onModelChange).toHaveBeenCalledWith('fictional/large-4.1');
  });

  it('names a model the catalog lacks by its id', () => {
    catalogRef.current = [catalogModel('fictional/large-4.1', 'Large Model 4.1')];
    setup({ availableModels: ['fictional/retired'] });
    expect(screen.getByRole('option', { name: 'fictional/retired' })).toBeInTheDocument();
  });
});
