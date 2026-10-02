import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './generation-guarded-writer-purity.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const PATH = 'apps/web/src/lib/load/session.ts';

describe('generation-guarded-writer-purity', () => {
  it('flags an async generation-guarded writer', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;

        async function commitLoad(startedAt: number, next: number): Promise<void> {
          if (dropped !== startedAt) return;
          value = next;
        }
      `,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/must stay synchronous/);
  });

  it('allows a synchronous generation-guarded writer', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;

        function commitLoad(startedAt: number, next: number): void {
          if (dropped !== startedAt) return;
          value = next;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags an async function sharing a file with a guarded writer that writes module state directly', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;
        let flag = false;

        function commitLoad(startedAt: number, next: number): void {
          if (dropped !== startedAt) return;
          value = next;
        }

        async function planLoad(): Promise<number> {
          flag = true;
          return 1;
        }
      `,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/must stay effect-free/);
  });

  it('allows an effect-free async function sharing a file with a guarded writer', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;

        function commitLoad(startedAt: number, next: number): void {
          if (dropped !== startedAt) return;
          value = next;
        }

        async function planLoad(): Promise<number> {
          return 1;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores an async function in a file with no generation-guarded writer', () => {
    const project = projectWith({
      [PATH]: `
        let counter = 0;

        async function increment(): Promise<void> {
          counter += 1;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not treat a guard-shaped function with no direct state write as a writer', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;

        async function noop(startedAt: number): Promise<string> {
          if (dropped !== startedAt) return;
          return 'x';
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('leaves a synchronous, unguarded helper that writes module state alone', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;
        let flag = false;

        function commitLoad(startedAt: number, next: number): void {
          if (dropped !== startedAt) return;
          value = next;
        }

        function reset(): void {
          flag = false;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags the same violating shape regardless of which file it sits in', () => {
    const shape = `
      let dropped = 0;
      let value = 0;

      async function commitLoad(startedAt: number, next: number): Promise<void> {
        if (dropped !== startedAt) return;
        value = next;
      }
    `;
    const project = projectWith({
      'apps/web/src/lib/load/session.ts': shape,
      'packages/shared/src/somewhere/else.ts': shape,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(2);
    expect(
      violations.map((violation) => violation.file).toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['apps/web/src/lib/load/session.ts', 'packages/shared/src/somewhere/else.ts']);
  });

  it('does not treat a module-scope const as a guarded variable', () => {
    const project = projectWith({
      [PATH]: `
        const dropped = 0;
        let value = 0;

        async function commitLoad(startedAt: number, next: number): Promise<void> {
          if (dropped !== startedAt) return;
          value = next;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a call-signature overload with no body', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;

        function commitLoad(startedAt: number, next: number): void;
        function commitLoad(startedAt: number, next: number): void {
          if (dropped !== startedAt) return;
          value = next;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not attribute a write inside a nested closure to the enclosing writer', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;

        async function commitLoad(startedAt: number, next: number): Promise<void> {
          if (dropped !== startedAt) return;
          const apply = () => {
            value = next;
          };
          apply();
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not attribute a nested-closure increment to the enclosing writer', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let counter = 0;

        async function commitLoad(startedAt: number): Promise<void> {
          if (dropped !== startedAt) return;
          const bump = () => {
            counter++;
          };
          bump();
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a non-step unary applied to a module let', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let flag = 0;

        function commitLoad(startedAt: number): void {
          if (dropped !== startedAt) return;
          const negated = -flag;
          void negated;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores an increment on a name the guard does not track', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;
        let untracked = 0;

        function commitLoad(startedAt: number): void {
          if (dropped !== startedAt) return;
          value = 1;
          untracked++;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('recognizes a braced bare return as a valid guard', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;

        async function commitLoad(startedAt: number, next: number): Promise<void> {
          if (dropped !== startedAt) {
            return;
          }
          value = next;
        }
      `,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/must stay synchronous/);
  });

  it('does not treat a block guard with more than one statement as a bare return', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;
        let sideEffect = 0;

        async function commitLoad(startedAt: number, next: number): Promise<void> {
          if (dropped !== startedAt) {
            sideEffect = 1;
            return;
          }
          value = next;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not treat an unbraced non-return then-clause as a bare return', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;

        async function commitLoad(startedAt: number, next: number): Promise<void> {
          if (dropped !== startedAt) doSomething();
          value = next;
        }

        function doSomething(): void {}
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not treat a guard whose condition is not a comparison as a generation guard', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;

        async function commitLoad(startedAt: boolean, next: number): Promise<void> {
          if (startedAt) return;
          value = next;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not treat an equality check as a generation guard', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;

        async function commitLoad(startedAt: number, next: number): Promise<void> {
          if (dropped === startedAt) return;
          value = next;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('recognizes the guarded operand on either side of the comparison', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;

        async function commitLoad(startedAt: number, next: number): Promise<void> {
          if (startedAt !== dropped) return;
          value = next;
        }
      `,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
  });

  it('does not treat an else-guarded first statement as a generation guard', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;

        async function commitLoad(startedAt: number, next: number): Promise<void> {
          if (dropped !== startedAt) return;
          else value = next;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not treat a guard whose then-branch returns a value as a bare return', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;

        async function commitLoad(startedAt: number, next: number): Promise<number | void> {
          if (dropped !== startedAt) return undefined;
          value = next;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does not treat an arrow function with a concise (non-block) body as a writer', () => {
    const project = projectWith({
      [PATH]: `
        let dropped = 0;
        let value = 0;

        const commitLoad = (startedAt: number, next: number): void =>
          dropped === startedAt ? (value = next) : undefined;
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a violating shape inside a colocated test file', () => {
    const project = projectWith({
      'apps/web/src/lib/load/session.test.ts': `
        let dropped = 0;
        let value = 0;

        async function commitLoad(startedAt: number, next: number): Promise<void> {
          if (dropped !== startedAt) return;
          value = next;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('does nothing for a file with no module-level let at all', () => {
    const project = projectWith({
      [PATH]: `
        const dropped = 0;

        async function readOnly(): Promise<number> {
          return dropped;
        }
      `,
    });

    expect(rule.check(project)).toEqual([]);
  });
});
