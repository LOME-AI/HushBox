import { describe, it, expect } from 'vitest';
import * as door from '@hushbox/ui/button-groups';
import { buttonRowClass, buttonStackClass } from './button-group-classes';
import { measureButtonGroups } from './measure-button-groups';

describe('@hushbox/ui/button-groups', () => {
  it('publishes the group classes and the measure', () => {
    expect(Object.keys(door).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'buttonRowClass',
      'buttonStackClass',
      'measureButtonGroups',
    ]);
  });

  it('publishes the row class the React row wears', () => {
    expect(door.buttonRowClass).toBe(buttonRowClass);
  });

  it('publishes the stack class the React stack wears', () => {
    expect(door.buttonStackClass).toBe(buttonStackClass);
  });

  it('publishes the measure the React groups call', () => {
    expect(door.measureButtonGroups).toBe(measureButtonGroups);
  });
});
