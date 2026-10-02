import { describe, it, expect } from 'vitest';
import { AGENT_OWNED_FIELDS } from '@hushbox/docket';
import { LAUNCH_BARE_FLAG, LAUNCH_VALUE_FLAGS } from '../server/launch-options';
import { formatHelp } from './help';
import {
  ALLOWED_FLAGS,
  ARGUMENTS,
  ENUM_FLAGS,
  EXCLUSIVE,
  KIND_BY_ACTION,
  OPEN_VALUES,
  REQUIRED_FLAGS,
} from './parse-command';
import { SETTABLE_FIELDS } from './write';
import type { ActionKind } from './parse-command';

function blocks(): string[] {
  return formatHelp().split('\n\n');
}

/** The block one action owns: its usage line and the flags beneath it. */
function blockFor(flag: string): string {
  return blocks().find((block) => block.startsWith(`  pnpm docket ${flag}`)) ?? '';
}

const PLACEHOLDERS = new Map<string, string>(Object.entries(OPEN_VALUES));

/** A flag as the parser declares it, which is how the output has to print it. */
function spec(flag: string): string {
  const placeholder = PLACEHOLDERS.get(flag);
  return placeholder === undefined ? flag : `${flag}=${placeholder}`;
}

function required(kind: ActionKind): string[] {
  return ALLOWED_FLAGS[kind].filter((flag) => REQUIRED_FLAGS.includes(flag));
}

/**
 * The flags a block offers, read as whole tokens rather than as substrings: one
 * flag is another's prefix, so a block offering --dedicated reads as offering
 * --dedicate to anything matching on text alone.
 */
function offered(block: string): string[] {
  return block.match(/--[a-z-]+/gu) ?? [];
}

function launcher(): string {
  return blocks().find((block) => block.startsWith('Usage')) ?? '';
}

function queues(): string {
  return blocks().find((block) => block.startsWith('Queues')) ?? '';
}

describe('formatHelp', () => {
  it('names every action the parser accepts', () => {
    for (const flag of Object.keys(KIND_BY_ACTION)) {
      expect(blockFor(flag)).not.toBe('');
    }
  });

  it('states an action arguments as the parser states them', () => {
    for (const [flag, kind] of Object.entries(KIND_BY_ACTION)) {
      const line = [flag, ARGUMENTS[kind].shape, ...required(kind).map((must) => spec(must))]
        .filter((part) => part !== '')
        .join(' ');
      expect(blockFor(flag).split('\n')[0]).toBe(`  pnpm docket ${line}`);
    }
  });

  it('puts a flag an action cannot run without where the reader must type it', () => {
    for (const [flag, kind] of Object.entries(KIND_BY_ACTION)) {
      for (const must of required(kind)) {
        expect(blockFor(flag).split('\n')[0]).toContain(spec(must));
      }
    }
  });

  it('offers a required flag once rather than twice', () => {
    for (const [flag, kind] of Object.entries(KIND_BY_ACTION)) {
      for (const must of required(kind)) {
        expect(blockFor(flag).split(must).length - 1).toBe(1);
      }
    }
  });

  it('offers every flag an action allows', () => {
    for (const [flag, kind] of Object.entries(KIND_BY_ACTION)) {
      for (const allowed of ALLOWED_FLAGS[kind]) {
        if (allowed !== flag) expect(blockFor(flag)).toContain(allowed);
      }
    }
  });

  it('offers no flag an action refuses', () => {
    const every = new Set(Object.values(ALLOWED_FLAGS).flat());
    for (const [flag, kind] of Object.entries(KIND_BY_ACTION)) {
      for (const candidate of every) {
        if (!ALLOWED_FLAGS[kind].includes(candidate))
          expect(offered(blockFor(flag))).not.toContain(candidate);
      }
    }
  });

  it('prints the values a closed-set flag accepts', () => {
    for (const [flag, values] of Object.entries(ENUM_FLAGS)) {
      expect(formatHelp()).toContain(`${flag}=${values.join('|')}`);
    }
  });

  it('names an open flag value as the parser declares it', () => {
    for (const [flag, placeholder] of Object.entries(OPEN_VALUES)) {
      expect(formatHelp()).toContain(`${flag}=${placeholder}`);
    }
  });

  it('leaves no flag value unnamed', () => {
    expect(formatHelp()).not.toContain('<value>');
  });

  it('names the pairs the parser refuses together', () => {
    for (const [one, other] of EXCLUSIVE) {
      expect(formatHelp()).toContain(`${one} and ${other}`);
    }
  });

  it('leaves no action kind without a flag that names it', () => {
    const byName = (left: string, right: string): number => left.localeCompare(right);
    expect(Object.keys(ARGUMENTS).toSorted(byName)).toEqual(
      Object.values(KIND_BY_ACTION).toSorted(byName)
    );
  });

  it('says what a bare invocation does', () => {
    expect(formatHelp()).toContain('start the console');
  });

  it('names every flag the console launcher takes', () => {
    for (const flag of [...LAUNCH_VALUE_FLAGS.keys(), LAUNCH_BARE_FLAG]) {
      expect(launcher()).toContain(flag);
    }
  });

  it('names a launch flag value as the launcher declares it', () => {
    for (const [flag, placeholder] of LAUNCH_VALUE_FLAGS) {
      expect(launcher()).toContain(`${flag}=${placeholder}`);
    }
  });

  it('leaves the launcher bare flag bare', () => {
    expect(launcher()).not.toContain(`${LAUNCH_BARE_FLAG}=`);
  });

  it('names every field --set writes', () => {
    for (const field of SETTABLE_FIELDS) expect(blockFor('--set')).toContain(field);
  });

  it('offers no field --set refuses', () => {
    const dropped = AGENT_OWNED_FIELDS.filter((field) => !SETTABLE_FIELDS.includes(field));
    for (const field of dropped) expect(blockFor('--set')).not.toContain(field);
  });

  /**
   * The field list, not a field name: a field and a queue can share a name, and
   * a bare-substring reading would then call a section value a leaked field.
   */
  it('names the writable fields on no action but --set', () => {
    for (const [flag] of Object.entries(KIND_BY_ACTION)) {
      if (flag !== '--set') expect(blockFor(flag)).not.toContain('field must be one of');
    }
  });

  it('says what the work queue leaves out', () => {
    expect(queues()).toContain('--section=ruled');
  });

  it('says how the tracking queue differs', () => {
    expect(queues()).toContain('--section=progress');
  });

  it('separates the two briefs', () => {
    expect(queues()).toContain('--contest');
  });

  it('says which findings a listing leaves out unasked', () => {
    expect(queues()).toContain('--section=dedicated');
  });

  it('says how a skipped finding is still reachable', () => {
    expect(queues()).toContain('--id');
  });

  it('separates the membership question from the citation-health one', () => {
    expect(queues()).toContain('--census');
  });

  it('says that the questions document is not one of the listings that skip', () => {
    expect(queues()).toContain('--questions');
  });

  it('leaves no line too wide to read in a terminal', () => {
    for (const line of formatHelp().split('\n')) expect(line.length).toBeLessThanOrEqual(100);
  });
});
