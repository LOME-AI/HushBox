import * as React from 'react';
import { ScrollArea, cn } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { type PickerMode } from '@/stores/model';

import { ModelInfoPanel } from '@/components/chat/model-selector/model-info-panel';
import { PickerModeToggle } from '@/components/chat/model-selector/picker-mode-toggle';
import {
  SearchAndSortSection,
  type SearchAndSortSectionProps,
} from '@/components/chat/model-selector/search-and-sort-section';
import {
  ModelListBody,
  type ModelListBodyProps,
} from '@/components/chat/model-selector/model-list-body';
import type { Model } from '@hushbox/shared';

interface MobileTopSectionProps {
  pickerMode: PickerMode;
  onModeChange: (mode: PickerMode) => void;
  multiLabel: React.ReactNode;
  searchAndSortProps: SearchAndSortSectionProps;
}

function MobileTopSection({
  pickerMode,
  onModeChange,
  multiLabel,
  searchAndSortProps,
}: Readonly<MobileTopSectionProps>): React.JSX.Element {
  return (
    <div className="flex flex-shrink-0 flex-col">
      <div className="border-border-strong border-b py-2">
        <div
          data-testid={TEST_IDS.pickerModeToggleWrapper}
          className="mx-auto w-full max-w-[calc(100%-3rem)] px-4"
        >
          <PickerModeToggle
            mode={pickerMode}
            onChange={onModeChange}
            orientation="horizontal"
            singleLabel="Talk to one model"
            multiLabel={multiLabel}
          />
        </div>
      </div>
      <SearchAndSortSection {...searchAndSortProps} />
    </div>
  );
}

/**
 * Single source of truth for the desktop top-quadrant height. Both the
 * left search/sort section and the right toggle header wrap their content in
 * a `<DesktopTopQuadrant>` so the two columns stay in visual lock-step.
 */
const DESKTOP_TOP_QUADRANT_HEIGHT_CLASS = 'h-[6rem]';

function DesktopTopQuadrant({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <div
      data-testid={TEST_IDS.desktopTopQuadrant}
      className={cn(
        'border-border-strong flex flex-shrink-0 items-center overflow-hidden border-b',
        DESKTOP_TOP_QUADRANT_HEIGHT_CLASS
      )}
    >
      <div className="w-full">{children}</div>
    </div>
  );
}

interface DesktopRightColumnProps {
  pickerMode: PickerMode;
  onModeChange: (mode: PickerMode) => void;
  multiLabel: React.ReactNode;
  focusedModel: Model | undefined;
}

function DesktopRightColumn({
  pickerMode,
  onModeChange,
  multiLabel,
  focusedModel,
}: Readonly<DesktopRightColumnProps>): React.JSX.Element {
  return (
    <div className="flex min-h-0 max-w-sm flex-1 flex-[11] flex-col">
      <DesktopTopQuadrant>
        <div className="py-2">
          <div
            data-testid={TEST_IDS.pickerModeToggleWrapper}
            className="mx-auto w-full max-w-[calc(100%-3rem)] px-4"
          >
            <PickerModeToggle
              mode={pickerMode}
              onChange={onModeChange}
              orientation="vertical"
              singleLabel="Talk to one model"
              multiLabel={multiLabel}
            />
          </div>
        </div>
      </DesktopTopQuadrant>
      <ScrollArea data-testid={TEST_IDS.modelDetailsPanel} className="min-h-0 flex-1">
        <div className="p-6">{focusedModel ? <ModelInfoPanel model={focusedModel} /> : null}</div>
      </ScrollArea>
    </div>
  );
}

export interface ModelSelectorModalLayoutProps {
  isMobile: boolean;
  pickerMode: PickerMode;
  multiLabel: React.ReactNode;
  searchAndSortProps: SearchAndSortSectionProps;
  handleModeChange: (mode: PickerMode) => void;
  focusedModel: Model | undefined;
  modelListBodyProps: ModelListBodyProps;
  footer: React.ReactNode;
}

export function ModelSelectorModalLayout({
  isMobile,
  pickerMode,
  multiLabel,
  searchAndSortProps,
  handleModeChange,
  focusedModel,
  modelListBodyProps,
  footer,
}: Readonly<ModelSelectorModalLayoutProps>): React.JSX.Element {
  return (
    <div
      className={cn(
        'bg-background flex w-[90vw] max-w-4xl flex-col overflow-hidden rounded-lg border shadow-lg',
        isMobile ? 'h-[92dvh]' : 'h-[85dvh]'
      )}
      data-testid={TEST_IDS.modelSelectorModal}
      data-picker-mode={pickerMode}
    >
      <div className="flex min-h-0 flex-1 flex-col">
        {isMobile && (
          <MobileTopSection
            pickerMode={pickerMode}
            onModeChange={handleModeChange}
            multiLabel={multiLabel}
            searchAndSortProps={searchAndSortProps}
          />
        )}

        <div className={cn('flex min-h-0 min-w-0 flex-1', isMobile ? 'flex-col' : 'flex-row')}>
          <div
            data-testid={TEST_IDS.modelListPanel}
            className={cn(
              'border-border-strong flex min-h-0 min-w-0 flex-col overflow-x-hidden',
              isMobile ? 'flex-[9] border-b' : 'flex-1 border-r'
            )}
          >
            {!isMobile && (
              <DesktopTopQuadrant>
                <SearchAndSortSection {...searchAndSortProps} withBottomBorder={false} />
              </DesktopTopQuadrant>
            )}

            <ScrollArea data-testid={TEST_IDS.modelListScroll} className="min-h-0 flex-1">
              <ModelListBody {...modelListBodyProps} />
            </ScrollArea>
          </div>

          {!isMobile && (
            <DesktopRightColumn
              pickerMode={pickerMode}
              onModeChange={handleModeChange}
              multiLabel={multiLabel}
              focusedModel={focusedModel}
            />
          )}
        </div>
      </div>

      {footer}
    </div>
  );
}
