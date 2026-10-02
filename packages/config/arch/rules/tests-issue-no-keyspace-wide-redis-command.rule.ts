import { SyntaxKind } from 'ts-morph';
import { isKeyspaceWideCommand } from '../lib/keyspace-commands.js';
import { isTestFile } from '../lib/paths.js';
import { calledMember, receiverTailNamesRedis } from '../lib/redis-calls.js';
import type { SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * A test may not issue a Redis command that addresses the whole keyspace.
 *
 * Concurrent test runs share one logical Redis. The harness scopes each run's
 * keys by prefixing them (`scripts/lib/vitest/redis-scope.ts`), which reaches a
 * command only through its key arguments — so a command that takes no key is
 * outside the scope by construction, and answers a question about every run at
 * once. That failure is silent where every other contended path crashes: the
 * count comes back, the assertion passes, and the number was another run's.
 *
 * Which commands those are is not written down here. {@link isKeyspaceWideCommand}
 * holds a set the server itself derives, and its own test re-derives it from
 * the live command table — so a command nobody thought of is covered.
 *
 * The harness refuses the same commands at runtime, from the same ground. This
 * rule is the earlier and cheaper of the two answers: the author sees it
 * without running anything.
 *
 * Production code is out of scope. `SCAN` in an auditor or a dev reset is the
 * command doing its job, and the harness scopes those walks by their `MATCH`
 * pattern when a test run drives them.
 */

const MESSAGE_HEAD = 'A test may not issue the keyspace-wide Redis command';
const MESSAGE_TAIL =
  '— it takes no key, so the harness cannot scope it to this run, and it reads or destroys ' +
  'every concurrent run. Address a key instead.';

function keyspaceWideCalls(sourceFile: SourceFile): ArchViolation[] {
  const violations: ArchViolation[] = [];
  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const member = calledMember(call);
    if (member === undefined) continue;
    if (!isKeyspaceWideCommand(member.name)) continue;
    if (!receiverTailNamesRedis(member.receiver)) continue;
    violations.push({
      file: sourceFile.getFilePath(),
      line: call.getStartLineNumber(),
      message: `${MESSAGE_HEAD} "${member.name}" ${MESSAGE_TAIL}`,
    });
  }
  return violations;
}

const rule: ArchRule = {
  name: 'tests-issue-no-keyspace-wide-redis-command',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      if (!isTestFile(sourceFile.getFilePath())) continue;
      violations.push(...keyspaceWideCalls(sourceFile));
    }
    return violations;
  },
};

export default rule;
