import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The hooks are the only place the gates are actually mounted, and nothing else
 * in any suite would notice if a step lost its failure guard or if the gate
 * call disappeared. `sh` has no exit-on-error here, and the shim that supplies
 * one is generated at install time rather than tracked, so a guard this
 * repository owns is the only thing that makes a failed step stop the commit.
 */
const HOOKS = path.join(import.meta.dirname, '..', '.husky');

const hook = (name: string): string => readFileSync(path.join(HOOKS, name), 'utf8');

/** Continuation lines belong to the statement above them, not to themselves. */
function statements(source: string): string[] {
  return source
    .replaceAll(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/**
 * Statement shapes that carry no guard because they run no step. Inverted on
 * purpose: a matcher that recognised today's command verbs would go blind the
 * day a step is written with a different one, and the new step would pass
 * unguarded. Everything not named here must carry its guard, whatever it runs.
 */
const RUNS_NO_STEP = [
  // The optional per-clone hook, whose absence is the normal case.
  /^\[ -f \S+ ] && \. \S+$/,
  /^if .*; then$/,
  /^fi$/,
  /^echo /,
  /^exit \d+$/,
];

const runsAStep = (statement: string): boolean =>
  !RUNS_NO_STEP.some((shape) => shape.test(statement));

describe('the pre-commit hook', () => {
  const lines = statements(hook('pre-commit'));

  it('guards every step whose failure must stop the commit', () => {
    const unguarded = lines
      .filter((statement) => runsAStep(statement))
      .filter((statement) => !statement.includes('|| exit 1'));
    expect(unguarded).toEqual([]);
  });

  it('is a hook that actually runs steps, so the guard check is not vacuous', () => {
    expect(lines.filter((statement) => runsAStep(statement)).length).toBeGreaterThan(5);
  });

  it('runs the privacy gate over what is staged', () => {
    expect(lines.some((statement) => statement.includes('privacy-gate.ts commit'))).toBe(true);
  });

  it('runs the gate after the last file it stages', () => {
    const gate = lines.findIndex((statement) => statement.includes('privacy-gate.ts commit'));
    const lastStaged = lines.map((statement) => statement.startsWith('git add')).lastIndexOf(true);
    expect(gate).toBeGreaterThan(lastStaged);
  });
});

describe('the pre-push hook', () => {
  const lines = statements(hook('pre-push'));

  it('forwards the remote name and URL git gave it', () => {
    expect(hook('pre-push')).toContain('"$@"');
  });

  /**
   * The package manager echoes the resolved command line before it runs
   * anything, and this hook's arguments are the push destination, so an
   * unsilenced invocation prints the clone's path and the destination on every
   * push — above, and untouched by, the gate whose whole job is redacting both.
   * Invoking the script directly satisfies this too, which is the other shape
   * the sibling hook already uses.
   */
  it('runs its launcher without the package manager echoing the command line', () => {
    const unsilenced = lines
      .filter((statement) => /^pnpm\b/.test(statement))
      .filter((statement) => !/\s(?:-s|--silent)(?:\s|$)/.test(statement));
    expect(unsilenced).toEqual([]);
  });
});
