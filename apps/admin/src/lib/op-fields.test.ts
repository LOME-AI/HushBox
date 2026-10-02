import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ADMIN_OP_CONTRACTS, ADMIN_OP_NAMES, VALUE_WRAPPERS } from '@hushbox/shared';
import {
  buildOpInput,
  describeField,
  describeOpFields,
  groupErrorKey,
  remapGroupRowErrors,
  toFormValues,
} from './op-fields.js';

/** One wrapper instance over `inner`; zod's def `type` is the class name less
 * its `Zod` prefix, and the seven classes share no constructor signature. */
function wrapOnce(
  wrapper: (typeof VALUE_WRAPPERS)[number],
  inner: z.ZodType,
  sample: unknown
): z.ZodType {
  const built: unknown = Reflect.construct(wrapper, [
    {
      type: wrapper.name.replace(/^Zod/, '').toLowerCase(),
      innerType: inner,
      defaultValue: sample,
      catchValue: () => sample,
    },
  ]);
  if (!(built instanceof z.ZodType)) {
    throw new TypeError(`${wrapper.name} did not construct a schema`);
  }
  return built;
}

/**
 * Every wrapper chain the shared contract admits, walked off that module's list
 * so a kind added there is covered here without being named again: each kind
 * over a plain value, and each over every other, which is where an outer
 * wrapper can reverse what an inner one did to optionality.
 */
function wrapperChains(
  inner: z.ZodType,
  sample: unknown
): readonly { readonly label: string; readonly schema: z.ZodType }[] {
  const single = VALUE_WRAPPERS.map((wrapper) => ({
    label: wrapper.name,
    schema: wrapOnce(wrapper, inner, sample),
  }));
  const nested = single.flatMap((held) =>
    VALUE_WRAPPERS.map((wrapper) => ({
      label: `${wrapper.name}(${held.label})`,
      schema: wrapOnce(wrapper, held.schema, sample),
    }))
  );
  return [...single, ...nested];
}

describe('describeOpFields', () => {
  it('derives text controls for the wallet.credit contract fields', () => {
    const fields = describeOpFields('wallet.credit', []);
    expect(fields.map((field) => field.name)).toEqual(['walletId', 'amountNanoUsd', 'reason']);
    expect(fields.every((field) => field.control === 'text')).toBe(true);
    expect(fields.every((field) => field.required)).toBe(true);
  });

  it('derives an enum control with options for user.lock lockReason', () => {
    const fields = describeOpFields('user.lock', []);
    const lockReason = fields.find((field) => field.name === 'lockReason');
    expect(lockReason?.control).toBe('enum');
    expect(lockReason?.options).toEqual(['chargeback', 'admin']);
  });

  it('orders reason last even when the contract declares it earlier', () => {
    const fields = describeOpFields('user.lock', []);
    expect(fields.at(-1)?.name).toBe('reason');
  });

  it('derives boolean and group controls for the banner.set contract', () => {
    const fields = describeOpFields('banner.set', []);
    expect(fields.map((field) => field.name)).toEqual(['enabled', 'messages', 'reason']);
    expect(fields[0]?.control).toBe('boolean');
    expect(fields[1]?.control).toBe('group');
  });

  it('derives banner.set group sub-fields with their scalar controls', () => {
    const messages = describeOpFields('banner.set', []).find((field) => field.name === 'messages');
    // Keyed lookups, not an exact list: sub-fields mirror whatever the live
    // contract's group element declares.
    const subs = Object.fromEntries((messages?.fields ?? []).map((sub) => [sub.name, sub]));
    expect(subs['variant']).toMatchObject({ control: 'enum', required: true });
    expect(subs['variant']?.options).toEqual(['info', 'warning', 'critical']);
    expect(subs['text']).toMatchObject({ control: 'text', required: true });
    expect(subs['href']).toMatchObject({ control: 'text', required: false });
  });

  // The form's determination is checked against the contracts' own rejection of
  // an absent key, so form and server cannot drift into agreeing on a wrong
  // answer the way an expectation computed the source's own way would.
  it('marks exactly the fields the live contracts reject an absent key for', () => {
    const drawn = ADMIN_OP_NAMES.flatMap((opName) =>
      describeOpFields(opName, [])
        .filter((field) => field.required)
        .map((field) => `${opName}.${field.name}`)
    ).toSorted((left, right) => left.localeCompare(right));
    const rejected = ADMIN_OP_NAMES.flatMap((opName) => {
      const parsed = ADMIN_OP_CONTRACTS[opName].input.safeParse({});
      if (parsed.success) {
        return [];
      }
      const names = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
      return [...names].map((fieldName) => `${opName}.${fieldName}`);
    }).toSorted((left, right) => left.localeCompare(right));
    expect(rejected).not.toEqual([]);
    expect(drawn).toEqual(rejected);
  });

  it('falls back to required text fields from the wire list for an unknown op', () => {
    const fields = describeOpFields('future.op', ['targetId', 'reason']);
    expect(fields).toEqual([
      { name: 'targetId', required: true, control: 'text' },
      { name: 'reason', required: true, control: 'text' },
    ]);
  });
});

describe('describeField', () => {
  it('marks an optional field as not required and unwraps to its control', () => {
    const field = describeField('note', z.string().optional());
    expect(field.required).toBe(false);
    expect(field.control).toBe('text');
  });

  it('treats a defaulted field as not required', () => {
    const field = describeField('count', z.number().default(1));
    expect(field.required).toBe(false);
    expect(field.control).toBe('number');
  });

  it('derives a number control from a plain number schema', () => {
    const field = describeField('count', z.number().int());
    expect(field).toMatchObject({ required: true, control: 'number' });
  });

  it('unwraps a readonly-wrapped enum to an enum control', () => {
    const field = describeField('mode', z.enum(['a', 'b']).readonly());
    expect(field.control).toBe('enum');
    expect(field.options).toEqual(['a', 'b']);
  });

  it('derives a boolean control from a boolean schema', () => {
    const field = describeField('enabled', z.boolean());
    expect(field).toMatchObject({ required: true, control: 'boolean' });
  });

  it('derives a group control with sub-field descriptors from an object array', () => {
    const field = describeField(
      'rows',
      z.array(z.object({ label: z.string(), count: z.number() }))
    );
    expect(field.control).toBe('group');
    expect(field.fields?.map((sub) => `${sub.name}:${sub.control}`)).toEqual([
      'label:text',
      'count:number',
    ]);
  });

  it('marks an optional group as not required', () => {
    const field = describeField('rows', z.array(z.object({ label: z.string() })).optional());
    expect(field.control).toBe('group');
    expect(field.required).toBe(false);
  });

  it('unwraps every wrapper chain the shared contract admits to its inner control', () => {
    const chains = wrapperChains(z.enum(['a', 'b']), 'a');
    const controls = chains.map(({ label, schema }) => {
      const field = describeField('mode', schema);
      return { label, control: field.control, options: field.options };
    });
    expect(controls).toEqual(
      chains.map(({ label }) => ({ label, control: 'enum', options: ['a', 'b'] }))
    );
  });

  it('marks a field required exactly when its schema rejects an absent key', () => {
    const chains = wrapperChains(z.enum(['a', 'b']), 'a');
    const drawn = chains.map(({ label, schema }) => ({
      label,
      required: describeField('mode', schema).required,
    }));
    expect(drawn).toEqual(
      chains.map(({ label, schema }) => ({
        label,
        required: !z.object({ mode: schema }).safeParse({}).success,
      }))
    );
  });

  // The two chains a rule that enumerates optionalising wrappers gets wrong,
  // pinned literally: an expectation computed the source's own way moves with
  // the source and would agree with a wrong rule.
  it('marks a nonoptional over an optional as required', () => {
    expect(describeField('mode', z.enum(['a', 'b']).optional().nonoptional()).required).toBe(true);
  });

  it('marks a nonoptional over a default as required', () => {
    expect(describeField('mode', z.enum(['a', 'b']).default('a').nonoptional()).required).toBe(
      true
    );
  });
});

describe('buildOpInput', () => {
  it('returns the wire input for valid values', () => {
    const fields = describeOpFields('wallet.credit', []);
    const result = buildOpInput(fields, {
      walletId: '5b6a4a1e-7f4f-4bfb-9d5e-0a4c1d2e3f40',
      amountNanoUsd: '5000000000',
      reason: 'test credit',
    });
    expect(result.errors).toEqual({});
    expect(result.input).toEqual({
      walletId: '5b6a4a1e-7f4f-4bfb-9d5e-0a4c1d2e3f40',
      amountNanoUsd: '5000000000',
      reason: 'test credit',
    });
  });

  it('reports a required error for a blank required field', () => {
    const fields = describeOpFields('wallet.credit', []);
    const result = buildOpInput(fields, { walletId: '', amountNanoUsd: '', reason: '' });
    expect(result.errors['walletId']).toBe('This field is required.');
    expect(result.errors['reason']).toBe('This field is required.');
  });

  it('reports the schema message for a value the contract rejects', () => {
    const fields = describeOpFields('wallet.credit', []);
    const result = buildOpInput(fields, {
      walletId: 'not-a-uuid',
      amountNanoUsd: '12',
      reason: 'x',
    });
    expect(result.errors['walletId']).toBeTruthy();
    expect(result.errors['amountNanoUsd']).toBeUndefined();
  });

  it('submits number controls as numbers', () => {
    const result = buildOpInput([{ name: 'count', required: true, control: 'number' }], {
      count: '3',
    });
    expect(result.input['count']).toBe(3);
  });

  it('omits blank optional fields from the input', () => {
    const result = buildOpInput([{ name: 'note', required: false, control: 'text' }], {
      note: '',
    });
    expect(result.errors).toEqual({});
    expect('note' in result.input).toBe(false);
  });

  it('submits a boolean control as a boolean, defaulting an untouched value to false', () => {
    const fields = describeOpFields('banner.set', []);
    const result = buildOpInput(fields, { enabled: true, messages: [], reason: 'toggle on' });
    expect(result.errors).toEqual({});
    expect(result.input['enabled']).toBe(true);

    const untouched = buildOpInput(fields, { messages: [], reason: 'toggle off' });
    expect(untouched.errors).toEqual({});
    expect(untouched.input['enabled']).toBe(false);
  });

  it('omits an untouched optional boolean from the input', () => {
    const result = buildOpInput([{ name: 'flag', required: false, control: 'boolean' }], {});
    expect(result.errors).toEqual({});
    expect('flag' in result.input).toBe(false);
  });

  it('assembles group rows into an array of row objects', () => {
    const fields = describeOpFields('banner.set', []);
    const result = buildOpInput(fields, {
      enabled: true,
      messages: [
        { variant: 'info', text: 'Scheduled maintenance', href: 'https://status.hushbox.ai' },
        { variant: 'warning', text: 'Second row' },
      ],
      reason: 'announce maintenance',
    });
    expect(result.errors).toEqual({});
    expect(result.input['messages']).toEqual([
      { variant: 'info', text: 'Scheduled maintenance', href: 'https://status.hushbox.ai' },
      { variant: 'warning', text: 'Second row' },
    ]);
  });

  it('drops group rows whose sub-fields are all empty', () => {
    const fields = describeOpFields('banner.set', []);
    const result = buildOpInput(fields, {
      enabled: true,
      messages: [{ variant: 'info', text: 'Kept row' }, { variant: '', text: '', href: '' }, {}],
      reason: 'trailing rows ignored',
    });
    expect(result.errors).toEqual({});
    expect(result.input['messages']).toEqual([{ variant: 'info', text: 'Kept row' }]);
  });

  it('reports per-sub-field errors for a partially filled group row', () => {
    const fields = describeOpFields('banner.set', []);
    const result = buildOpInput(fields, {
      enabled: true,
      messages: [{ variant: 'info', text: '' }],
      reason: 'partial row',
    });
    expect(result.errors[groupErrorKey('messages', 0, 'text')]).toBe('This field is required.');
    expect('messages' in result.input).toBe(false);
  });

  it('reports the schema message on the sub-field a row value violates', () => {
    const fields = describeOpFields('banner.set', []);
    const result = buildOpInput(fields, {
      enabled: true,
      messages: [{ variant: 'info', text: 'ok', href: 'javascript:alert(1)' }],
      reason: 'unsafe href',
    });
    expect(result.errors[groupErrorKey('messages', 0, 'href')]).toBeTruthy();
  });

  it('reports a group-level error when the assembled array violates the field schema', () => {
    const fields = describeOpFields('banner.set', []);
    const rows = Array.from({ length: 21 }, (_, index) => ({
      variant: 'info',
      text: `Row ${String(index)}`,
    }));
    const result = buildOpInput(fields, {
      enabled: true,
      messages: rows,
      reason: 'too many rows',
    });
    expect(result.errors['messages']).toBeTruthy();
  });

  it('submits an empty required group as an empty array', () => {
    const fields = describeOpFields('banner.set', []);
    const result = buildOpInput(fields, { enabled: false, messages: [], reason: 'clear banner' });
    expect(result.errors).toEqual({});
    expect(result.input['messages']).toEqual([]);
  });

  it('treats a missing group value as an empty row list', () => {
    const fields = describeOpFields('banner.set', []);
    const result = buildOpInput(fields, { enabled: false, reason: 'no rows value' });
    expect(result.errors).toEqual({});
    expect(result.input['messages']).toEqual([]);
  });

  it('treats a group-shaped value on a scalar field as untouched', () => {
    const result = buildOpInput([{ name: 'note', required: false, control: 'text' }], {
      note: [],
    });
    expect(result.errors).toEqual({});
    expect('note' in result.input).toBe(false);
  });

  it('drops every row of a group descriptor without sub-fields', () => {
    const result = buildOpInput([{ name: 'rows', required: true, control: 'group' }], {
      rows: [{ stray: 'x' }],
    });
    expect(result.errors).toEqual({});
    expect(result.input['rows']).toEqual([]);
  });

  it('omits an empty optional group from the input', () => {
    const field = describeField('rows', z.array(z.object({ label: z.string() })).optional());
    const result = buildOpInput([field], { rows: [{}] });
    expect(result.errors).toEqual({});
    expect('rows' in result.input).toBe(false);
  });
});

describe('groupErrorKey', () => {
  it('derives the row-scoped error key the form and builder share', () => {
    expect(groupErrorKey('messages', 2, 'text')).toBe('messages.2.text');
  });
});

describe('remapGroupRowErrors', () => {
  it('moves a row-scoped error key through the index mapping', () => {
    const remapped = remapGroupRowErrors(
      { 'messages.0.text': 'required', 'messages.1.text': 'bad' },
      'messages',
      (index) => [1, 0][index] ?? index
    );
    expect(remapped).toEqual({ 'messages.1.text': 'required', 'messages.0.text': 'bad' });
  });

  it('leaves other fields and the group-level key untouched', () => {
    const remapped = remapGroupRowErrors(
      { messages: 'too many rows', 'messages.0.text': 'required', reason: 'required' },
      'messages',
      (index) => index + 1
    );
    expect(remapped).toEqual({
      messages: 'too many rows',
      'messages.1.text': 'required',
      reason: 'required',
    });
  });

  it('drops keys whose row the mapping maps to undefined', () => {
    const remapped = remapGroupRowErrors(
      { 'messages.0.text': 'stays', 'messages.1.text': 'dropped', 'messages.2.text': 'shifts' },
      'messages',
      (index) => {
        if (index === 1) {
          return;
        }
        return index > 1 ? index - 1 : index;
      }
    );
    expect(remapped).toEqual({ 'messages.0.text': 'stays', 'messages.1.text': 'shifts' });
  });

  it('does not treat a same-prefixed field name as a row key', () => {
    const remapped = remapGroupRowErrors(
      { 'messagesExtra.0.text': 'required' },
      'messages',
      (index) => index + 1
    );
    expect(remapped).toEqual({ 'messagesExtra.0.text': 'required' });
  });
});

describe('toFormValues', () => {
  it('preserves booleans and stringifies scalars', () => {
    expect(toFormValues({ enabled: true, amount: 5, note: 'x' })).toEqual({
      enabled: true,
      amount: '5',
      note: 'x',
    });
  });

  it('maps array values to group rows with stringified scalar sub-values', () => {
    expect(
      toFormValues({ messages: [{ variant: 'info', text: 'Hi', pinned: false, weight: 2 }] })
    ).toEqual({ messages: [{ variant: 'info', text: 'Hi', pinned: false, weight: '2' }] });
  });

  it('maps a non-object array element to an empty row', () => {
    expect(toFormValues({ rows: ['stray'] })).toEqual({ rows: [{}] });
  });
});
