import * as React from 'react';
import { displayUsername } from '@hushbox/shared';

interface TypingIndicatorProps {
  typingUserIds: Set<string>;
  members: { userId: string; username: string }[];
}

const DOT_DELAYS = ['0s', '0.16s', '0.32s'] as const;

function resolveUsername(
  userId: string,
  members: readonly { userId: string; username: string }[]
): string {
  const member = members.find((m) => m.userId === userId);
  return member ? displayUsername(member.username) : 'Someone';
}

function formatTypingLabel(
  typingUserIds: Set<string>,
  members: readonly { userId: string; username: string }[]
): string {
  const count = typingUserIds.size;
  if (count >= 3) {
    return `${String(count)} people are typing...`;
  }
  const names = [...typingUserIds].map((id) => resolveUsername(id, members));
  if (count === 2) {
    const first = names[0] ?? 'Someone';
    const second = names[1] ?? 'Someone';
    return `${first} and ${second} are typing...`;
  }
  const first = names[0] ?? 'Someone';
  return `${first} is typing...`;
}

export function TypingIndicator({
  typingUserIds,
  members,
}: Readonly<TypingIndicatorProps>): React.JSX.Element | null {
  if (typingUserIds.size === 0) {
    return null;
  }

  const label = formatTypingLabel(typingUserIds, members);

  return (
    <div
      role="status"
      aria-label={label}
      data-testid="typing-indicator"
      className="text-foreground mb-2 flex items-center justify-center gap-1 text-sm"
    >
      <span>{label}</span>
      <span className="inline-flex items-center gap-0.5" aria-hidden="true">
        {DOT_DELAYS.map((delay) => (
          <span
            key={delay}
            className="animate-dot-pulse inline-block h-1 w-1 rounded-full bg-current"
            style={{ animationDelay: delay }}
          />
        ))}
      </span>
    </div>
  );
}
