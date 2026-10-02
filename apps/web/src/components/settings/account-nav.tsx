import { Link } from '@tanstack/react-router';
import { ROUTES, TEST_IDS } from '@hushbox/shared';
import { scrollToSection, type SettingsSectionId } from '@/hooks/ui/use-section-in-view';
import type * as React from 'react';

const SECTIONS: readonly { id: SettingsSectionId; label: string }[] = [
  { id: 'account', label: 'Account' },
  { id: 'security', label: 'Security' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'legal', label: 'Legal' },
  { id: 'danger', label: 'Danger zone' },
];

const PAGES = [
  { to: ROUTES.ACCESSIBILITY, label: 'Accessibility' },
  { to: ROUTES.BILLING, label: 'Billing' },
  { to: ROUTES.USAGE, label: 'Usage' },
] as const;

const LINK_BASE =
  'text-ui inline-flex h-8 flex-none items-center rounded-full px-3 leading-none whitespace-nowrap transition-colors duration-150 pointer-coarse:h-11';

function linkClass(isCurrent: boolean): string {
  const state = isCurrent
    ? 'bg-primary text-primary-foreground font-semibold'
    : 'text-muted-foreground hover:bg-accent hover:text-foreground font-medium';
  return `${LINK_BASE} ${state}`;
}

interface AccountNavProps {
  /** The section in view on /settings, or `'accessibility'` on /accessibility. */
  current: SettingsSectionId | 'accessibility';
}

/** The settings-area link row: every section and page, one click away at every width. */
export function AccountNav({ current }: Readonly<AccountNavProps>): React.JSX.Element {
  const onSettings = current !== 'accessibility';
  return (
    <nav
      aria-label="Settings"
      data-testid={TEST_IDS.settingsSectionNav}
      className="border-border flex min-w-0 flex-wrap items-center gap-1 max-md:border-b max-md:px-4 max-md:py-2.5"
    >
      {SECTIONS.map(({ id, label }) =>
        onSettings ? (
          <a
            key={id}
            href={`#${id}`}
            aria-current={current === id ? 'location' : undefined}
            className={linkClass(current === id)}
            onClick={(event) => {
              event.preventDefault();
              scrollToSection(id);
            }}
          >
            {label}
          </a>
        ) : (
          // The settings page scrolls to the hash below its pinned band itself.
          <Link
            key={id}
            to={ROUTES.SETTINGS}
            hash={id}
            hashScrollIntoView={false}
            className={linkClass(false)}
          >
            {label}
          </Link>
        )
      )}
      <span
        aria-hidden="true"
        className="bg-border mx-1.5 h-4 w-0.5 flex-none rounded-full max-md:mx-0 max-md:h-0 max-md:w-auto max-md:basis-full"
      />
      {PAGES.map(({ to, label }) => {
        const isCurrent = current === 'accessibility' && to === ROUTES.ACCESSIBILITY;
        return (
          <Link
            key={to}
            to={to}
            aria-current={isCurrent ? 'page' : undefined}
            className={linkClass(isCurrent)}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
