import { PROMPT_REGISTRY } from '@/components/prompts/registry';
import type * as React from 'react';

/**
 * The one place a prompt appears: the last child of the sidebar body, between
 * the conversation list and the account footer.
 *
 * Exactly one prompt shows at a time, the first eligible entry in the
 * registry's priority order. Two offers stacked in a narrow column read as
 * clutter and neither gets answered, and nothing else in the app coordinates
 * between them — the ordering here is the coordination.
 *
 * Every definition's eligibility hook runs on every render, whether or not its
 * prompt is the one shown: hooks are not conditional, and a definition that ran
 * only when it was about to win could not become eligible in the first place.
 */
export function SidebarPromptSlot({
  collapsed,
}: Readonly<{ collapsed: boolean }>): React.JSX.Element | null {
  const eligibility = PROMPT_REGISTRY.map((definition) => definition.useEligible());
  const due = PROMPT_REGISTRY.find((_, index) => eligibility[index] === true);
  if (due === undefined) return null;
  return collapsed ? <due.Rail /> : <due.Card />;
}
