import * as React from 'react';
import { MAX_SELECTED_MODELS } from '@hushbox/shared';
import { type PickerMode } from '@/stores/model';

import { ModelListItem } from '@/components/chat/model-selector/model-list-item';
import { modalityUnavailableMessage } from '@/components/chat/model-selector/modality-unavailable-message';
import type { Availability, ChatModality, Model } from '@hushbox/shared';

export interface ModelListBodyProps {
  filteredModels: Model[];
  /**
   * The active modality carries no models at all, as opposed to a search that
   * narrowed it to nothing. The two empty states must never be conflated: a
   * user who mistypes a model name would otherwise be told the capability is
   * off for privacy.
   */
  modalityIsEmpty: boolean;
  activeModality: ChatModality;
  pickerMode: PickerMode;
  selectedIds: Set<string>;
  localSelectedIds: Set<string>;
  focusedModelId: string;
  expandedModelId: string | null;
  /**
   * The produced verdict for a row (`affordable.all`). One lookup replaces the
   * premium flag, the floor verdict and the tier booleans: a row is available
   * or it is marked with the reason it is not, and this component decides
   * neither.
   */
  availabilityOf: (modelId: string) => Availability;
  isMobile: boolean;
  pulsingModelId: string | null;
  getPinnedLabel: (modelId: string) => string | undefined;
  onActivate: (modelId: string) => void;
  onHover: (modelId: string) => void;
  onShowInfo: (modelId: string) => void;
  onToggleExpand: (modelId: string) => void;
}

export function ModelListBody(props: Readonly<ModelListBodyProps>): React.JSX.Element {
  const {
    filteredModels,
    modalityIsEmpty,
    activeModality,
    pickerMode,
    selectedIds,
    localSelectedIds,
    focusedModelId,
    expandedModelId,
    availabilityOf,
    isMobile,
    pulsingModelId,
    getPinnedLabel,
    onActivate,
    onHover,
    onShowInfo,
    onToggleExpand,
  } = props;
  const isAtLimit = pickerMode === 'multi' && localSelectedIds.size >= MAX_SELECTED_MODELS;

  return (
    <>
      <div
        className="overflow-hidden p-2 pr-3"
        role="listbox"
        aria-label="Models"
        aria-multiselectable={pickerMode === 'multi'}
      >
        {filteredModels.map((model, cascadeIndex) => {
          const isSelected =
            pickerMode === 'multi' ? localSelectedIds.has(model.id) : selectedIds.has(model.id);
          return (
            <ModelListItem
              key={model.id}
              model={model}
              isFocused={model.id === focusedModelId}
              isSelected={isSelected}
              isDisabled={isAtLimit && !localSelectedIds.has(model.id)}
              availability={availabilityOf(model.id)}
              pickerMode={pickerMode}
              pinnedLabel={getPinnedLabel(model.id)}
              isExpanded={expandedModelId === model.id}
              isMobile={isMobile}
              isPulsing={model.id === pulsingModelId}
              cascadeIndex={cascadeIndex}
              onActivate={() => {
                onActivate(model.id);
              }}
              onHover={() => {
                onHover(model.id);
              }}
              onShowInfo={() => {
                onShowInfo(model.id);
              }}
              onToggleExpand={() => {
                onToggleExpand(model.id);
              }}
            />
          );
        })}
        {!modalityIsEmpty && filteredModels.length === 0 && (
          <div className="text-muted-foreground p-4 text-center text-sm">No models found</div>
        )}
      </div>
      {/* Outside the listbox, because an explanation is not an option, and
          mounted whether or not it has anything to say: a live region that
          appears already carrying its text is not reliably announced, while
          one whose content flips is. */}
      <div role="status">
        {modalityIsEmpty && (
          <p className="text-muted-foreground p-4 text-center text-sm">
            {modalityUnavailableMessage(activeModality)}
          </p>
        )}
      </div>
    </>
  );
}
