import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, TEST_LOCAL_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { MessageSquare, Users } from '@hushbox/ui/icons';
import { APP_SHORTCUTS } from '@/hooks/ui/use-app-shortcuts';
import { webPaletteSections, type PaletteConversation, type WebPaletteItem } from './palette-items';
import type { PaletteSection } from '@hushbox/ui';

const NOW = new Date(TEST_LOCAL_DAY_START + 12 * HOUR_MS);

function conversation(
  id: string,
  title: string,
  hoursAgo: number,
  overrides: Partial<PaletteConversation> = {}
): PaletteConversation {
  return {
    id,
    title,
    updatedAt: isoAt(NOW.getTime() - hoursAgo * HOUR_MS),
    memberCount: 1,
    accepted: true,
    ...overrides,
  };
}

const CONVERSATIONS: readonly PaletteConversation[] = [
  conversation('c-old', 'Tax questions', 40 * 24),
  conversation('c-1', 'Merging duplicate contacts', 1),
  conversation('c-2', 'Trip to Lisbon', 2, { memberCount: 3 }),
  conversation('c-3', 'Garden layout', 3 * 24),
  conversation('c-invite', 'Shared budget', 0.5, { accepted: false }),
];

function headings(sections: readonly PaletteSection<WebPaletteItem>[]): string[] {
  return sections.map((section) => section.heading);
}

function labelsOf(
  sections: readonly PaletteSection<WebPaletteItem>[],
  heading: string
): readonly string[] | undefined {
  return sections.find((section) => section.heading === heading)?.items.map((item) => item.label);
}

function signedIn(query = ''): readonly PaletteSection<WebPaletteItem>[] {
  return webPaletteSections({ query, conversations: CONVERSATIONS, signedIn: true, now: NOW });
}

function signedOut(query = ''): readonly PaletteSection<WebPaletteItem>[] {
  return webPaletteSections({ query, conversations: CONVERSATIONS, signedIn: false, now: NOW });
}

describe('webPaletteSections with an empty query', () => {
  it('lists Recent, Actions and Go to for an account', () => {
    expect(headings(signedIn())).toEqual(['Recent', 'Actions', 'Go to']);
  });

  it('offers New chat, Add credit and Send feedback as actions to an account', () => {
    expect(labelsOf(signedIn(), 'Actions')).toEqual(['New chat', 'Add credit', 'Send feedback']);
  });

  it('offers Settings, Usage and Accessibility to go to for an account', () => {
    expect(labelsOf(signedIn(), 'Go to')).toEqual(['Settings', 'Usage', 'Accessibility']);
  });

  it('lists the three most recently updated accepted conversations under Recent', () => {
    expect(labelsOf(signedIn(), 'Recent')).toEqual([
      'Merging duplicate contacts',
      'Trip to Lisbon',
      'Garden layout',
    ]);
  });

  it('omits Recent when no conversation is loaded', () => {
    const sections = webPaletteSections({ query: '', conversations: [], signedIn: true, now: NOW });
    expect(headings(sections)).toEqual(['Actions', 'Go to']);
  });

  it('gives a solo conversation its date group as meta', () => {
    const recent = signedIn().find((section) => section.heading === 'Recent');
    expect(recent?.items.map((item) => item.meta)).toEqual([
      'Today',
      '3 members',
      'Previous 7 days',
    ]);
  });

  it('draws a group conversation with the users icon and a solo one with the message icon', () => {
    const recent = signedIn().find((section) => section.heading === 'Recent');
    expect(recent?.items.map((item) => item.icon)).toEqual([MessageSquare, Users, MessageSquare]);
  });

  it('runs a conversation by opening it', () => {
    const recent = signedIn().find((section) => section.heading === 'Recent');
    expect(recent?.items[0]).toMatchObject({ kind: 'conversation', conversationId: 'c-1' });
  });

  it('offers a trial visitor or link guest only the items that need no session', () => {
    const sections = signedOut();
    expect(
      sections.map((section) => [section.heading, section.items.map((index) => index.label)])
    ).toEqual([
      ['Actions', ['New chat']],
      ['Go to', ['Accessibility']],
    ]);
  });
});

describe('the action items', () => {
  function item(label: string): WebPaletteItem | undefined {
    return signedIn()
      .flatMap((section) => section.items)
      .find((candidate) => candidate.label === label);
  }

  it.each([
    ['New chat', 'newChat'],
    ['Add credit', 'addCredit'],
    ['Send feedback', 'sendFeedback'],
    ['Settings', 'settings'],
    ['Usage', 'usage'],
    ['Accessibility', 'accessibilityPage'],
  ] as const)('runs %s through the app action %s', (label, action) => {
    expect(item(label)).toMatchObject({ kind: 'action', action });
  });

  it('shows the New chat shortcut on its row', () => {
    expect(item('New chat')).toMatchObject({ shortcut: APP_SHORTCUTS.newChat });
  });

  it('shows the Settings shortcut on its row', () => {
    expect(item('Settings')).toMatchObject({ shortcut: APP_SHORTCUTS.settings });
  });
});

describe('webPaletteSections with a query', () => {
  it('finds a loaded conversation beyond the three most recent', () => {
    const found = signedIn('tax')
      .flatMap((section) => section.items)
      .map((item) => item.label);
    expect(found).toEqual(['Tax questions']);
  });

  it('gives a found conversation its date group as meta', () => {
    const found = signedIn('tax').flatMap((section) => section.items);
    expect(found[0]?.meta).toBe('Older');
  });

  it('leaves an unaccepted invite out of the search', () => {
    expect(signedIn('budget').flatMap((section) => section.items)).toEqual([]);
  });

  it('finds an item by its label', () => {
    const found = signedIn('usage')
      .flatMap((section) => section.items)
      .map((item) => item.label);
    expect(found).toEqual(['Usage']);
  });

  it('searches conversations and items together', () => {
    const sections = webPaletteSections({
      query: 'set',
      conversations: [conversation('c-set', 'Settings sync idea', 1)],
      signedIn: true,
      now: NOW,
    });
    expect(sections.flatMap((section) => section.items).map((item) => item.label)).toEqual([
      'Settings sync idea',
      'Settings',
    ]);
  });

  it('never finds an item that needs a session for a visitor without one', () => {
    expect(signedOut('settings').flatMap((section) => section.items)).toEqual([]);
  });

  it('never finds a conversation for a visitor without a session', () => {
    expect(signedOut('lisbon').flatMap((section) => section.items)).toEqual([]);
  });
});

describe('the date-group meta', () => {
  it('reads Previous 30 days for a conversation two weeks old', () => {
    const sections = webPaletteSections({
      query: '',
      conversations: [conversation('c-14', 'Fortnight', 14 * 24)],
      signedIn: true,
      now: NOW,
    });
    expect(sections[0]?.items[0]?.meta).toBe('Previous 30 days');
  });

  it('counts from the given instant, not the wall clock', () => {
    const later = new Date(NOW.getTime() + 2 * DAY_MS);
    const sections = webPaletteSections({
      query: '',
      conversations: [conversation('c-1', 'Merging duplicate contacts', 1)],
      signedIn: true,
      now: later,
    });
    expect(sections[0]?.items[0]?.meta).toBe('Previous 7 days');
  });
});
