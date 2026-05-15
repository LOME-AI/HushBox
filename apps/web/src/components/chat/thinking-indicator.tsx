import * as React from 'react';
import { shortenModelName } from '@hushbox/shared';
import { useModelStore } from '@/stores/model';
import { getGeneratingLabel } from '@/lib/modality-strings';
import { DotPulseIndicator } from './dot-pulse-indicator';

interface ThinkingIndicatorProps {
  modelName: string;
  /**
   * Optional pre-inference stage label (e.g., "Choosing the best model…").
   * When provided, it replaces the "X is thinking" text — the model name is
   * suppressed because the slot doesn't yet know which model will run.
   */
  stageLabel?: string;
}

export function ThinkingIndicator({
  modelName,
  stageLabel,
}: Readonly<ThinkingIndicatorProps>): React.JSX.Element {
  const activeModality = useModelStore((state) => state.activeModality);
  const displayName = shortenModelName(modelName) || 'AI';
  // For text modality keep the existing "is thinking" copy — "typing" reads
  // wrong for a pre-inference state. Media modalities use the shared
  // "is generating an image/video/audio" labels.
  const defaultLabel =
    activeModality === 'text'
      ? `${displayName} is thinking`
      : getGeneratingLabel(activeModality, displayName);
  const label = stageLabel ?? defaultLabel;

  return (
    <div
      role="status"
      aria-label={label}
      data-testid="thinking-indicator"
      className="text-muted-foreground flex items-center gap-1 text-sm"
    >
      <span>{label}</span>
      <DotPulseIndicator />
    </div>
  );
}
