import { describe, it, expect } from 'vitest';
import * as door from '@hushbox/ui/field';

describe('@hushbox/ui/field', () => {
  it('publishes the fields, their message row and label recipe, and the toggle group', () => {
    expect(Object.keys(door).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'CheckField',
      'FieldMessage',
      'InlineInput',
      'LABELLED_FIELD_CLASSES',
      'RadioGroupField',
      'SelectField',
      'SwitchField',
      'TextareaField',
      'TextField',
      'ToggleGroup',
      'ToggleGroupItem',
    ]);
  });
});
