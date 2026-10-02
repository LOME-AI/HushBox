import { Node, SyntaxKind } from 'ts-morph';
import { failWith, isTestFile, relativePath, sourceFileAt } from '../lib/paths.js';
import type { CallExpression, ObjectLiteralExpression, Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The cron isolate's absence is the one failure nothing inside it can report,
 * so the monitor's expectation of a heartbeat is the alarm. Three ways of
 * silencing that alarm leave every other gate green, and each is a clause here.
 *
 * 1. DELETING THE BRACKET. The scheduled handler opens a check-in before the
 *    monitored schedule's entries run and closes it after they settle. Remove
 *    either half and the monitor stops hearing from a Worker that is otherwise
 *    healthy — a page that quietly never arrives again, which no test asserts
 *    because nothing in the process observes it.
 * 2. SPELLING THE CRONTAB. The monitor is upserted with the schedule it expects
 *    to hear from, and that expression already exists once, in the map wrangler's
 *    triggers mirror. Written a second time in the telemetry tree it becomes a
 *    copy that drifts: the Worker moves to a new cadence and the monitor goes on
 *    expecting the old one.
 * 3. REMEMBERING THE MARGIN. The margin and the maximum runtime are minute
 *    counts chosen against the schedule's period, and a schedule shortened below
 *    either of them leaves a missed pass unreported until after the next pass has
 *    started. The crontab is derived; the two counts relative to it are not, so
 *    they are measured here rather than remembered.
 *
 * WHY THE CHECK-IN IS IDENTIFIED BY ITS HANDLE, NOT ITS NAME. `checkIn` is an
 * ordinary method name and a no-op of that name written beside the real handle
 * satisfies any spelling test while reporting nothing. The clause therefore reads
 * the receiver back to the handler's own runtime seam — the value
 * `createTelemetry` returned off the parameter the factory was handed — so a
 * look-alike bound to any other value is refused.
 *
 * WHY THE GUARD MUST RESOLVE A NAME. One monitor watches one schedule, so the
 * bracket is guarded, and the guard reads the schedule's NAME through the map's
 * own resolver. A guard that compares the incoming expression against a written
 * crontab is the same second copy clause 2 refuses, one file over.
 *
 * WHOSE MODULES EACH CLAUSE STANDS OVER. The capture, the monitor configuration
 * and the abort are claims about what production does, so they read production
 * modules alone — a fixture in a colocated test can no more discharge them than it
 * can upsert a monitor. The crontab clause reads the whole tree, tests included,
 * because a crontab written beside the adapter is the second copy whatever file it
 * sits in. Both sides go through the layer's own `isTestFile`, which is where that
 * distinction has one answer.
 *
 * WHAT THIS DOES NOT REACH. Anything whose shape the clauses do not read — for
 * instance: an aliased import of the cron runner, or a second call to it in the
 * handler (either aborts loudly rather than passing, because the position the
 * bracket is measured against would otherwise be a guess); a guard written as
 * anything but an `if` whose condition resolves the schedule name, such as a
 * ternary, an early return, or a helper answering the same question; a minute count
 * reached through anything but a numeric literal or one file-local binding to one,
 * which is reported as unreadable rather than assumed in bounds; and a crontab that
 * is not one literal — concatenated, interpolated, joined from parts, or written
 * with a named weekday, which the pattern below does not match. The clauses ask
 * where a thing is written, never whether it executes.
 */

const RULE = 'cron-schedule-checks-in';

/** The rule's abort: every anchor below is resolved, because a rule that lost its own subject would report a clean tree forever. */
const fail: (message: string) => never = failWith(RULE);

/** Where the schedules are declared, and the names the map publishes. */
const SCHEDULE_MAP_MODULE = 'apps/api/src/composition/cron-schedules.ts';
const SCHEDULE_MAP = 'CRON_SCHEDULES';
export const SCHEDULE_RESOLVER = 'cronScheduleNameFor';

/** Where the bracket is written, and the names that spell it. */
const CRON_MODULE = 'apps/api/src/scheduled.ts';
const HANDLER_FACTORY = 'createScheduledHandler';
export const TELEMETRY_FACTORY = 'createTelemetry';
const CRON_RUN = 'runCronEntries';
export const CHECK_IN = 'checkIn';
export const OPEN = 'in_progress';
export const CLOSE = 'ok';

/** The tree the monitor is upserted from, and the shape it is upserted with. */
const TELEMETRY_TREE = 'apps/api/src/lib/telemetry/';
export const CAPTURE_CHECK_IN = 'captureCheckIn';
const MONITOR_SLUG_PROPERTY = 'monitorSlug';
const MARGIN_PROPERTY = 'checkinMargin';
const MAX_RUNTIME_PROPERTY = 'maxRuntime';

/**
 * Every name this rule identifies a thing BY, rather than merely mentions.
 *
 * Published as one list because each is read through an equality, and an equality
 * widened by a token — to a name extending it, a name it extends, another case, a
 * trailing digit — goes on reporting nothing while the thing it identified has been
 * renamed out from under it. The colocated test derives a near-miss case per name
 * per widening from this list, so a name added here is covered without a case being
 * written for it, and a name that leaves the list stops being asked about.
 */
export const IDENTIFYING_NAMES = [
  SCHEDULE_RESOLVER,
  TELEMETRY_FACTORY,
  CHECK_IN,
  OPEN,
  CLOSE,
  CAPTURE_CHECK_IN,
] as const;

const MINUTES_PER_DAY = 24 * 60;
const MINUTE_BOUNDS = { min: 0, max: 59 } as const;
const HOUR_BOUNDS = { min: 0, max: 23 } as const;

/** A five-field crontab: five whitespace-separated fields, each opening with a digit or a wildcard. */
const CRONTAB = /^\s*[\d*][\d*/,-]*(?:\s+[\d*][\d*/,-]*){4}\s*$/;

const SPELLED_CRONTAB = `Writes a crontab expression in the telemetry tree. The cadence the monitor expects already exists once, in ${SCHEDULE_MAP} (${SCHEDULE_MAP_MODULE}), which wrangler's triggers mirror; a second spelling here drifts from it in silence, leaving the monitor expecting a schedule the Worker no longer runs. Thread the expression in from the cron composition root instead — this tree may not import the map.`;

const UNAWAITED_RUN = `Runs the cron entries without awaiting them, so the closing check-in cannot be after they settle: the monitor is told the pass succeeded while its entries are still running, and a pass that then dies is reported as healthy.`;

function missingCheckIn(status: string, schedule: string): string {
  return `${HANDLER_FACTORY} does not call ${CHECK_IN}('${status}') on the telemetry handle, guarded by the '${schedule}' schedule and ${status === OPEN ? 'before' : 'after'} the awaited ${CRON_RUN}. The bracket is the only thing that tells the monitor this isolate ran, and the monitor is the only thing that pages when it stops — so a half-written bracket is a page that silently never arrives again.`;
}

function unwatchedSlug(slug: string): string {
  return `Upserts a cron monitor for '${slug}', which names no schedule ${SCHEDULE_MAP} declares. The monitor would expect a cadence nothing fires, so it pages forever or never — and the check-in this rule holds in place would be reported against a monitor nobody watches.`;
}

function unmonitoredCheckIn(): string {
  return `Captures a cron check-in with no monitor config: nothing here declares the schedule the monitor expects, its ${MARGIN_PROPERTY}, or its ${MAX_RUNTIME_PROPERTY}, so the monitor's expectation lives wherever someone last typed it into a dashboard rather than in the repository.`;
}

function unnamedMonitor(): string {
  return `Upserts a cron monitor config naming no ${MONITOR_SLUG_PROPERTY} this rule can read, so the schedule it expects to hear from cannot be identified — and the counts that must stay under that schedule's period have nothing to be held against.`;
}

function unreadableMinutes(property: string): string {
  return `The monitor's ${property} is not a minute count this rule can read — a numeric literal, or one file-local binding to one. It cannot be held under the schedule's period, which is the relation that makes a missed pass report before the next pass starts.`;
}

function marginOverPeriod(
  property: string,
  minutes: number,
  schedule: string,
  period: number
): string {
  return `The monitor's ${property} is ${String(minutes)} minutes and the '${schedule}' schedule fires every ${String(period)}. A pass that is late or hung is then reported no sooner than the next pass begins, so the window the monitor exists to close stays open. Both counts stay strictly under the period.`;
}

/** The name a call spells for its callee, bare or through a member chain. */
function calleeName(call: CallExpression): string | undefined {
  const callee = call.getExpression();
  if (Node.isIdentifier(callee)) return callee.getText();
  if (Node.isPropertyAccessExpression(callee)) return callee.getName();
  return undefined;
}

/** Whether `node` sits lexically inside `region`. */
function isInside(node: Node, region: Node): boolean {
  return (
    node.getSourceFile() === region.getSourceFile() &&
    node.getStart() >= region.getStart() &&
    node.getEnd() <= region.getEnd()
  );
}

/** The scanned file at a repo-relative path, or the rule's abort when it has moved. */
function moduleAt(project: Project, repoPath: string, subject: string): SourceFile {
  const sourceFile = sourceFileAt(project, repoPath);
  if (sourceFile === undefined) {
    fail(
      `'${repoPath}' names no file in the scanned tree, so ${subject} cannot be located. Point this rule at its new home.`
    );
  }
  return sourceFile;
}

/** A string value written where the rule reads one: a literal, or one file-local binding to one. */
function literalStringOf(node: Node | undefined, sourceFile: SourceFile): string | undefined {
  const resolved =
    node !== undefined && Node.isIdentifier(node)
      ? sourceFile.getVariableDeclaration(node.getText())?.getInitializer()
      : node;
  if (resolved === undefined) return undefined;
  return Node.isStringLiteral(resolved) || Node.isNoSubstitutionTemplateLiteral(resolved)
    ? resolved.getLiteralText()
    : undefined;
}

/** A number value written where the rule reads one: a literal, or one file-local binding to one. */
function literalNumberOf(node: Node | undefined, sourceFile: SourceFile): number | undefined {
  const resolved =
    node !== undefined && Node.isIdentifier(node)
      ? sourceFile.getVariableDeclaration(node.getText())?.getInitializer()
      : node;
  return resolved !== undefined && Node.isNumericLiteral(resolved)
    ? resolved.getLiteralValue()
    : undefined;
}

/** The value written against one property of an object literal. */
function propertyValue(objectLiteral: ObjectLiteralExpression, name: string): Node | undefined {
  const property = objectLiteral.getProperty(name);
  return property !== undefined && Node.isPropertyAssignment(property)
    ? property.getInitializer()
    : undefined;
}

/** A written whole number, the only thing a cron field bound may be. */
function isCount(text: string): boolean {
  return /^\d+$/.test(text);
}

/** The bounds one cron field part spans, before its step is applied. */
function boundsOf(
  range: string,
  bounds: { readonly min: number; readonly max: number },
  stepped: boolean,
  crontab: string
): { from: number; to: number } {
  if (range === '*') return { from: bounds.min, to: bounds.max };
  const dash = range.indexOf('-');
  if (dash > 0) {
    const from = range.slice(0, dash);
    const to = range.slice(dash + 1);
    if (!isCount(from) || !isCount(to)) fail(unreadableCrontab(crontab));
    return { from: Number(from), to: Number(to) };
  }
  if (!isCount(range)) fail(unreadableCrontab(crontab));
  return { from: Number(range), to: stepped ? bounds.max : Number(range) };
}

function unreadableCrontab(crontab: string): string {
  return `'${crontab}' is not a five-field crontab this rule can expand, so the period the monitor's margin is held under cannot be derived from it. Either the expression is malformed or it uses a form this rule has never seen; teach the rule the form rather than dropping the check.`;
}

/** Every value one comma-separated part of a cron field selects. */
function expandPart(
  part: string,
  bounds: { readonly min: number; readonly max: number },
  crontab: string
): number[] {
  const slash = part.indexOf('/');
  const stepped = slash !== -1;
  const step = stepped ? Number(part.slice(slash + 1)) : 1;
  if (!Number.isInteger(step) || step < 1) fail(unreadableCrontab(crontab));
  const span = boundsOf(stepped ? part.slice(0, slash) : part, bounds, stepped, crontab);
  // The floor needs no guard: a bound is written as digits, so it is never below zero.
  if (span.to > bounds.max || span.from > span.to) {
    fail(unreadableCrontab(crontab));
  }
  const values: number[] = [];
  for (let value = span.from; value <= span.to; value += step) values.push(value);
  return values;
}

/** Every value one cron field selects. */
function expandField(
  field: string,
  bounds: { readonly min: number; readonly max: number },
  crontab: string
): number[] {
  return field.split(',').flatMap((part) => expandPart(part, bounds, crontab));
}

/**
 * The minutes between two consecutive firings of a crontab, at its closest.
 *
 * Only the minute and hour fields are expanded: a restriction on the day,
 * month or weekday fields only ever pushes firings further apart, so the
 * within-day minimum is a lower bound on the true period and every comparison
 * against it errs toward refusing.
 */
function periodMinutes(crontab: string): number {
  const fields = crontab.trim().split(/\s+/);
  if (fields.length !== 5) fail(unreadableCrontab(crontab));
  // Sliced rather than indexed: an index is `string | undefined` against a
  // length this guard has already fixed, and the arm that would narrow it
  // could never run.
  const minutes = fields.slice(0, 1).flatMap((field) => expandField(field, MINUTE_BOUNDS, crontab));
  const firings = [
    ...new Set(
      fields
        .slice(1, 2)
        .flatMap((field) => expandField(field, HOUR_BOUNDS, crontab))
        .flatMap((hour) => minutes.map((minute) => hour * 60 + minute))
    ),
  ].toSorted((left, right) => left - right);
  // The next day's firings close the cycle, so the wrap-around gap is measured
  // by the same walk as every other one.
  let smallest = MINUTES_PER_DAY;
  let previous: number | undefined;
  for (const firing of [...firings, ...firings.map((value) => value + MINUTES_PER_DAY)]) {
    if (previous !== undefined) smallest = Math.min(smallest, firing - previous);
    previous = firing;
  }
  return smallest;
}

/** The object literal one `const` declaration holds, through an `as const` assertion. */
function declaredObjectLiteral(
  sourceFile: SourceFile,
  name: string
): ObjectLiteralExpression | undefined {
  const declared = sourceFile.getVariableDeclaration(name)?.getInitializer();
  const literal =
    declared !== undefined && Node.isAsExpression(declared) ? declared.getExpression() : declared;
  return literal !== undefined && Node.isObjectLiteralExpression(literal) ? literal : undefined;
}

/** One schedule of the map: the name a branch dispatches on, and the expression it fires under. */
function scheduleEntry(property: Node, sourceFile: SourceFile): [string, string][] {
  if (!Node.isPropertyAssignment(property)) return [];
  const expression = literalStringOf(property.getInitializer(), sourceFile);
  if (expression === undefined) return [];
  const nameNode = property.getNameNode();
  const name = Node.isStringLiteral(nameNode) ? nameNode.getLiteralText() : nameNode.getText();
  return [[name, expression]];
}

/** The schedules the composition root declares, name to expression. */
function scheduleMap(project: Project): ReadonlyMap<string, string> {
  const sourceFile = moduleAt(project, SCHEDULE_MAP_MODULE, `the ${SCHEDULE_MAP} declaration`);
  const literal = declaredObjectLiteral(sourceFile, SCHEDULE_MAP);
  if (literal === undefined) {
    fail(
      `${SCHEDULE_MAP} is no longer an object literal in ${SCHEDULE_MAP_MODULE}, so no schedule's period can be derived and every clause resting on it would pass over nothing. Point this rule at its new shape.`
    );
  }
  const schedules = new Map(
    literal.getProperties().flatMap((property) => scheduleEntry(property, sourceFile))
  );
  if (schedules.size === 0) fail(`${SCHEDULE_MAP} declares no schedule in ${SCHEDULE_MAP_MODULE}.`);
  return schedules;
}

/** One monitor as the telemetry tree upserts it: the schedule it watches, and the counts it watches with. */
interface Monitor {
  readonly file: string;
  readonly line: number;
  readonly slug: string | undefined;
  readonly counts: readonly { readonly property: string; readonly minutes: number | undefined }[];
}

/** True for the object literal Sentry reads a monitor's schedule off. */
function isMonitorConfig(objectLiteral: ObjectLiteralExpression): boolean {
  return (
    objectLiteral.getProperty(MARGIN_PROPERTY) !== undefined &&
    objectLiteral.getProperty(MAX_RUNTIME_PROPERTY) !== undefined
  );
}

/** The monitor configs one check-in capture carries, however they are branched around. */
function monitorConfigsIn(call: CallExpression): ObjectLiteralExpression[] {
  return call
    .getArguments()
    .slice(1)
    .flatMap((argument) => [
      ...(Node.isObjectLiteralExpression(argument) ? [argument] : []),
      ...argument.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression),
    ])
    .filter((objectLiteral) => isMonitorConfig(objectLiteral));
}

/** The slug a check-in capture names, read off the payload it opens with. */
function slugOf(call: CallExpression, sourceFile: SourceFile): string | undefined {
  return call
    .getArguments()
    .slice(0, 1)
    .flatMap((payload) => (Node.isObjectLiteralExpression(payload) ? [payload] : []))
    .map((payload) => literalStringOf(propertyValue(payload, MONITOR_SLUG_PROPERTY), sourceFile))
    .at(0);
}

/** Every module of the telemetry tree, a colocated test as much as its subject. */
function telemetryModules(project: Project): SourceFile[] {
  return project
    .getSourceFiles()
    .filter((sourceFile) => relativePath(sourceFile).includes(TELEMETRY_TREE));
}

/**
 * The telemetry modules that run in production.
 *
 * A capture, a monitor configuration and the abort are claims about what the
 * deployed Worker does, and a fixture in a colocated test discharges none of them:
 * read the tree whole and a monitor config written in a test file answers for the
 * adapter that no longer carries one.
 */
function productionTelemetryModules(project: Project): SourceFile[] {
  return telemetryModules(project).filter((sourceFile) => !isTestFile(relativePath(sourceFile)));
}

/** Every cron check-in one telemetry module captures. */
function checkInCaptures(sourceFile: SourceFile): CallExpression[] {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => calleeName(call) === CAPTURE_CHECK_IN);
}

/** The monitors one check-in capture upserts. */
function monitorsAt(call: CallExpression, sourceFile: SourceFile): Monitor[] {
  return monitorConfigsIn(call).map((config) => ({
    file: relativePath(sourceFile),
    line: config.getStartLineNumber(),
    slug: slugOf(call, sourceFile),
    counts: [MARGIN_PROPERTY, MAX_RUNTIME_PROPERTY].map((property) => ({
      property,
      minutes: literalNumberOf(propertyValue(config, property), sourceFile),
    })),
  }));
}

/** Every cron check-in the telemetry tree captures, and every monitor it upserts. */
function monitorsIn(project: Project): { captures: CallExpression[]; monitors: Monitor[] } {
  const captures: CallExpression[] = [];
  const monitors: Monitor[] = [];
  for (const sourceFile of productionTelemetryModules(project)) {
    for (const call of checkInCaptures(sourceFile)) {
      captures.push(call);
      monitors.push(...monitorsAt(call, sourceFile));
    }
  }
  return { captures, monitors };
}

/** Every crontab the telemetry tree spells out instead of deriving. */
function spelledCrontabViolations(sourceFile: SourceFile): ArchViolation[] {
  return [
    ...sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral),
    ...sourceFile.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral),
  ]
    .filter((literal) => CRONTAB.test(literal.getLiteralText()))
    .map((literal) => ({
      file: relativePath(sourceFile),
      line: literal.getStartLineNumber(),
      message: SPELLED_CRONTAB,
    }));
}

/** One monitor held against the period of the schedule it watches. */
function monitorViolations(
  monitor: Monitor,
  schedules: ReadonlyMap<string, string>
): ArchViolation[] {
  const { slug } = monitor;
  const crontab = slug === undefined ? undefined : schedules.get(slug);
  if (slug === undefined || crontab === undefined) {
    return [
      {
        file: monitor.file,
        line: monitor.line,
        message: slug === undefined ? unnamedMonitor() : unwatchedSlug(slug),
      },
    ];
  }
  const period = periodMinutes(crontab);
  return monitor.counts.flatMap(({ property, minutes }) => {
    if (minutes === undefined) {
      return [{ file: monitor.file, line: monitor.line, message: unreadableMinutes(property) }];
    }
    return minutes < period
      ? []
      : [
          {
            file: monitor.file,
            line: monitor.line,
            message: marginOverPeriod(property, minutes, slug, period),
          },
        ];
  });
}

/** The names the handler binds the runtime's telemetry to — the one receiver a real check-in can sit on. */
function telemetryHandles(handler: Node, runtimeNames: ReadonlySet<string>): ReadonlySet<string> {
  const handles = new Set<string>();
  for (const declaration of handler.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
    const initializer = declaration.getInitializer();
    if (initializer === undefined || !Node.isCallExpression(initializer)) continue;
    const callee = initializer.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== TELEMETRY_FACTORY)
      continue;
    const receiver = callee.getExpression();
    if (!Node.isIdentifier(receiver) || !runtimeNames.has(receiver.getText())) continue;
    const nameNode = declaration.getNameNode();
    if (Node.isIdentifier(nameNode)) handles.add(nameNode.getText());
  }
  return handles;
}

/** Every `handle.checkIn('<status>')` written inside the handler. */
function checkInCalls(
  handler: Node,
  handles: ReadonlySet<string>,
  status: string
): CallExpression[] {
  return handler.getDescendantsOfKind(SyntaxKind.CallExpression).filter((call) => {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee) || callee.getName() !== CHECK_IN) return false;
    const receiver = callee.getExpression();
    if (!Node.isIdentifier(receiver) || !handles.has(receiver.getText())) return false;
    const [argument] = call.getArguments();
    return (
      argument !== undefined &&
      Node.isStringLiteral(argument) &&
      argument.getLiteralText() === status
    );
  });
}

/** True for an expression that answers "is this pass the monitored schedule's", through the map's own resolver. */
function namesSchedule(
  expression: Node,
  handler: Node,
  schedule: string,
  sourceFile: SourceFile
): boolean {
  const resolved = Node.isIdentifier(expression)
    ? handler
        .getDescendantsOfKind(SyntaxKind.VariableDeclaration)
        .find((declaration) => declaration.getName() === expression.getText())
        ?.getInitializer()
    : expression;
  if (resolved === undefined || !Node.isBinaryExpression(resolved)) return false;
  if (resolved.getOperatorToken().getKind() !== SyntaxKind.EqualsEqualsEqualsToken) return false;
  const left = resolved.getLeft();
  const right = resolved.getRight();
  const resolves = (node: Node): boolean =>
    Node.isCallExpression(node) && calleeName(node) === SCHEDULE_RESOLVER;
  return (
    (resolves(left) && literalStringOf(right, sourceFile) === schedule) ||
    (resolves(right) && literalStringOf(left, sourceFile) === schedule)
  );
}

/** True when the call sits in the taken branch of a guard on the monitored schedule. */
function guardsSchedule(
  call: CallExpression,
  handler: Node,
  schedule: string,
  sourceFile: SourceFile
): boolean {
  for (let ancestor = call.getParent(); ancestor !== undefined; ancestor = ancestor.getParent()) {
    if (!Node.isIfStatement(ancestor)) continue;
    if (!isInside(call, ancestor.getThenStatement())) continue;
    if (namesSchedule(ancestor.getExpression(), handler, schedule, sourceFile)) return true;
  }
  return false;
}

/** The handler's bracket around the monitored schedule's pass. */
function bracketViolations(project: Project, schedule: string): ArchViolation[] {
  const sourceFile = moduleAt(project, CRON_MODULE, `the ${HANDLER_FACTORY} bracket`);
  const filePath = relativePath(sourceFile);
  const handler = sourceFile.getFunction(HANDLER_FACTORY);
  if (handler === undefined) {
    fail(
      `${HANDLER_FACTORY} is no longer declared in ${CRON_MODULE}, so the check-in bracket cannot be read off it and this clause would pass over nothing. Point this rule at its new name.`
    );
  }
  const [run, ...extraRuns] = handler
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter((call) => calleeName(call) === CRON_RUN);
  if (run === undefined || extraRuns.length > 0) {
    fail(
      `${HANDLER_FACTORY} in ${CRON_MODULE} calls ${CRON_RUN} ${String(run === undefined ? 0 : extraRuns.length + 1)} times, and the bracket is measured against exactly one. Point this rule at the call the check-in brackets.`
    );
  }
  const awaited = run.getParent();
  if (!Node.isAwaitExpression(awaited)) {
    return [{ file: filePath, line: run.getStartLineNumber(), message: UNAWAITED_RUN }];
  }
  const handles = telemetryHandles(
    handler,
    new Set(handler.getParameters().map((parameter) => parameter.getName()))
  );
  return [OPEN, CLOSE].flatMap((status) => {
    const bracketed = checkInCalls(handler, handles, status).filter(
      (call) =>
        guardsSchedule(call, handler, schedule, sourceFile) &&
        (status === OPEN ? call.getEnd() <= run.getStart() : call.getStart() >= awaited.getEnd())
    );
    return bracketed.length > 0
      ? []
      : [
          {
            file: filePath,
            line: handler.getStartLineNumber(),
            message: missingCheckIn(status, schedule),
          },
        ];
  });
}

/** The schedules the monitors watch, less any slug the map does not declare. */
function watchedSchedules(
  monitors: readonly Monitor[],
  schedules: ReadonlyMap<string, string>
): ReadonlySet<string> {
  const watched = new Set<string>();
  for (const { slug } of monitors) {
    if (slug !== undefined && schedules.has(slug)) watched.add(slug);
  }
  return watched;
}

const rule: ArchRule = {
  name: RULE,
  check(project) {
    const schedules = scheduleMap(project);
    const { captures, monitors } = monitorsIn(project);
    const firstCapture = captures[0];
    if (firstCapture === undefined) {
      fail(
        `No module under ${TELEMETRY_TREE} calls ${CAPTURE_CHECK_IN}, so nothing tells the cron monitor this Worker is alive and its absence pages nobody. Restore the check-in, or point this rule at whatever replaced it.`
      );
    }
    const violations: ArchViolation[] =
      monitors.length === 0
        ? [
            {
              file: relativePath(firstCapture.getSourceFile()),
              line: firstCapture.getStartLineNumber(),
              message: unmonitoredCheckIn(),
            },
          ]
        : [];
    for (const monitor of monitors) {
      violations.push(...monitorViolations(monitor, schedules));
    }
    for (const schedule of watchedSchedules(monitors, schedules)) {
      violations.push(...bracketViolations(project, schedule));
    }
    for (const sourceFile of telemetryModules(project)) {
      violations.push(...spelledCrontabViolations(sourceFile));
    }
    return violations;
  },
};

export default rule;
