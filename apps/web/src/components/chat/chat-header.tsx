import * as React from 'react';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { EncryptionBadge } from '@/components/shared/encryption-badge';
import { PageHeader } from '@/components/shared/page-header';
import { ModelSelectorButton } from './model-selector-button';
import { MemberFacepile } from './member-facepile';
import type { Model, Modality } from '@hushbox/shared';
import type { SelectedModelEntry } from '@/stores/model';
import type { ModelSelectorGatingProps } from './model-selector-types';

interface ChatHeaderProps extends ModelSelectorGatingProps {
  models: Model[];
  selectedModels: SelectedModelEntry[];
  onModelSelect: (models: SelectedModelEntry[]) => void;
  title?: string | undefined;
  /** Members for facepile display (undefined = no group chat features shown) */
  members?: { id: string; username: string }[] | undefined;
  /** Set of online member IDs from WebSocket presence */
  onlineMemberIds?: Set<string> | undefined;
  /** Called when facepile is clicked (opens member list) */
  onFacepileClick?: (() => void) | undefined;
  activeModality?: Modality;
}

export function ChatHeader({
  models,
  selectedModels,
  onModelSelect,
  title,
  premiumIds,
  canAccessPremium,
  isAuthenticated,
  isLinkGuest,
  onPremiumClick,
  members,
  onlineMemberIds,
  onFacepileClick,
  activeModality = 'text',
}: Readonly<ChatHeaderProps>): React.JSX.Element {
  const showGroupFeatures = members !== undefined && members.length > 0;

  return (
    <PageHeader
      testId="chat-header"
      titleTestId="chat-title"
      title={title}
      brandTitle={true}
      center={
        <ModelSelectorButton
          models={models}
          selectedModels={selectedModels}
          onSelect={onModelSelect}
          premiumIds={premiumIds}
          canAccessPremium={canAccessPremium}
          isAuthenticated={isAuthenticated}
          isLinkGuest={isLinkGuest}
          onPremiumClick={onPremiumClick}
          activeModality={activeModality}
        />
      }
      right={
        <div className="flex items-center gap-2">
          <EncryptionBadge isAuthenticated={isAuthenticated !== false} />
          <ThemeToggle />
          {showGroupFeatures && (
            <MemberFacepile
              members={members}
              onlineMemberIds={onlineMemberIds ?? new Set()}
              onFacepileClick={
                onFacepileClick ??
                (() => {
                  /* noop */
                })
              }
            />
          )}
        </div>
      }
    />
  );
}
