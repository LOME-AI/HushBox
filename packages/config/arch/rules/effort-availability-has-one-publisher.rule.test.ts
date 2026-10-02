import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './effort-availability-has-one-publisher.rule.js';

const PUBLISHER_MODULE = 'apps/web/src/hooks/chat/use-reasoning-effort.ts';
const STORE_MODULE = 'apps/web/src/stores/reasoning-effort.ts';
const CALL_SITE = 'apps/web/src/components/chat/input/reasoning-effort-menu.tsx';
const ELSEWHERE = 'apps/web/src/hooks/billing/use-prompt-budget.ts';

/** The publisher as its module declares it: reads the setter, writes it in an effect. */
const PUBLISHER_SOURCE = `
import * as React from 'react';
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

export function useEffortAvailabilityPublisher(dimension: unknown): void {
  const setEnabledEffortChoices = useReasoningEffortStore(
    (state) => state.setEnabledEffortChoices
  );
  React.useEffect(() => {
    setEnabledEffortChoices(gradeOf(dimension));
  }, [dimension, setEnabledEffortChoices]);
}
`;

/**
 * The store as its module declares it, in both places it declares it: the state
 * type spells the setter's signature and the `create(...)` initializer implements
 * it. The real module carries both, and a test store that carried only the second
 * would leave the type arm of the store's exemption unexercised.
 */
const STORE_SOURCE = `
interface ReasoningEffortState {
  enabledEffortChoices: readonly string[] | undefined;
  setEnabledEffortChoices: (choices: readonly string[] | undefined) => void;
}

export const useReasoningEffortStore = create<ReasoningEffortState>()(
  persist((set, get) => ({
    enabledEffortChoices: undefined,
    setEnabledEffortChoices: (choices) => set({ enabledEffortChoices: choices }),
  }))
);
`;

/** The composer's effort control — the one call site. */
const CALL_SITE_SOURCE = `
import { useEffortAvailabilityPublisher } from '@/hooks/chat/use-reasoning-effort';

export function ReasoningEffortMenu({ effortDimension }: Props): JSX.Element {
  useEffortAvailabilityPublisher(effortDimension);
  return <div />;
}
`;

function projectOf(files: Readonly<Record<string, string>>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

/**
 * Every project the rule judges holds the publisher's own module, because the
 * rule locates the publisher there rather than trusting a name to exist. A test
 * that varies that module passes its own under the same key.
 */
function projectWith(files: Readonly<Record<string, string>>): Project {
  return projectOf({
    [PUBLISHER_MODULE]: PUBLISHER_SOURCE,
    [STORE_MODULE]: STORE_SOURCE,
    [CALL_SITE]: CALL_SITE_SOURCE,
    ...files,
  });
}

describe('effort-availability-has-one-publisher', () => {
  it('passes the shape the repo carries today — one publisher, one call site', () => {
    expect(rule.check(projectWith({}))).toEqual([]);
  });

  describe('the call-site clause', () => {
    it('flags a second surface calling the publisher', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useEffortAvailabilityPublisher } from '@/hooks/chat/use-reasoning-effort';

export function usePromptBudget(dimension: unknown): void {
  useEffortAvailabilityPublisher(dimension);
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 5 });
      expect(violations[0]?.message).toContain('second call site');
    });

    it('flags a second call inside the one call site itself', () => {
      const violations = rule.check(
        projectWith({
          [CALL_SITE]: `
import { useEffortAvailabilityPublisher } from '@/hooks/chat/use-reasoning-effort';

export function ReasoningEffortMenu({ a, b }: Props): JSX.Element {
  useEffortAvailabilityPublisher(a);
  useEffortAvailabilityPublisher(b);
  return <div />;
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: CALL_SITE, line: 6 });
    });

    it('flags a call made through an import alias', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useEffortAvailabilityPublisher as publishEffort } from '@/hooks/chat/use-reasoning-effort';

export function usePromptBudget(dimension: unknown): void {
  publishEffort(dimension);
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 5 });
    });

    it('leaves test files alone, so the multi-instance regression test can render two publishers', () => {
      const violations = rule.check(
        projectWith({
          'apps/web/src/hooks/chat/use-reasoning-effort.test.tsx': `
import { useEffortAvailabilityPublisher } from './use-reasoning-effort';

function TwoPublishers(): JSX.Element {
  useEffortAvailabilityPublisher(a);
  useEffortAvailabilityPublisher(b);
  return <div />;
}
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('flags the publisher being called from nowhere', () => {
      const violations = rule.check(
        projectOf({ [PUBLISHER_MODULE]: PUBLISHER_SOURCE, [STORE_MODULE]: STORE_SOURCE })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: PUBLISHER_MODULE });
      expect(violations[0]?.message).toContain('called from nowhere');
    });
  });

  describe('the writer clause', () => {
    it('flags a surface that names the store setter directly', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

export function usePromptBudget(choices: unknown): void {
  const publish = useReasoningEffortStore((state) => state.setEnabledEffortChoices);
  publish(choices);
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 5 });
      expect(violations[0]?.message).toContain('enabledEffortChoices');
    });

    it('flags a setState write of the graded field', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

export function publishFrom(choices: unknown): void {
  useReasoningEffortStore.setState({ enabledEffortChoices: choices });
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 5 });
    });

    it('flags a setter obtained by destructuring the store', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

export function usePromptBudget(choices: unknown): void {
  const { setEnabledEffortChoices } = useReasoningEffortStore.getState();
  setEnabledEffortChoices(choices);
}
`,
        })
      );

      expect(violations.map((violation) => violation.line)).toEqual([5, 6]);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE });
      expect(violations[0]?.message).toContain('enabledEffortChoices');
    });

    it('flags a destructured setter renamed at the binding', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

export function usePromptBudget(choices: unknown): void {
  const { setEnabledEffortChoices: publish } = useReasoningEffortStore();
  publish(choices);
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 5 });
    });

    it('flags a setter taken by an assignment-pattern destructure', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

export function usePromptBudget(choices: unknown): void {
  let publish;
  ({ setEnabledEffortChoices: publish } = useReasoningEffortStore.getState());
  publish(choices);
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 6 });
    });

    it('flags a setter taken by a shorthand assignment-pattern destructure', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

let setEnabledEffortChoices;

export function usePromptBudget(choices: unknown): void {
  ({ setEnabledEffortChoices } = useReasoningEffortStore.getState());
  setEnabledEffortChoices(choices);
}
`,
        })
      );

      expect(violations.map((violation) => violation.line)).toEqual([4, 7, 8]);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE });
    });

    it('flags the setter reached by element access rather than property access', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function publishFrom(state: Record<string, unknown>, choices: unknown): void {
  state['setEnabledEffortChoices'](choices);
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 3 });
    });

    it('flags the setter spelled as a template literal in an element access', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function publishFrom(state: Record<string, unknown>, choices: unknown): void {
  state[\`setEnabledEffortChoices\`](choices);
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 3 });
    });

    it('flags the graded field written under a shorthand property', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function patchFor(enabledEffortChoices: unknown): unknown {
  return { enabledEffortChoices };
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 3 });
    });

    it('flags the graded field written under a computed literal key', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function patchFor(choices: unknown): unknown {
  return { ['enabledEffortChoices']: choices };
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 3 });
    });

    it('flags the graded field written under a quoted key', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function patchFor(choices: unknown): unknown {
  return { 'enabledEffortChoices': choices };
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 3 });
    });

    it('flags the graded field written under a computed template-literal key', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function patchFor(choices: unknown): unknown {
  return { [\`enabledEffortChoices\`]: choices };
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 3 });
    });

    it('leaves a computed key built from a variable alone — the name is not in the source', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function patchFor(key: string, choices: unknown): unknown {
  return { [key]: choices };
}
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('flags a write through the store generic setState whatever the payload is', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

export function publishFrom(patch: Record<string, unknown>): void {
  useReasoningEffortStore.setState(patch);
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 5 });
    });

    it('leaves setState alone in a file that never names the effort store', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useOtherStore } from '@/stores/other';

export function publishFrom(patch: Record<string, unknown>): void {
  useOtherStore.setState(patch);
}
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('leaves a destructured read of the graded field alone', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

export function useEnabled(): unknown {
  const { enabledEffortChoices } = useReasoningEffortStore();
  return enabledEffortChoices;
}
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('leaves a plain read of the graded field alone', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

export function useEnabled(): unknown {
  return useReasoningEffortStore((state) => state.enabledEffortChoices);
}
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('leaves an assignment-pattern read of the graded field alone', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

let enabledEffortChoices;

export function readEnabled(): unknown {
  ({ enabledEffortChoices } = useReasoningEffortStore.getState());
  return enabledEffortChoices;
}
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('leaves an assignment-pattern read that renames the graded field alone', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

let enabled;

export function readEnabled(): unknown {
  ({ enabledEffortChoices: enabled } = useReasoningEffortStore.getState());
  return enabled;
}
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('leaves a for-of destructuring read of the graded field alone', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
let enabledEffortChoices;

export function lastEnabled(snapshots: readonly unknown[]): unknown {
  for ({ enabledEffortChoices } of snapshots) continue;
  return enabledEffortChoices;
}
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('leaves a nested assignment-pattern read of the graded field alone', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
import { useReasoningEffortStore } from '@/stores/reasoning-effort';

let enabledEffortChoices;

export function readEnabled(): unknown {
  ({ inner: { enabledEffortChoices } } = useReasoningEffortStore.getState());
  return enabledEffortChoices;
}
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('flags the graded field in a default value inside a destructuring pattern', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
let patch;

export function patchFor(options: unknown, choices: unknown): unknown {
  ({ patch = { enabledEffortChoices: choices } } = options);
  return patch;
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 5 });
    });

    it('flags the graded field in an object literal assigned to a variable', () => {
      const violations = rule.check(
        projectWith({
          [ELSEWHERE]: `
export function patchFor(choices: unknown): unknown {
  let patch;
  patch = { enabledEffortChoices: choices };
  return patch;
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: ELSEWHERE, line: 4 });
    });

    it('flags a second publisher declared inside the publisher module itself', () => {
      const violations = rule.check(
        projectWith({
          [PUBLISHER_MODULE]: `${PUBLISHER_SOURCE}
export function useSecondEffortPublisher(dimension: unknown): void {
  const publish = useReasoningEffortStore((state) => state.setEnabledEffortChoices);
  React.useEffect(() => {
    publish(gradeOf(dimension));
  }, [dimension, publish]);
}
`,
          'apps/web/src/components/chat/other-surface.tsx': `
import { useSecondEffortPublisher } from '@/hooks/chat/use-reasoning-effort';

export function OtherSurface({ dimension }: Props): JSX.Element {
  useSecondEffortPublisher(dimension);
  return <div />;
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: PUBLISHER_MODULE });
      expect(violations[0]?.message).toContain('useEffortAvailabilityPublisher');
    });

    it('flags a setState write declared inside the publisher module itself', () => {
      const violations = rule.check(
        projectWith({
          [PUBLISHER_MODULE]: `${PUBLISHER_SOURCE}
export function publishFrom(patch: Record<string, unknown>): void {
  useReasoningEffortStore.setState(patch);
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: PUBLISHER_MODULE });
    });

    it('leaves the publisher module reading the graded field beside its publisher', () => {
      const violations = rule.check(
        projectWith({
          [PUBLISHER_MODULE]: `${PUBLISHER_SOURCE}
export function useReasoningEffort(): unknown {
  const enabledEffortChoices = useReasoningEffortStore(
    (state) => state.enabledEffortChoices
  );
  return { enabledEffortChoices };
}
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('flags a second publisher declared inside the store module itself', () => {
      const violations = rule.check(
        projectWith({
          [STORE_MODULE]: `${STORE_SOURCE}
export function publishEffortAvailability(choices: readonly string[]): void {
  const { setEnabledEffortChoices } = useReasoningEffortStore.getState();
  setEnabledEffortChoices(choices);
}
`,
          'apps/web/src/components/chat/other-surface.tsx': `
import { publishEffortAvailability } from '@/stores/reasoning-effort';

export function OtherSurface({ choices }: Props): JSX.Element {
  publishEffortAvailability(choices);
  return <div />;
}
`,
        })
      );

      expect(violations.map((violation) => violation.line)).toEqual([15, 16]);
      expect(violations[0]).toMatchObject({ file: STORE_MODULE });
      expect(violations[0]?.message).toContain('enabledEffortChoices');
    });

    it('flags a setState write declared inside the store module itself', () => {
      const violations = rule.check(
        projectWith({
          [STORE_MODULE]: `${STORE_SOURCE}
export function publishFrom(patch: Record<string, unknown>): void {
  useReasoningEffortStore.setState(patch);
}
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: STORE_MODULE, line: 15 });
    });

    it('leaves the store module alone when its state type is a type alias', () => {
      const violations = rule.check(
        projectWith({
          [STORE_MODULE]: `
type ReasoningEffortState = {
  enabledEffortChoices: readonly string[] | undefined;
  setEnabledEffortChoices: (choices: readonly string[] | undefined) => void;
};

export const useReasoningEffortStore = create<ReasoningEffortState>()(
  persist((set) => ({
    enabledEffortChoices: undefined,
    setEnabledEffortChoices: (choices) => set({ enabledEffortChoices: choices }),
  }))
);
`,
        })
      );

      expect(violations).toEqual([]);
    });

    it('flags the store module when the store export has moved out from under the rule', () => {
      const violations = rule.check(
        projectWith({
          [STORE_MODULE]: `
export const useEffortStore = create(
  persist((set) => ({
    enabledEffortChoices: undefined,
    setEnabledEffortChoices: (choices) => set({ enabledEffortChoices: choices }),
  }))
);
`,
        })
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: STORE_MODULE, line: 5 });
    });

    it('leaves the store module reading the graded field beside its declaration', () => {
      const violations = rule.check(
        projectWith({
          [STORE_MODULE]: `${STORE_SOURCE}
export function enabledNow(): readonly string[] | undefined {
  return useReasoningEffortStore.getState().enabledEffortChoices;
}
`,
        })
      );

      expect(violations).toEqual([]);
    });
  });

  describe('the rule fails loudly rather than narrowing in silence', () => {
    it('throws when the publisher module has left the scanned tree', () => {
      expect(() => rule.check(projectOf({ [STORE_MODULE]: STORE_SOURCE }))).toThrow(
        /is not in the scanned tree/
      );
    });

    it('throws when the publisher export is no longer declared there', () => {
      expect(() =>
        rule.check(
          projectOf({
            [PUBLISHER_MODULE]: 'export function useSomethingElse(): void {}',
            [STORE_MODULE]: STORE_SOURCE,
          })
        )
      ).toThrow(/no longer declared/);
    });
  });
});
