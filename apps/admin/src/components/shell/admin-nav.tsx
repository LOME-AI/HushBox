import * as React from 'react';
import { Link } from '@tanstack/react-router';
import {
  Boxes,
  LayoutDashboard,
  ListChecks,
  Mail,
  MessageSquare,
  ScrollText,
  Terminal,
  TrendingUp,
  UserRound,
  Wrench,
} from 'lucide-react';
import { z } from 'zod';
import { Logo } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useAdminRole } from '@/hooks/use-admin-role';
import { visibleNavItems } from '@/lib/nav-visibility';
import type { AdminRole } from '@hushbox/shared';

export interface NavItem {
  readonly to: string;
  readonly label: string;
  readonly icon: React.ComponentType<{ className?: string }>;
  /**
   * The roles this screen is drawn for. It is the SPA's own surface map — the
   * screens are the app's, not the API's — and it is a courtesy only: every
   * screen behind it calls `admin`-classed routes the pipeline refuses for a
   * role the route map does not list.
   */
  readonly roles: readonly AdminRole[];
}

/** The screen list — also the command palette's Screens group. */
export const NAV_ITEMS: readonly NavItem[] = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, roles: ['operator'] },
  { to: '/customer-360', label: 'Customer 360', icon: UserRound, roles: ['operator'] },
  { to: '/jobs', label: 'Jobs', icon: ListChecks, roles: ['operator'] },
  { to: '/feedback', label: 'Feedback', icon: MessageSquare, roles: ['operator'] },
  { to: '/newsletter', label: 'Newsletter', icon: Mail, roles: ['operator'] },
  { to: '/audit', label: 'Audit trail', icon: ScrollText, roles: ['operator'] },
  { to: '/models', label: 'Models', icon: Boxes, roles: ['operator'] },
  { to: '/sql', label: 'SQL panel', icon: Terminal, roles: ['operator'] },
  { to: '/ops', label: 'Ops catalog', icon: Wrench, roles: ['operator'] },
  { to: '/growth', label: 'Growth', icon: TrendingUp, roles: ['operator', 'growth-viewer'] },
];

export function AdminNav(): React.JSX.Element {
  const role = useAdminRole();
  // VITE_WEB_URL is registry-defined in every mode (production included), so a
  // missing or malformed value is a build misconfiguration: parse and fail fast
  // rather than casting an undefined into an `undefined/chat` href.
  const webUrl = z.url().parse(import.meta.env['VITE_WEB_URL']);
  return (
    <nav
      data-chrome=""
      data-testid={TEST_IDS.adminNav}
      // Below ~900px the sidebar is an icon rail: wordmark and labels hide
      // (sr-only), icons + title tooltips keep every screen reachable without
      // spending the narrow viewport on chrome. Mobile layout stays a
      // non-goal; this only keeps nav usable at phone widths.
      className="border-border bg-sidebar flex w-14 shrink-0 flex-col border-r min-[900px]:w-52"
    >
      <div className="border-border flex min-h-[var(--app-header-height)] items-center border-b px-3 py-2 text-sm font-semibold">
        <a
          // Admin is a separate SPA with no /chat route of its own; link out to
          // the product web app. Plain anchor, not a router Link.
          href={`${webUrl}/chat`}
          aria-label="HushBox - Go to chat"
          className="focus-visible:ring-ring/50 rounded-md focus-visible:ring-[3px] focus-visible:outline-hidden"
        >
          {/* Icon rail: hide the shared Logo's wordmark below the breakpoint,
              mirroring the old sr-only pattern, keeping only the brand mark. */}
          <Logo className="[&>span]:sr-only min-[900px]:[&>span]:not-sr-only" />
        </a>
      </div>
      <ul className="flex flex-col gap-0.5 p-2">
        {visibleNavItems(NAV_ITEMS, role).map(({ to, label, icon: Icon }) => (
          <li key={to}>
            <Link
              to={to}
              title={label}
              className="text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:ring-ring/50 flex items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm focus-visible:ring-[3px] focus-visible:outline-hidden min-[900px]:justify-start"
              activeProps={{ className: 'bg-accent text-accent-foreground' }}
              activeOptions={{ exact: to === '/' }}
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="sr-only min-[900px]:not-sr-only">{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
