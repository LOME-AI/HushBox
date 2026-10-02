import { describe, it, expect } from 'vitest';
import {
  DISPATCH_OPTIONS_MARKER,
  DISPATCH_OPTIONS_OWNERS,
  manifestToDispatchOptions,
  replaceGeneratedSection,
} from './generate-dispatch-options.js';
import type { OpsManifest, OpsScript } from './generate-labels.js';

function script(name: string, phase: OpsScript['phase'] = 'pre-deploy'): OpsScript {
  return { name, file: `ops/x/${name}.ts`, phase, description: 'd', requires_secrets: [] };
}

describe('manifestToDispatchOptions', () => {
  it('emits one `- <name>` line per script, in manifest order, trailing newline', () => {
    const manifest: OpsManifest = {
      scripts: [script('configure-r2-cors'), script('rotate-keys', 'post-deploy')],
    };

    expect(manifestToDispatchOptions(manifest)).toBe('- configure-r2-cors\n- rotate-keys\n');
  });

  it('handles a single-script manifest', () => {
    expect(manifestToDispatchOptions({ scripts: [script('configure-r2-cors')] })).toBe(
      '- configure-r2-cors\n'
    );
  });
});

describe('replaceGeneratedSection', () => {
  const content = [
    'options:',
    '          # BEGIN GENERATED: ops-dispatch-options',
    '          - stale-entry',
    '          # END GENERATED: ops-dispatch-options',
  ].join('\n');

  it('refuses content carrying none of the pairs its ownership declares', () => {
    expect(() =>
      replaceGeneratedSection(
        'options:\n  - stale-entry',
        DISPATCH_OPTIONS_MARKER,
        '- configure-r2-cors\n',
        DISPATCH_OPTIONS_OWNERS
      )
    ).toThrow(/ops-dispatch-options — 1 declared, 0 found/);
  });

  it('refuses a second pair of the one pair it owns', () => {
    expect(() =>
      replaceGeneratedSection(
        [content, content].join('\n'),
        DISPATCH_OPTIONS_MARKER,
        '- configure-r2-cors\n',
        DISPATCH_OPTIONS_OWNERS
      )
    ).toThrow(/ops-dispatch-options — 1 declared, 2 found/);
  });

  it('names both remedies when it refuses', () => {
    expect(() =>
      replaceGeneratedSection(
        'options:\n  - stale-entry',
        DISPATCH_OPTIONS_MARKER,
        '- configure-r2-cors\n',
        DISPATCH_OPTIONS_OWNERS
      )
    ).toThrow(
      'Restore the missing marker pair, or update DISPATCH_OPTIONS_OWNERS in ops/lib/generate-dispatch-options.ts'
    );
  });

  // A marker that is a prefix of the next one: the END match must not reach the
  // sibling's, which would rewrite both blocks into one.
  it('refuses a section whose END marker was deleted ahead of a longer-named sibling', () => {
    const halfDeleted = [
      'options:',
      '          # BEGIN GENERATED: ops-dispatch-options',
      '          - stale-entry',
      '          # BEGIN GENERATED: ops-dispatch-options-extra',
      '          - other',
      '          # END GENERATED: ops-dispatch-options-extra',
    ].join('\n');

    expect(() =>
      replaceGeneratedSection(
        halfDeleted,
        DISPATCH_OPTIONS_MARKER,
        '- configure-r2-cors\n',
        DISPATCH_OPTIONS_OWNERS
      )
    ).toThrow(/ops-dispatch-options — 1 declared, 0 found/);
  });

  it('replaces the marked body, preserving the BEGIN-marker indentation', () => {
    const out = replaceGeneratedSection(
      content,
      'ops-dispatch-options',
      '- configure-r2-cors\n',
      DISPATCH_OPTIONS_OWNERS
    );

    expect(out).toContain('          - configure-r2-cors');
    expect(out).not.toContain('stale-entry');
    expect(out).toContain('          # BEGIN GENERATED: ops-dispatch-options');
    expect(out).toContain('          # END GENERATED: ops-dispatch-options');
  });

  it('is idempotent — replacing with the same body twice yields identical output', () => {
    const once = replaceGeneratedSection(
      content,
      'ops-dispatch-options',
      '- configure-r2-cors\n',
      DISPATCH_OPTIONS_OWNERS
    );
    const twice = replaceGeneratedSection(
      once,
      'ops-dispatch-options',
      '- configure-r2-cors\n',
      DISPATCH_OPTIONS_OWNERS
    );

    expect(twice).toBe(once);
  });
});
