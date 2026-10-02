import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { CommandPalette as PaletteShell, buildSections } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { NAV_ITEMS } from '@/components/shell/admin-nav';
import { useRunOp } from '@/components/ops/op-modal-provider';
import { useOps } from '@/hooks/use-ops';
import { visibleNavItems } from '@/lib/nav-visibility';
import { getRecents, pushRecent } from './recents.js';
import { usePalette } from './palette-provider.js';
import type { PaletteItem, PaletteSection } from '@hushbox/ui';
import type { PaletteAction } from './recents.js';

interface AdminPaletteItem extends PaletteItem {
  readonly action: PaletteAction;
}

/**
 * The keyboard-first launcher: screens, ops (opening the OpModal), and
 * go-to-user. The shell — Dialog, combobox wiring, selection model — comes from
 * `@hushbox/ui`; this supplies the admin plane's items and what running one does.
 */
export function CommandPalette(): React.JSX.Element {
  const { open, setOpen } = usePalette();
  const navigate = useNavigate();
  const runOp = useRunOp();
  const ops = useOps({ enabled: open });

  const screens = React.useMemo<readonly AdminPaletteItem[]>(
    () =>
      visibleNavItems(NAV_ITEMS, ops.data?.role ?? null).map((item) => ({
        id: `screen:${item.to}`,
        label: item.label,
        action: { kind: 'screen', to: item.to },
      })),
    [ops.data]
  );
  const opItems = React.useMemo<readonly AdminPaletteItem[]>(
    () =>
      (ops.data?.ops ?? []).map((op) => ({
        id: `op:${op.name}`,
        label: op.title,
        hint: op.name,
        action: { kind: 'op', name: op.name },
      })),
    [ops.data]
  );

  function sections(query: string): readonly PaletteSection<AdminPaletteItem>[] {
    return buildSections<AdminPaletteItem>({
      query,
      groups: [
        { heading: 'Screens', items: screens },
        { heading: 'Ops', items: opItems },
      ],
      recents: getRecents().map((entry) => ({
        id: entry.id,
        label: entry.label,
        action: entry.action,
      })),
      fallback: (typed) => ({
        heading: 'Users',
        items: [
          {
            id: `user:${typed}`,
            label: `Go to user "${typed}"`,
            hint: 'full email or user id',
            action: { kind: 'user', q: typed },
          },
        ],
      }),
    });
  }

  function run(item: AdminPaletteItem): void {
    pushRecent({ id: item.id, label: item.label, action: item.action });
    switch (item.action.kind) {
      case 'screen': {
        void navigate({ to: item.action.to });
        break;
      }
      case 'op': {
        runOp({ opName: item.action.name });
        break;
      }
      case 'user': {
        void navigate({ to: '/customer-360', search: { q: item.action.q } });
        break;
      }
    }
  }

  return (
    <PaletteShell
      open={open}
      onClose={() => {
        setOpen(false);
      }}
      sections={sections}
      onRun={run}
      appearance="plain"
      title="Command palette"
      description="Search screens, ops, and users. Use the arrow keys and Enter."
      placeholder="Search screens, ops, and users"
      testId={TEST_IDS.adminPalette}
      inputTestId={TEST_IDS.adminPaletteInput}
      optionTestId={TEST_IDS.adminPaletteOption}
    />
  );
}
