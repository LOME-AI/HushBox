import { describe, it, expect } from 'vitest';
import { manifestToDispatchOptions, replaceGeneratedSection } from './generate-dispatch-options.js';
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

  it('replaces the marked body, preserving the BEGIN-marker indentation', () => {
    const out = replaceGeneratedSection(content, 'ops-dispatch-options', '- configure-r2-cors\n');

    expect(out).toContain('          - configure-r2-cors');
    expect(out).not.toContain('stale-entry');
    expect(out).toContain('          # BEGIN GENERATED: ops-dispatch-options');
    expect(out).toContain('          # END GENERATED: ops-dispatch-options');
  });

  it('is idempotent — replacing with the same body twice yields identical output', () => {
    const once = replaceGeneratedSection(content, 'ops-dispatch-options', '- configure-r2-cors\n');
    const twice = replaceGeneratedSection(once, 'ops-dispatch-options', '- configure-r2-cors\n');

    expect(twice).toBe(once);
  });
});
