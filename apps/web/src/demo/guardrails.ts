/**
 * Demo-only click guardrails. The demo runs the real app, so unsupported
 * controls (settings, logout, billing, group management, message writes) are
 * present. A capture-phase interceptor blocks them and shows a sign-up nudge,
 * turning every dead-end into a conversion moment. Touches NO real component —
 * it only listens on `document` and keys off the centralized test-ids /
 * aria-labels. Supported controls (conversation switching, new chat, model
 * picker, copy) pass through untouched.
 *
 * Mode switches are a special case: a person's (trusted) choice is nudged, but
 * the director's synthetic (untrusted) choice passes so conversations still
 * auto-switch modality. See `composer-cues.ts` for the matching visuals.
 *
 * Menu items choose on a key as well as a click, and a menu re-dispatches that
 * key as an untrusted click, so a person's choosing keys are stopped here too.
 */
import { TEST_IDS, TEST_ID_BUILDERS } from '@hushbox/shared';
import {
  webPaletteSections,
  type WebPaletteItem,
} from '@/components/command-palette/palette-items';
import { isModeSwitchTarget } from './composer-cues';

/** One nudge for the accessibility settings, however a person reaches for them. */
const ACCESSIBILITY_NUDGE = 'open accessibility settings';

const BLOCKED_TESTIDS = new Map<string, string>([
  ['menu-settings', 'open settings'],
  ['menu-logout', 'log out'],
  ['menu-add-credits', 'add credits'],
  ['menu-usage', 'see usage'],
  ['new-member-button', 'invite people'],
  ['invite-link-button', 'create invite links'],
  ['chat-item-more-button', 'manage conversations'],
  // Leaving a conversation is reachable from the member panel (a separate path
  // from the blocked sidebar kebab) and is destructive — block it and its
  // confirm button.
  ['member-leave-action', 'leave conversations'],
  ['leave-confirmation-confirm', 'leave conversations'],
  [TEST_IDS.continueWithModel, 'continue with one model'],
  [TEST_IDS.moreOptionsAccessibility, ACCESSIBILITY_NUDGE],
]);

const BLOCKED_TESTID_PREFIXES = new Map<string, string>([
  ['member-remove-action-', 'manage members'],
  ['member-change-privilege-', 'manage members'],
  // The per-member / per-link action menus open the destructive remove/revoke
  // /privilege options; block the menu triggers so those never surface.
  ['member-actions-', 'manage members'],
  ['link-revoke-action-', 'manage links'],
  ['link-change-privilege-', 'manage links'],
  ['link-actions-', 'manage links'],
  [TEST_ID_BUILDERS.branchRename(''), 'rename branches'],
  [TEST_ID_BUILDERS.branchDelete(''), 'delete branches'],
]);

// Message-write actions only carry aria-labels (no test-ids). Copy, Regenerate
// and Retry are omitted — they run against the fake backend (regenerate
// re-streams a reply), so they stay supported. Fork/Share/Edit have no demo
// backing and are nudged.
const BLOCKED_ARIA = new Map<string, string>([
  ['Fork', 'fork conversations'],
  ['Share', 'share messages'],
  ['Edit', 'edit messages'],
]);

type PaletteAction = Extract<WebPaletteItem, { kind: 'action' }>['action'];

/**
 * What a visitor is told for each command palette action the demo nudges: those
 * the palette offers a signed-in account and no one else, which a test holds
 * against the palette itself, and the Accessibility page, which More options'
 * Accessibility also opens.
 */
export const PALETTE_NUDGES: Readonly<Partial<Record<PaletteAction, string>>> = {
  accessibilityPage: ACCESSIBILITY_NUDGE,
  addCredit: 'add credits',
  sendFeedback: 'send feedback',
  settings: 'open settings',
  usage: 'see usage',
};

/** The nudge for each nudged action, keyed by the label its palette row shows. */
const PALETTE_NUDGES_BY_LABEL: ReadonlyMap<string, string> = new Map(
  webPaletteSections({ query: '', conversations: [], signedIn: true, now: new Date() }).flatMap(
    (section) =>
      section.items.flatMap((item) => {
        const nudge = item.kind === 'action' ? PALETTE_NUDGES[item.action] : undefined;
        return nudge === undefined ? [] : [[item.label, nudge] as const];
      })
  )
);

const PALETTE_OPTION_SELECTOR = `[data-testid="${TEST_IDS.commandPaletteOption}"]`;

/**
 * The nudge for a palette row whose action the demo nudges, in whatever section
 * a search puts it. A row draws its label as one of its parts, apart from its
 * icon and its meta; a conversation row titled with an action's whole label would
 * read as that action, and no demo conversation is (a test holds the fixtures).
 */
function paletteNudge(target: Element): string | null {
  const option = target.closest(PALETTE_OPTION_SELECTOR);
  if (option === null) return null;
  for (const part of option.children) {
    const nudge = PALETTE_NUDGES_BY_LABEL.get(part.textContent);
    if (nudge !== undefined) return nudge;
  }
  return null;
}

/** Returns a friendly action label if the event target is an unsupported control, else null. */
export function findBlockedAction(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  for (const [testid, label] of BLOCKED_TESTIDS) {
    if (target.closest(`[data-testid="${testid}"]`) !== null) return label;
  }
  for (const [prefix, label] of BLOCKED_TESTID_PREFIXES) {
    if (target.closest(`[data-testid^="${prefix}"]`) !== null) return label;
  }
  for (const [aria, label] of BLOCKED_ARIA) {
    if (target.closest(`[aria-label="${aria}"]`) !== null) return label;
  }
  return paletteNudge(target);
}

/**
 * Decide whether a click should be nudged (and with what label), or allowed
 * (null). Unconditionally-blocked controls nudge regardless of trust; mode
 * switches nudge only on real (trusted) clicks so the director's synthetic
 * switch passes.
 */
export function resolveClickNudge(target: EventTarget | null, isTrusted: boolean): string | null {
  const blocked = findBlockedAction(target);
  if (blocked !== null) return blocked;
  if (isTrusted && isModeSwitchTarget(target)) return 'switch modes';
  return null;
}

/**
 * Decide whether a person's key chooses a control the guardrails nudge. Enter
 * and Space choose a focused item; a field that names its selected option
 * through `aria-activedescendant` (the palette's) chooses it on Enter only,
 * since Space there types a space.
 */
export function resolveKeyNudge(
  key: string,
  target: EventTarget | null,
  isTrusted: boolean
): string | null {
  if (!isTrusted || !(target instanceof Element)) return null;
  const activeId = target.getAttribute('aria-activedescendant');
  if (activeId !== null) {
    return key === 'Enter'
      ? resolveClickNudge(document.querySelector(`#${CSS.escape(activeId)}`), true)
      : null;
  }
  return key === 'Enter' || key === ' ' ? resolveClickNudge(target, true) : null;
}

interface Nudge {
  readonly el: HTMLElement;
  show: (label: string) => void;
}

function createNudge(): Nudge {
  const el = document.createElement('div');
  el.className =
    'z-overlay fixed bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-sm text-background opacity-0 shadow-lg transition-opacity duration-200 pointer-events-none';
  el.setAttribute('role', 'status');
  el.dataset['testid'] = TEST_IDS.demoSignupNudge;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const show = (label: string): void => {
    // Overlays share the top layer and the later one paints over the earlier,
    // so the nudge moves after any menu sheet or dialog opened since it last showed.
    document.body.append(el);
    el.textContent = `Create a free account to ${label}.`;
    el.classList.remove('opacity-0');
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      el.classList.add('opacity-0');
    }, 2600);
  };
  return { el, show };
}

/** Install the capture-phase click and key interceptors + nudge. Returns a disposer. */
export function installGuardrails(): () => void {
  const nudge = createNudge();
  document.body.append(nudge.el);
  const stop = (event: Event, label: string | null): void => {
    if (label === null) return;
    event.preventDefault();
    event.stopPropagation();
    nudge.show(label);
  };
  const onClick = (event: MouseEvent): void => {
    stop(event, resolveClickNudge(event.target, event.isTrusted));
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    stop(event, resolveKeyNudge(event.key, event.target, event.isTrusted));
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    nudge.el.remove();
  };
}
