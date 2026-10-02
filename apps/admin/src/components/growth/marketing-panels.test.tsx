import { describe, expect, it } from 'vitest';
import { eventsPanelScope } from './marketing-panels.js';

/** What the screen hands down when its selection names no single campaign. */
const NO_CAMPAIGN: string | undefined = undefined;

describe('eventsPanelScope', () => {
  it('covers every campaign where no single campaign was picked', () => {
    expect(eventsPanelScope(NO_CAMPAIGN)).toEqual({
      campaigns: { kind: 'every-campaign', reason: 'one-at-a-time' },
      window: { kind: 'selected-week' },
    });
  });

  it('is narrowed where the read was given one campaign', () => {
    expect(eventsPanelScope('hn-launch')).toEqual({
      campaigns: { kind: 'narrowed' },
      window: { kind: 'selected-week' },
    });
  });
});
