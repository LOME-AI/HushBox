import * as React from 'react';
import { ThemeToggle } from '@/components/shared/theme-toggle';
import { PageHeader } from '@/components/shared/page-header';
import { ModelSelectorButton } from './model-selector-button';
import type { Model } from '@lome-chat/shared';

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
}: ChatHeaderProps): React.JSX.Element {
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
      right={<ThemeToggle />}
    />
  );
}
