import { observeTextMetrics } from '../../lib/observe-text-metrics';
import { BUTTON_GROUP_MARKER } from './button-group-classes';

const GROUP_SELECTOR = `.${BUTTON_GROUP_MARKER}`;

function groupsUnder(root: ParentNode): HTMLElement[] {
  const groups = [...root.querySelectorAll<HTMLElement>(GROUP_SELECTOR)];
  return root instanceof HTMLElement && root.matches(GROUP_SELECTOR) ? [root, ...groups] : groups;
}

/** The children a group sizes and stacks: every element but an icon button, which keeps its own size. */
function labelledButtons(group: HTMLElement): HTMLElement[] {
  return [...group.children].filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement && child.dataset['slot'] !== 'icon-button'
  );
}

// Every group lets its buttons wrap a label too long for their width. A row of two or more
// labelled buttons is marked `shared`: its buttons then never narrow below the widest label,
// and once the labels cannot all share a line the row stacks by its labels as well as by its
// width, each button on a line of its own, as the button classes' shared-row floor states.
// The mark follows the markup, never the layout, so setting it cannot resize anything a
// resize would have to answer.
function markGroup(group: HTMLElement): void {
  const shared =
    labelledButtons(group).length > 1 &&
    !getComputedStyle(group).flexDirection.startsWith('column');
  group.dataset['wrapLabels'] = shared ? 'shared' : '';
}

// A label's own width does not depend on the group's width, so one reading serves every
// width until the fonts, the root text size or a label change. Each button is laid out at
// its label's width for the reading and given back its own inline style after it.
function measureGroup(group: HTMLElement): void {
  const buttons = labelledButtons(group);
  const saved = buttons.map((button) => button.getAttribute('style'));
  for (const button of buttons) {
    button.style.flex = 'none';
    button.style.width = 'max-content';
    button.style.minWidth = '0';
    button.style.maxWidth = 'none';
  }
  const widest = Math.max(0, ...buttons.map((button) => button.offsetWidth));
  for (const [index, button] of buttons.entries()) {
    const style = saved[index];
    if (style === null || style === undefined) button.removeAttribute('style');
    else button.setAttribute('style', style);
  }
  if (widest === 0) return;
  group.style.setProperty('--btn-eq', `${String(widest + 1)}px`);
  group.style.setProperty('--btn-count', String(buttons.length));
}

/**
 * Writes each button group's widest label to `--btn-eq`, which the group classes read to
 * give every button that width in a wide space, and marks the group `data-wrap-labels`
 * (`shared` for a row of two or more labelled buttons), which the button classes read to
 * wrap a long label and to stack a row its labels crowd; it keeps both current as fonts
 * load, the root text size changes or a label changes. Framework-neutral: a React group
 * calls it on its root, a static page on its document. Returns a disposer.
 */
function measureButtonGroups(root: ParentNode): () => void {
  const groups = groupsUnder(root);
  const measureAll = (): void => {
    for (const group of groups) {
      measureGroup(group);
      markGroup(group);
    }
  };
  measureAll();

  const labels = new MutationObserver(measureAll);
  for (const group of groups) {
    labels.observe(group, { childList: true, subtree: true, characterData: true });
  }
  const releaseTextMetrics = observeTextMetrics(measureAll);

  return () => {
    labels.disconnect();
    releaseTextMetrics();
  };
}

export { labelledButtons, measureButtonGroups };
