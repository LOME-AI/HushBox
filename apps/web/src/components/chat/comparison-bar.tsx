import * as React from 'react';
import { X } from 'lucide-react';
import { Button, Tooltip, TooltipTrigger, TooltipContent } from '@hushbox/ui';
import type { Model } from '@hushbox/shared';
import { shortenModelName } from '@hushbox/shared';
import { getModelColor } from '../../lib/model-color';
import { ModelInfoPanel } from './model-info-panel';

interface ComparisonBarProps {
  models: Model[];
  selectedModels: { id: string; name: string }[];
  onRemoveModel: (modelId: string) => void;
}

function ModelPill({
  model,
  fullModel,
  onRemove,
}: Readonly<{
  model: { id: string; name: string };
  fullModel: Model | undefined;
  onRemove: () => void;
}>): React.JSX.Element {
  const color = getModelColor(model.id);
  const nameContent = <span className="whitespace-nowrap">{shortenModelName(model.name)}</span>;

  return (
    <div
      style={
        {
          '--pill-bg': color.bg,
          '--pill-fg': color.fg,
          '--pill-bg-dark': color.bgDark,
          '--pill-fg-dark': color.fgDark,
        } as React.CSSProperties
      }
      className="flex items-center gap-1 rounded-full bg-[var(--pill-bg)] px-3 py-1 text-sm text-[var(--pill-fg)] dark:bg-[var(--pill-bg-dark)] dark:text-[var(--pill-fg-dark)]"
    >
      {fullModel ? (
        <Tooltip>
          <TooltipTrigger asChild>{nameContent}</TooltipTrigger>
          <TooltipContent
            className="bg-popover text-popover-foreground [&>svg]:fill-popover [&>svg]:bg-popover w-64 rounded-lg border p-4 shadow-lg"
            sideOffset={8}
          >
            <ModelInfoPanel model={fullModel} compact />
          </TooltipContent>
        </Tooltip>
      ) : (
        nameContent
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-4 w-4 shrink-0 p-0"
        onClick={onRemove}
        aria-label={`Remove ${model.name}`}
      >
        <X className="h-3 w-3" />
      </Button>
    </div>
  );
}

export function ComparisonBar({
  models,
  selectedModels,
  onRemoveModel,
}: Readonly<ComparisonBarProps>): React.JSX.Element | null {
  if (selectedModels.length <= 1) {
    return null;
  }

  return (
    <div
      data-testid="selected-models-bar"
      className="border-border-strong flex items-center gap-2 overflow-x-auto border-b px-4 py-2"
    >
      {selectedModels.map((model) => (
        <ModelPill
          key={model.id}
          model={model}
          fullModel={models.find((m) => m.id === model.id)}
          onRemove={() => {
            onRemoveModel(model.id);
          }}
        />
      ))}
    </div>
  );
}
