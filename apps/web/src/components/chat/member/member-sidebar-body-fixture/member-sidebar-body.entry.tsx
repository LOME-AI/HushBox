import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { TEST_IDS } from '@hushbox/shared';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { MemberSidebarBody } from '../member-sidebar-body';
import './member-sidebar-body.css';

/**
 * Real-browser fixture for `member-sidebar-body.browser.test.ts`: the member pane's body in a
 * pane on the sidebar surface, 20rem wide from the desktop band and the viewport's width below
 * it, as the right pane draws it. The query string sets the text scale (`scale=141`) the way
 * the app's classes do, and `inset=none` strips the body's inset, the control the test
 * proves its measurements against.
 *
 * Test infrastructure, not shipped runtime: it is served to a real browser and never
 * imported by the Node test process, so `apps/web/vitest.config.ts` excludes
 * `src/**\/*-fixture/**` from the coverage gate.
 */

const params = new URLSearchParams(globalThis.location.search);
const scale = params.get('scale');
if (scale !== null) document.documentElement.classList.add(`a11y-font-scale-${scale}`);
if (params.get('inset') === 'none') {
  const control = document.createElement('style');
  control.textContent = `[data-testid="${TEST_IDS.memberSidebarContent}"] > section { padding-inline: 0; }`;
  document.head.append(control);
}

/** The ring's reach outside the avatar disc: the two box-shadow bands, 2px and 4px. */
const RING_PX = 4;

interface Measured {
  /** Each online avatar's ring, measured against the body's visible box. */
  rings: { left: number; right: number; bodyLeft: number; bodyRight: number }[];
  /** How far the body can scroll sideways, and how far it has. */
  sidewaysOverflow: number;
  scrollLeft: number;
  /** Each group label's left edge against the pane's. */
  labels: { text: string; left: number; paneLeft: number }[];
}

function element(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`missing ${selector}`);
  return found;
}

function measure(): Measured {
  const pane = element('#pane').getBoundingClientRect();
  const body = element(`[data-testid="${TEST_IDS.memberSidebarContent}"]`);
  const box = body.getBoundingClientRect();
  const bodyLeft = box.left + body.clientLeft;
  const bodyRight = bodyLeft + body.clientWidth;
  return {
    rings: [...body.querySelectorAll<HTMLElement>('[data-online]')].map((disc) => {
      const rect = disc.getBoundingClientRect();
      return { left: rect.left - RING_PX, right: rect.right + RING_PX, bodyLeft, bodyRight };
    }),
    sidewaysOverflow: body.scrollWidth - body.clientWidth,
    scrollLeft: body.scrollLeft,
    labels: [...body.querySelectorAll<HTMLElement>('h3')].map((label) => ({
      text: label.textContent,
      left: label.getBoundingClientRect().left,
      paneLeft: pane.left,
    })),
  };
}

declare global {
  var __memberBody: { measure: typeof measure } | undefined;
}

function noop(): void {
  /* the fixture measures the body; no action is taken */
}

const MEMBERS = [
  { id: 'owner', userId: 'u-owner', username: 'alice', privilege: 'owner' },
  {
    id: 'writer',
    userId: 'u-writer',
    username: 'maximiliana_oyelaran_whitcombe',
    privilege: 'write',
  },
  { id: 'reader', userId: 'u-reader', username: 'ines', privilege: 'read' },
];

const LINKS = [
  {
    id: 'named',
    displayName: 'Luísa',
    privilege: 'read',
    createdAt: isoAt(TEST_DAY_START),
    memberId: null,
  },
  {
    id: 'unnamed',
    displayName: null,
    privilege: 'write',
    createdAt: isoAt(TEST_DAY_START + DAY_MS),
    memberId: null,
  },
];

const container = document.querySelector('#root');
if (container === null) throw new Error('missing #root');
const reactRoot = createRoot(container);
flushSync(() => {
  reactRoot.render(
    <div className="bg-background text-foreground flex h-dvh justify-end">
      <aside
        id="pane"
        aria-label="Members"
        className="bg-sidebar text-sidebar-foreground border-sidebar-border flex h-full w-full flex-col md:w-[20rem] md:border-l"
      >
        <MemberSidebarBody
          members={MEMBERS}
          links={LINKS}
          onlineMemberIds={new Set(['u-owner', 'u-writer'])}
          currentUserId="u-owner"
          currentUserLinkId={null}
          currentUserPrivilege="owner"
          conversationId="fixture"
          onRemoveMember={noop}
          onChangePrivilege={noop}
          onChangeLinkPrivilege={noop}
          onSaveLinkName={noop}
          onRevokeLinkClick={noop}
          onAddMember={noop}
          onInviteLink={noop}
        />
      </aside>
    </div>
  );
});

globalThis.__memberBody = { measure };
