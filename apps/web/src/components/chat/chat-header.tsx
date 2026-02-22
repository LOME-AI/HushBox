import * as React from 'react';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { EncryptionBadge } from '@/components/shared/encryption-badge';
import { PageHeader } from '@/components/shared/page-header';
import { ModelSelectorButton } from './model-selector-button';
import { MemberFacepile } from './member-facepile';
import type { Model } from '@hushbox/shared';

interface ChatHeaderProps {
  models: Model[];
  selectedModelId: string;
  /** Fallback name to display before models load (prevents flash) */
  selectedModelName?: string | undefined;
  onModelSelect: (modelId: string, modelName: string) => void;
  title?: string | undefined;
  /** Set of premium model IDs */
  premiumIds?: Set<string> | undefined;
  /** Whether the user can access premium models (defaults to true) */
  canAccessPremium?: boolean | undefined;
  /** Whether the user is authenticated (defaults to true) */
  isAuthenticated?: boolean | undefined;
  /** Called when user clicks a premium model they cannot access */
  onPremiumClick?: ((modelId: string) => void) | undefined;
  /** Members for facepile display (undefined = no group chat features shown) */
  members?: { id: string; username: string }[] | undefined;
  /** Set of online member IDs from WebSocket presence */
  onlineMemberIds?: Set<string> | undefined;
  /** Called when facepile is clicked (opens member list) */
  onFacepileClick?: (() => void) | undefined;
}

export function ChatHeader({
  models,
  selectedModelId,
  selectedModelName,
  onModelSelect,
  title,
  premiumIds,
  canAccessPremium,
  isAuthenticated,
  onPremiumClick,
  members,
  onlineMemberIds,
  onFacepileClick,
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
          selectedId={selectedModelId}
          selectedName={selectedModelName}
          onSelect={onModelSelect}
          premiumIds={premiumIds}
          canAccessPremium={canAccessPremium}
          isAuthenticated={isAuthenticated}
          onPremiumClick={onPremiumClick}
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
