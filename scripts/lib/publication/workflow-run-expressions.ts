/**
 * Workflow expressions substituted into shell commands.
 *
 * A `${{ }}` in a `run:` body is pasted in as text before bash parses the
 * command, so bash performs quote removal and backslash escaping on the value:
 * a secret carrying `\n` reaches the command with the escape collapsed. Binding
 * the value to the step's `env:` block and reading `"$VAR"` hands bash the bytes
 * instead. Everything outside a `run:` body — `if:`, `with:`, `env:` itself —
 * never reaches a shell, so only run bodies are scanned.
 *
 * The source is parsed, so a run body is whatever YAML resolves one to be: a
 * step is an item of a sequence held by a `steps` key, and its body is that
 * step's `run` entry, however the entry is written — block or flow mapping,
 * plain or quoted key, plain, quoted, literal or folded scalar. A hit is
 * reported at the source line the expression sits on, which inside a block
 * scalar is a line of the body rather than the `run:` heading it. A source the
 * parser rejects throws rather than reading as clean, because a workflow this
 * cannot read is one GitHub cannot run.
 */

import {
  LineCounter,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Document,
  type ParsedNode,
  type Range,
  type Scalar,
  type YAMLMap,
} from 'yaml';

/** One expression found inside a run body. */
interface RunExpression {
  /** 1-based line number, so it can be printed as `file:line`. */
  readonly line: number;
  /** The offending source line, trimmed. */
  readonly text: string;
}

const EXPRESSION = '${{';

/**
 * `get` answers in the plain node types, and only the parsed ones carry the
 * source range every node a parse produced actually has.
 */
const entryOf = (map: YAMLMap, key: string): ParsedNode | undefined =>
  map.get(key, true) as ParsedNode | undefined;

/** The `run` body of every step, in document order. */
function stepRuns(parsed: Document.Parsed): Scalar.Parsed[] {
  const runs: Scalar.Parsed[] = [];

  visit(parsed, {
    Map(_key, map) {
      const steps = entryOf(map, 'steps');
      if (!isSeq(steps)) return;
      for (const step of steps.items) {
        const run = isMap(step) ? entryOf(step, 'run') : undefined;
        if (isScalar(run)) runs.push(run);
      }
    },
  });

  return runs;
}

/** Where each `${{ ` opens inside one node's source span. */
function expressionOffsets(source: string, [start, end]: Range): number[] {
  const offsets: number[] = [];

  for (
    let at = source.indexOf(EXPRESSION, start);
    at >= 0 && at < end;
    at = source.indexOf(EXPRESSION, at + 1)
  ) {
    offsets.push(at);
  }

  return offsets;
}

/** The whole source line an offset falls on, so a reader sees the command. */
function lineAt(source: string, lines: LineCounter, offset: number): RunExpression {
  const { line, col } = lines.linePos(offset);
  const start = offset - col + 1;
  const end = source.indexOf('\n', start);
  return { line, text: source.slice(start, end === -1 ? source.length : end).trim() };
}

/** Every expression pasted into a `run:` body in one workflow or composite action. */
export function findRunExpressions(text: string): RunExpression[] {
  const lines = new LineCounter();
  const parsed = parseDocument(text, { lineCounter: lines });
  const rejected = parsed.errors[0];
  if (rejected !== undefined) {
    throw new Error(`workflow is not parseable YAML: ${rejected.message}`);
  }

  const found = new Map<number, RunExpression>();
  for (const run of stepRuns(parsed)) {
    for (const offset of expressionOffsets(text, run.range)) {
      const at = lineAt(text, lines, offset);
      found.set(at.line, at);
    }
  }

  return [...found.values()];
}
