/**
 * Derives one endpoint case per band in a privacy rule's pattern, by parsing the
 * pattern rather than by anyone writing the samples down.
 *
 * Test support only. It sits beside the shared day-boundary predicate rather
 * than inside it because that module is on the pre-commit hook's runtime path:
 * a generator living there could import neither the rule sets it derives from
 * nor the shared test-time module, since the import-cycle rule is an error and
 * the second import would pull the test runner onto the hook path.
 *
 * A hand-written fixture set is what this replaces. Fixtures lag the rules by
 * construction — a band added to a pattern produces no new fixture and no
 * failure — so the evidence has to be derived from the pattern and screened for
 * completeness against it.
 */
import { createHash } from 'node:crypto';

import { RegExpParser } from '@eslint-community/regexpp';
import type { AST } from '@eslint-community/regexpp';

/** What a band is: a point in a pattern where the generated text can differ. */
type BandKind = 'class' | 'set' | 'alt' | 'quant' | 'guard';

/** How a walk resolves one band. */
type Selection =
  | { readonly at: 'text'; readonly text: string }
  | { readonly at: 'branch'; readonly index: number }
  | { readonly at: 'reps'; readonly count: number };

export const fillText = (text: string): Selection => ({ at: 'text', text });
export const fillBranch = (index: number): Selection => ({ at: 'branch', index });
export const fillReps = (count: number): Selection => ({ at: 'reps', count });

/**
 * Which side of the band an outside value sits on: `below` is one step short of
 * the band's low end — one repetition fewer, one code point lower — and `above`
 * is one step past its high end. The two are worth telling apart because a
 * pattern routinely absorbs one and refuses the other, and an exemption written
 * for the whole band throws away the direction that still discriminates.
 */
type OutsideDirection = 'below' | 'above';

interface BandVariant {
  /** Names the endpoint, never the sample: a sample is a real disclosing value. */
  readonly label: string;
  readonly selection: Selection;
  /** One step outside the band, where the band has a derivable outside. */
  readonly outside?: Selection;
  readonly direction?: OutsideDirection;
}

interface Band {
  readonly key: string;
  readonly kind: BandKind;
  readonly variants: readonly BandVariant[];
  /** Set when the band is declared exempt rather than covered by cases. */
  readonly exemptReason?: string;
}

/**
 * One row per band. A bare key is the ordinary row: the band is covered by
 * generated cases read through the consumer's whole gate. The optional fields
 * are the declared semantics — the part no pattern can supply.
 */
export interface BandDeclaration {
  readonly key: string;
  /** Representative value for this band while a different band is under test. */
  readonly fill?: Selection;
  /** No case at all, and why. Reviewed as a statement about the band. */
  readonly exempt?: string;
  /**
   * The pattern reaches this endpoint but the whole gate stays silent there by
   * design — a carve-out or a bound that lives in the classifier rather than in
   * the pattern. The case is asserted against the pattern alone, and the reason
   * names what intercepts it.
   */
  readonly patternOnly?: string;
  /**
   * Per direction, because a pattern that absorbs a value one step past a band's
   * high end usually still refuses one a step short of its low end. Declaring
   * the whole band exempt discards the direction that still discriminates, so
   * each side is declared on its own with the reason that side is absorbed.
   */
  readonly outsideExempt?: Readonly<Partial<Record<OutsideDirection, string>>>;
}

export interface BandSubject {
  /** Names the rule or pass these bands belong to. */
  readonly scope: string;
  readonly pattern: RegExp;
  /** Every band the pattern is declared to have. Screened in both directions. */
  readonly bands: readonly (string | BandDeclaration)[];
  /** Surrounding text a rule needs before a sample can be read at all. */
  readonly context?: (sample: string) => string;
}

function declarationsOf(subject: BandSubject): Map<string, BandDeclaration> {
  return new Map(
    subject.bands.map((entry) => {
      const declaration = typeof entry === 'string' ? { key: entry } : entry;
      return [declaration.key, declaration];
    })
  );
}

const PARSER = new RegExpParser();

interface Discovered {
  readonly key: string;
  readonly kind: BandKind;
  readonly node: AST.Node;
  /**
   * The pattern matches without this band, so no value here can silence it —
   * an outside case would assert a silence the pattern never had.
   */
  readonly skippable: boolean;
}

function isGroupLike(node: AST.Node): node is AST.Pattern | AST.Group | AST.CapturingGroup {
  return node.type === 'Pattern' || node.type === 'Group' || node.type === 'CapturingGroup';
}

/** An anchor bounds the whole match rather than a value inside it. */
function isAnchor(node: AST.Assertion): boolean {
  return node.kind === 'start' || node.kind === 'end';
}

const ELEMENT_KINDS: Partial<Record<AST.Node['type'], BandKind>> = {
  CharacterClass: 'class',
  CharacterSet: 'set',
  Quantifier: 'quant',
};

function isChoicePoint(node: AST.Node): BandKind | undefined {
  const element = ELEMENT_KINDS[node.type];
  if (element !== undefined) return element;
  if (node.type === 'Assertion') return isAnchor(node) ? undefined : 'guard';
  if (isGroupLike(node)) return node.alternatives.length > 1 ? 'alt' : undefined;
  return undefined;
}

/**
 * Children in source order. Only the shapes these rule sets actually use are
 * walked; anything else throws rather than being silently skipped, because a
 * construct this walker does not understand is a band it would report as absent.
 */
const CHILDLESS = new Set<AST.Node['type']>(['CharacterClass', 'CharacterSet', 'Character']);

function childrenOf(node: AST.Node): readonly AST.Node[] {
  if (isGroupLike(node)) return node.alternatives;
  if (node.type === 'Alternative') return node.elements;
  if (node.type === 'Quantifier') return [node.element];
  // An assertion is a leaf to every walk here: an anchor is not a band at all,
  // and a lookaround is one band rather than a sub-tree of them, so nothing
  // inside either is ever a target or an ancestor of one.
  if (node.type === 'Assertion') return [];
  if (CHILDLESS.has(node.type)) return [];
  throw new Error(`privacy band generator: unsupported pattern construct ${node.type}`);
}

function rawKeyOf(node: AST.Node, kind: BandKind): string {
  const raw = node.type === 'Quantifier' ? node.raw.slice(node.element.raw.length) : node.raw;
  return `${kind}:${raw}`;
}

/**
 * A lookaround is one band rather than a sub-tree of them, because this walk
 * renders a zero-width assertion as empty text and so has no sample to put at
 * the edge of anything inside it. That is a limit of this generator and not of
 * the guard: a value at a guard's edge does silence the rule. `summarize`
 * counts what is inside, so the omission is a number rather than a silence.
 */
function discover(
  node: AST.Node,
  found: Discovered[],
  counts: Map<string, number>,
  skippable: boolean
): void {
  const kind = isChoicePoint(node);
  const optional = skippable || (node.type === 'Quantifier' && node.min === 0);
  if (kind !== undefined) {
    const base = rawKeyOf(node, kind);
    const ordinal = (counts.get(base) ?? 0) + 1;
    counts.set(base, ordinal);
    found.push({ key: `${base}#${String(ordinal)}`, kind, node, skippable: optional });
    if (kind === 'guard') return;
  }
  for (const child of childrenOf(node)) discover(child, found, counts, optional);
}

function parse(pattern: RegExp): AST.Pattern {
  return PARSER.parsePattern(pattern.source, undefined, undefined, {
    unicode: pattern.flags.includes('u'),
    unicodeSets: pattern.flags.includes('v'),
  });
}

function discoverAll(pattern: RegExp): Discovered[] {
  const found: Discovered[] = [];
  discover(parse(pattern), found, new Map(), false);
  return found;
}

/** An inclusive code-point band, the unit an endpoint case is generated from. */
interface SubBand {
  readonly label: string;
  readonly lo: number;
  readonly hi: number;
}

/**
 * What each escape set spans, written as bands rather than as a member list so
 * an endpoint case lands on the edge of the set the engine actually implements.
 * A negated set has no derivable endpoint and is left empty on purpose: the
 * completeness screen then demands a declaration rather than passing silently.
 */
const ESCAPE_BANDS: Readonly<Record<string, readonly SubBand[]>> = {
  digit: [{ label: 'digits', lo: 0x30, hi: 0x39 }],
  word: [
    { label: 'digits', lo: 0x30, hi: 0x39 },
    { label: 'upper', lo: 0x41, hi: 0x5a },
    { label: 'underscore', lo: 0x5f, hi: 0x5f },
    { label: 'lower', lo: 0x61, hi: 0x7a },
  ],
  space: [
    { label: 'tab', lo: 0x09, hi: 0x09 },
    { label: 'space', lo: 0x20, hi: 0x20 },
  ],
  any: [{ label: 'any', lo: 0x61, hi: 0x61 }],
};

function setBands(node: AST.CharacterSet): readonly SubBand[] {
  if (node.kind === 'property') return [];
  if (node.kind === 'any') return ESCAPE_BANDS['any'] ?? [];
  if (node.negate) return [];
  return ESCAPE_BANDS[node.kind] ?? [];
}

function classBands(node: AST.CharacterClass): readonly SubBand[] {
  if (node.negate) return [];
  return node.elements.flatMap((element): readonly SubBand[] => {
    if (element.type === 'Character') {
      return [{ label: `member ${element.raw}`, lo: element.value, hi: element.value }];
    }
    if (element.type === 'CharacterClassRange') {
      return [{ label: `range ${element.raw}`, lo: element.min.value, hi: element.max.value }];
    }
    if (element.type === 'CharacterSet') {
      return setBands(element).map((band) => ({ ...band, label: `${element.raw} ${band.label}` }));
    }
    throw new Error(`privacy band generator: unsupported class element ${element.type}`);
  });
}

/**
 * Whether the node itself matches a candidate, asked of the engine rather than
 * re-derived. A hand-written membership test is a second implementation of
 * character-class semantics, and the outside case is only evidence if the value
 * it uses really sits outside.
 */
function admits(node: AST.Node, flags: string, candidate: string): boolean {
  return new RegExp(`^(?:${node.raw})$`, flags.replaceAll(/[gy]/gu, '')).test(candidate);
}

function outsideOf(node: AST.Node, flags: string, codePoint: number): Selection | undefined {
  if (codePoint < 0 || codePoint > 0x10_ff_ff) return undefined;
  const candidate = String.fromCodePoint(codePoint);
  return admits(node, flags, candidate) ? undefined : fillText(candidate);
}

function bandVariants(node: AST.Node, flags: string, bands: readonly SubBand[]): BandVariant[] {
  return bands.flatMap((band): BandVariant[] => {
    if (band.lo === band.hi) {
      return [{ label: band.label, selection: fillText(String.fromCodePoint(band.lo)) }];
    }
    const edge = (label: string, codePoint: number, direction: OutsideDirection): BandVariant => {
      const outside = outsideOf(node, flags, codePoint + (direction === 'below' ? -1 : 1));
      return {
        label,
        selection: fillText(String.fromCodePoint(codePoint)),
        ...(outside === undefined ? {} : { outside, direction }),
      };
    };
    return [
      edge(`${band.label} low`, band.lo, 'below'),
      edge(`${band.label} high`, band.hi, 'above'),
    ];
  });
}

function alternationVariants(node: AST.Pattern | AST.Group | AST.CapturingGroup): BandVariant[] {
  return node.alternatives.map((_alternative, index) => ({
    label: `branch ${String(index + 1)} of ${String(node.alternatives.length)}`,
    selection: fillBranch(index),
  }));
}

/**
 * Both range bounds at their exact values. An unbounded maximum contributes no
 * variant, because there is no exact value to sit on — the completeness screen
 * is what makes that visible rather than silent.
 */
function quantifierVariants(node: AST.Quantifier): BandVariant[] {
  const low: BandVariant = {
    label: `min ${String(node.min)} reps`,
    selection: fillReps(node.min),
    ...(node.min > 0 ? { outside: fillReps(node.min - 1), direction: 'below' as const } : {}),
  };
  if (!Number.isFinite(node.max)) return [low];
  return [
    low,
    {
      label: `max ${String(node.max)} reps`,
      selection: fillReps(node.max),
      outside: fillReps(node.max + 1),
      direction: 'above' as const,
    },
  ];
}

/** Dispatched on the node rather than on its kind: the two cannot disagree. */
function variantsOf(node: AST.Node, flags: string): BandVariant[] {
  if (node.type === 'CharacterClass') return bandVariants(node, flags, classBands(node));
  if (node.type === 'CharacterSet') return bandVariants(node, flags, setBands(node));
  if (node.type === 'Quantifier') return quantifierVariants(node);
  if (isGroupLike(node)) return alternationVariants(node);
  return [];
}

function medianOf<T>(items: readonly T[]): T | undefined {
  return items[Math.floor((items.length - 1) / 2)];
}

/**
 * The fill a band takes when it is neither under test nor an ancestor of the
 * band that is: the middle of the band rather than either edge, because both
 * edges of a clock band are exactly where the day-boundary carve-out sits and a
 * sample that lands there is exempt rather than reported.
 */
function defaultFill(node: AST.Node): Selection {
  if (node.type === 'Quantifier') return fillReps(node.min);
  if (isGroupLike(node)) return fillBranch(Math.floor((node.alternatives.length - 1) / 2));
  if (node.type !== 'CharacterClass' && node.type !== 'CharacterSet') {
    throw new Error(`privacy band generator: no fill for ${node.type}`);
  }
  const band = medianOf(node.type === 'CharacterClass' ? classBands(node) : setBands(node));
  return band === undefined
    ? fillText('')
    : fillText(String.fromCodePoint(Math.floor((band.lo + band.hi) / 2)));
}

interface RenderContext {
  readonly fills: ReadonlyMap<string, BandDeclaration>;
  readonly target?: { readonly node: AST.Node; readonly selection: Selection } | undefined;
  readonly ancestors: ReadonlySet<AST.Node>;
  readonly keys: ReadonlyMap<AST.Node, string>;
}

function repeat(node: AST.Node, count: number, context: RenderContext): string {
  let text = '';
  for (let index = 0; index < count; index++) text += render(node, context);
  return text;
}

function applySelection(node: AST.Node, selection: Selection, context: RenderContext): string {
  if (selection.at === 'text') return selection.text;
  if (selection.at === 'branch') {
    const alternatives = childrenOf(node);
    const chosen = alternatives[selection.index];
    if (chosen === undefined) throw new Error('privacy band generator: branch fill out of range');
    return render(chosen, context);
  }
  if (node.type !== 'Quantifier') {
    throw new Error('privacy band generator: repetition fill on a construct that has none');
  }
  return repeat(node.element, selection.count, context);
}

function descendThrough(node: AST.Node, kind: BandKind, context: RenderContext): string {
  if (kind === 'quant' && node.type === 'Quantifier') {
    return repeat(node.element, Math.max(node.min, 1), context);
  }
  const holding = childrenOf(node).find((child) => holds(child, context.ancestors, context));
  if (holding === undefined) throw new Error('privacy band generator: lost the band under test');
  return render(holding, context);
}

function holds(node: AST.Node, ancestors: ReadonlySet<AST.Node>, context: RenderContext): boolean {
  if (node === context.target?.node || ancestors.has(node)) return true;
  return childrenOf(node).some((child) => holds(child, ancestors, context));
}

function renderBand(node: AST.Node, kind: BandKind, context: RenderContext): string {
  if (kind === 'guard') return '';
  if (node === context.target?.node) {
    return applySelection(node, context.target.selection, context);
  }
  if (context.ancestors.has(node)) return descendThrough(node, kind, context);
  const key = context.keys.get(node);
  const declared = key === undefined ? undefined : context.fills.get(key)?.fill;
  return applySelection(node, declared ?? defaultFill(node), context);
}

function render(node: AST.Node, context: RenderContext): string {
  const kind = isChoicePoint(node);
  if (kind !== undefined) return renderBand(node, kind, context);
  if (node.type === 'Character') return String.fromCodePoint(node.value);
  if (node.type === 'Assertion') return '';
  return childrenOf(node)
    .map((child) => render(child, context))
    .join('');
}

function ancestorsOf(root: AST.Node, target: AST.Node): Set<AST.Node> {
  const found = new Set<AST.Node>();
  const walk = (node: AST.Node): boolean => {
    if (node === target) return true;
    if (childrenOf(node).some((child) => walk(child))) {
      found.add(node);
      return true;
    }
    return false;
  };
  walk(root);
  return found;
}

interface BandCase {
  readonly scope: string;
  readonly key: string;
  readonly label: string;
  readonly edge: 'endpoint' | 'outside';
  /** A real disclosing value by construction. Never name it in an assertion. */
  readonly sample: string;
  readonly expect: 'match' | 'silent';
  /** `full` reads the sample through the consumer's whole gate. */
  readonly oracle: 'full' | 'pattern';
  /** Which side of the band an outside case sits on. Absent on endpoints. */
  readonly direction?: OutsideDirection;
}

interface Prepared {
  readonly root: AST.Pattern;
  readonly found: readonly Discovered[];
  readonly keys: Map<AST.Node, string>;
}

function prepare(subject: BandSubject): Prepared {
  const root = parse(subject.pattern);
  const found: Discovered[] = [];
  discover(root, found, new Map(), false);
  return { root, found, keys: new Map(found.map((item) => [item.node, item.key])) };
}

function renderWith(
  subject: BandSubject,
  prepared: Prepared,
  fills: ReadonlyMap<string, BandDeclaration>,
  target?: { readonly node: AST.Node; readonly selection: Selection }
): string {
  const ancestors =
    target === undefined ? new Set<AST.Node>() : ancestorsOf(prepared.root, target.node);
  const text = render(prepared.root, { fills, target, ancestors, keys: prepared.keys });
  return subject.context === undefined ? text : subject.context(text);
}

/** The sample with every band at its fill: the self-check on the declared fills. */
export function baselineSampleOf(subject: BandSubject): string {
  return renderWith(subject, prepare(subject), declarationsOf(subject));
}

interface BandScreen {
  /** Discovered in the pattern, absent from the declaration. */
  readonly undeclared: readonly string[];
  /** Declared, no longer in the pattern — what a truncated band looks like. */
  readonly stale: readonly string[];
  /** Discovered, yields no case, and claims no exemption. */
  readonly unexplained: readonly string[];
  /** A fill or an exemption aimed at a band the pattern does not have. */
  readonly misdeclared: readonly string[];
}

/** A row that only names a band is a plain declaration; anything more is aimed at one. */
function carriesSemantics(declaration: BandDeclaration): boolean {
  return (
    declaration.fill !== undefined ||
    declaration.exempt !== undefined ||
    declaration.patternOnly !== undefined ||
    declaration.outsideExempt !== undefined
  );
}

export function screenSubject(subject: BandSubject): BandScreen {
  const bands = bandsOf(subject);
  const discovered = new Set(bands.map((band) => band.key));
  const declarations = declarationsOf(subject);
  return {
    undeclared: bands.filter((band) => !declarations.has(band.key)).map((band) => band.key),
    stale: [...declarations.keys()].filter((key) => !discovered.has(key)),
    unexplained: bands
      .filter((band) => band.variants.length === 0 && band.exemptReason === undefined)
      .map((band) => band.key),
    misdeclared: [...declarations.values()]
      .filter((declaration) => carriesSemantics(declaration) && !discovered.has(declaration.key))
      .map((declaration) => declaration.key),
  };
}

interface BandSummary {
  /** Choice points **outside** lookarounds — what the inventory can hold. */
  readonly found: number;
  readonly covered: number;
  readonly exempt: number;
  /**
   * Choice points that live inside a lookaround. The discovery walk stops at a
   * guard, so none of these is in any inventory. Counted rather than left out,
   * because "every band is declared" is only true of the bands outside guards
   * and the difference should be a number rather than a silence.
   */
  readonly insideGuards: number;
}

function isGuardNode(node: AST.Node): boolean {
  return node.type === 'Assertion' && !isAnchor(node);
}

function guardChildren(node: AST.Node): readonly AST.Node[] {
  if (node.type !== 'Assertion') return childrenOf(node);
  if (node.kind === 'lookahead' || node.kind === 'lookbehind') return node.alternatives;
  return [];
}

function countInsideGuards(node: AST.Node, inside: boolean): number {
  const guard = isGuardNode(node);
  const within = inside || guard;
  let total = within && !guard && isChoicePoint(node) !== undefined ? 1 : 0;
  for (const child of guardChildren(node)) total += countInsideGuards(child, within);
  return total;
}

export function summarize(subject: BandSubject): BandSummary {
  const bands = bandsOf(subject);
  const exempt = bands.filter((band) => band.exemptReason !== undefined).length;
  return {
    found: bands.length,
    covered: bands.length - exempt,
    exempt,
    insideGuards: countInsideGuards(parse(subject.pattern), false),
  };
}

/** The same counts over a whole consumer, so its exemption budget is visible. */
export function summarizeAll(subjects: readonly BandSubject[]): BandSummary {
  let found = 0;
  let covered = 0;
  let exempt = 0;
  let insideGuards = 0;
  for (const subject of subjects) {
    const totals = summarize(subject);
    found += totals.found;
    covered += totals.covered;
    exempt += totals.exempt;
    insideGuards += totals.insideGuards;
  }
  return { found, covered, exempt, insideGuards };
}

export function casesFor(subject: BandSubject): BandCase[] {
  const prepared = prepare(subject);
  const declarations = declarationsOf(subject);
  return prepared.found.flatMap(({ key, node, skippable }) => {
    const declaration = declarations.get(key);
    if (declaration?.exempt !== undefined) return [];
    const oracle = declaration?.patternOnly === undefined ? 'full' : 'pattern';
    return variantsOf(node, subject.pattern.flags).flatMap((variant): BandCase[] => {
      const render = (selection: Selection): string =>
        renderWith(subject, prepared, declarations, { node, selection });
      const endpoint: BandCase = {
        scope: subject.scope,
        key,
        label: variant.label,
        edge: 'endpoint',
        sample: render(variant.selection),
        expect: 'match',
        oracle,
      };
      const { outside, direction } = variant;
      if (outside === undefined || direction === undefined || skippable) return [endpoint];
      if (declaration?.outsideExempt?.[direction] !== undefined) return [endpoint];
      return [
        endpoint,
        { ...endpoint, edge: 'outside', sample: render(outside), expect: 'silent', direction },
      ];
    });
  });
}

export function bandsOf(subject: BandSubject): Band[] {
  const { flags } = subject.pattern;
  const declarations = declarationsOf(subject);
  return discoverAll(subject.pattern).map(({ key, kind, node }) => {
    const exemptReason = declarations.get(key)?.exempt;
    if (exemptReason === undefined) return { key, kind, variants: variantsOf(node, flags) };
    return { key, kind, variants: [], exemptReason };
  });
}

/**
 * The committed form of a generated case set.
 *
 * The derivation alone pins nothing: narrow a band by one step and the
 * generator emits the narrowed band's endpoints, which still match, so the
 * suite stays green. A fixture derived from the value under test cannot detect
 * a change to that value. Recording these rows and asserting the live
 * generation against them is what turns a band change into a failure someone
 * has to acknowledge; the derivation is what keeps a *new* band from being
 * forgotten. The two are complementary and neither works alone.
 *
 * The sample is digested rather than written down, because a sample is a real
 * disclosing value by construction and this repository's own gate scans this
 * file with no exemption. The row names the band, so a mismatch says which band
 * moved without printing what it moved to.
 */
export function caseRows(subject: BandSubject): string[] {
  return casesFor(subject).map((item) => {
    const digest = createHash('sha256').update(item.sample, 'utf8').digest('hex').slice(0, 16);
    return [item.key, item.label, item.edge, item.expect, item.oracle, digest].join(' | ');
  });
}
