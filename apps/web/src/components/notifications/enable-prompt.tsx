import { PromptCard } from '@hushbox/ui';
import { useEnablePrompt } from '@/hooks/notifications/use-enable-prompt';
import type * as React from 'react';

/**
 * The one-time offer to turn on notifications for this device.
 *
 * It is offered once per device — "Later" is permanent there, recorded locally
 * on purpose, because push permission is per browser and a decision made on one
 * says nothing about another — so the copy points at Settings, which stays the
 * place to change the answer.
 *
 * The chrome is the shared prompt composite: this is one entry in the sidebar's
 * prompt slot, and every prompt in that slot looks the same so a person learns
 * the shape once.
 */
export function NotificationEnablePrompt(): React.JSX.Element | null {
  const { isVisible, isEnabling, enable, dismiss } = useEnablePrompt();

  if (!isVisible) return null;

  return (
    <PromptCard
      heading="Turn on notifications"
      body="Know when a reply lands or a run finishes, even when HushBox is closed. Never includes message content. Change this any time in Settings."
      primary={{ label: 'Enable', onPrimary: enable, isBusy: isEnabling }}
      secondary={{ label: 'Later', onSecondary: dismiss }}
    />
  );
}
