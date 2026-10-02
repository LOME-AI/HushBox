import { describe, it, expect } from 'vitest';
import { groupPartners } from './group-partners';

describe('groupPartners', () => {
  it('reads the other members out of a group name', () => {
    expect(groupPartners('CH-5 + CH-6', 'CH-5')).toEqual(['CH-6']);
  });

  it('reads a group of three', () => {
    expect(groupPartners('CI-15 + CI-37 + TS-NF-1', 'CI-37')).toEqual(['CI-15', 'TS-NF-1']);
  });

  it('keeps every member when the reader is not one of them', () => {
    expect(groupPartners('WF-1 + TS-1', 'AI-1')).toEqual(['WF-1', 'TS-1']);
  });

  it('tolerates the spacing a hand-written group name may carry', () => {
    expect(groupPartners('UI-1+UI-2 +  UI-23', 'UI-1')).toEqual(['UI-2', 'UI-23']);
  });

  it('has no members for a group with no name', () => {
    expect(groupPartners(null, 'AI-1')).toEqual([]);
  });

  it('has no members for a group name that is only a label', () => {
    expect(groupPartners('the push cluster', 'AI-1')).toEqual(['the push cluster']);
  });
});
