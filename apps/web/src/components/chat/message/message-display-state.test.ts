import { describe, it, expect } from 'vitest';
import { computeContainerClasses } from '@/components/chat/message/message-display-state';

const INSETS = ['px-4', 'mr-4', 'ml-4'];

describe('computeContainerClasses', () => {
  it('reserves no room for a toolbar laid over the next row', () => {
    const rows = [
      computeContainerClasses(false, false, true),
      computeContainerClasses(true, false, true),
      computeContainerClasses(true, true, false),
    ];
    for (const classes of rows) expect(classes.split(' ')).not.toContain('pb-8');
  });

  it('lets a reply span the chat column with no inset of its own', () => {
    const classes = computeContainerClasses(false, false, true).split(' ');
    expect(classes).toContain('w-full');
    for (const inset of INSETS) expect(classes).not.toContain(inset);
  });

  it("sets the caller's own message flush with the column's right edge", () => {
    const classes = computeContainerClasses(true, false, true).split(' ');
    expect(classes).toContain('ml-auto');
    for (const inset of INSETS) expect(classes).not.toContain(inset);
  });

  it("sets another member's message flush with the column's left edge", () => {
    const classes = computeContainerClasses(true, true, false).split(' ');
    expect(classes).toContain('mr-auto');
    for (const inset of INSETS) expect(classes).not.toContain(inset);
  });

  it('leaves less room below a user message than below a reply, as a turn reads', () => {
    expect(computeContainerClasses(true, false, true).split(' ')).toContain('pb-3.5');
    expect(computeContainerClasses(false, false, true).split(' ')).toContain('pb-7.5');
  });
});
