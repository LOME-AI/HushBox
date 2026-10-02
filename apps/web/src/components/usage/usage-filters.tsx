import * as React from 'react';
import { Button } from '@hushbox/ui/button';
import { SelectField } from '@hushbox/ui/field';
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import { useUsageModelLabels } from './use-usage-model-labels';

export type DateRangePreset = '7d' | '30d' | '90d' | 'all';

interface UsageFiltersProps {
  range: DateRangePreset;
  onRangeChange: (range: DateRangePreset) => void;
  model: string | undefined;
  onModelChange: (model: string | undefined) => void;
  availableModels: readonly string[];
}

const ALL_MODELS = 'all';

const PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: '90d', label: '90d' },
  { value: 'all', label: 'All' },
];

export function UsageFilters({
  range,
  onRangeChange,
  model,
  onModelChange,
  availableModels,
}: Readonly<UsageFiltersProps>): React.JSX.Element {
  const labels = useUsageModelLabels();

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3"
      data-testid={TEST_IDS.usageFilters}
    >
      <div
        role="group"
        aria-label="Date range"
        className="flex flex-wrap gap-1"
        data-testid={TEST_IDS.dateRangeButtons}
      >
        {PRESETS.map((preset) => (
          <Button
            key={preset.value}
            variant={range === preset.value ? 'default' : 'outline'}
            size="sm"
            aria-pressed={range === preset.value}
            onClick={() => {
              onRangeChange(preset.value);
            }}
            data-testid={TEST_ID_BUILDERS.range(preset.value)}
          >
            {preset.label}
          </Button>
        ))}
      </div>
      <div className="min-w-0 flex-[0_1_12rem]">
        <SelectField
          label="Model"
          labelHidden
          triggerTestId={TEST_IDS.modelFilter}
          value={model ?? ALL_MODELS}
          onValueChange={(v) => {
            onModelChange(v === ALL_MODELS ? undefined : v);
          }}
          options={[
            { value: ALL_MODELS, label: 'All Models' },
            ...availableModels.map((m) => ({ value: m, label: labels.name(m) })),
          ]}
        />
      </div>
    </div>
  );
}
