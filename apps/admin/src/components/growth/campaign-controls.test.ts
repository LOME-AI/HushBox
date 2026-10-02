import { describe, expect, it } from 'vitest';
import {
  CAMPAIGN_ARCHIVE_OP,
  CAMPAIGN_CREATE_OP,
  canManageCampaigns,
  isArchivable,
} from './campaign-controls.js';
import type { AdminOpWire } from '@hushbox/shared';

function op(name: string): AdminOpWire {
  return {
    name,
    title: name,
    kind: 'mutation',
    effectClass: 'durable',
    inverse: null,
    fields: [],
  };
}

const READS = [op('growth.funnel.read'), op('growth.campaigns.read')];

describe('canManageCampaigns', () => {
  it('is true when the catalogue names both campaign operations', () => {
    expect(canManageCampaigns([...READS, op(CAMPAIGN_CREATE_OP), op(CAMPAIGN_ARCHIVE_OP)])).toBe(
      true
    );
  });

  it('is false for a catalogue holding only reads', () => {
    expect(canManageCampaigns(READS)).toBe(false);
  });

  it('is false when only one of the pair is named', () => {
    expect(canManageCampaigns([...READS, op(CAMPAIGN_CREATE_OP)])).toBe(false);
  });

  it('is false when the catalogue has not answered yet', () => {
    expect(canManageCampaigns()).toBe(false);
  });

  it('is false for an empty catalogue', () => {
    expect(canManageCampaigns([])).toBe(false);
  });
});

describe('isArchivable', () => {
  it('allows archiving an active campaign an operator minted', () => {
    expect(isArchivable({ tag: 'hn-launch', status: 'active' })).toBe(true);
  });

  it('refuses a campaign that is already archived', () => {
    expect(isArchivable({ tag: 'hn-launch', status: 'archived' })).toBe(false);
  });

  it('refuses the tag every untagged visit folds to', () => {
    expect(isArchivable({ tag: 'direct', status: 'active' })).toBe(false);
  });

  it('refuses the tag every unrecognised tag folds to', () => {
    expect(isArchivable({ tag: 'unknown', status: 'active' })).toBe(false);
  });
});
