/**
 * Renderer-death recovery in `MainActivity.java`, read as source text. Nothing here
 * executes Java: `android.jar`'s classes throw at call time, so a runtime harness
 * would exercise its own stubs rather than the app, and no pull-request gate
 * compiles this file. A source-text guard reads shape, never meaning, so every
 * property the handler *means* needs its own assertion — which is why a twenty-line
 * method is guarded this densely.
 *
 * **If a change you believe is correct just went red, read this before touching an
 * assertion.** The scoping is deliberately tighter than the code needs, because a
 * false red costs a cycle and a false green costs the feature. Every edit below is
 * correct Java and reddens this suite anyway; the fix is to update the assertion to
 * the new shape, never to loosen it back:
 *
 * - Replacing the anonymous `new WebViewListener() { … }` with a named or inner
 *   class. This reddens a large part of the suite at once, because the handler is
 *   located through the registration.
 * - Extracting the registration, the increment, or the guard's condition into a
 *   helper method — in any position, including a correct call placed before
 *   `super.onCreate`.
 * - Dropping the guard's braces (`if (…) return false;`). The branch scopes are
 *   found by brace matching and need the block.
 * - Rewriting the guard's condition at all: reordering it to
 *   `MAX_RENDERER_RECOVERIES <= rendererRecoveries`, adding a conjunct, or
 *   parenthesising the comparison.
 * - `rendererRecoveries += 1;` in place of `rendererRecoveries++;`.
 * - Adding, removing, reordering, or nesting a statement in either branch — braced
 *   or not, with or without a new `;`, in any construct. The two branches are
 *   pinned to an exact expected shape below; the fix is to update the pin.
 * - A second `onRenderProcessGone` override anywhere in this file, including a
 *   correct one that delegates.
 * - Renaming `addWebViewListener`, `MAX_RENDERER_RECOVERIES` or
 *   `rendererRecoveries`.
 * - A string or character literal holding an escaped quote: {@link COMMENT_OR_LITERAL}
 *   bounds a literal to its own line and does not model escapes, so the match ends
 *   early and the garbled scope reddens.
 * - Declaring a method elsewhere in this file whose name matches an unqualified call
 *   either branch makes — including a call spelled `MainActivity.this.recreate()`,
 *   which resolves the same way as a bare `recreate()` (for example, a second
 *   `recreate()`). Java resolves the branch's call to whichever declaration is
 *   lexically closest, so a same-named method anywhere else in the file silently
 *   replaces what the call actually runs while the branch's own pinned text stays
 *   untouched.
 *
 * And the other direction, so a green run is not read as more than it is. This
 * suite cannot see: whether the Capacitor and Android names are real (every
 * breakage is a javac error, and nothing compiles this on a pull request); which
 * thread Android dispatches the callback on; a user-facing surface added elsewhere
 * in `onCreate` that is neither `Toast` nor `AlertDialog`; whether
 * `AndroidManifest.xml` still launches this Activity; a method that would shadow a
 * pinned call the same way but is declared outside this file — in `WebViewListener`,
 * `BridgeActivity`, or any class this file does not define — which a guard scoped to
 * this file's own text cannot reach either; a call reached through a local variable
 * or field whose static type is the enclosing class (for example
 * `MainActivity self = MainActivity.this; self.recreate();` — `this` alone would name
 * the anonymous listener, not the Activity, and fails to compile there) — the
 * identifier is arbitrary, its declaration need not sit near the call, and deciding
 * its static type is type resolution, which a guard that reads text rather than
 * compiling it cannot do; a deliberate edit exploiting Java's lexical no-ops,
 * accepted rather than closed — a zero-width space (U+200B) or a zero-width
 * non-joiner (U+200C) placed between the class name and `.this`, invisible in the
 * file, is identifier-ignorable to `javac` and genuinely resolves to a same-file
 * override exactly as the plain form does; the same class reaches a `\uXXXX`
 * escape, which Java translates before lexing, so six ordinary characters produce
 * the identical evasion; JavaScript's `\s` does not include either character, so
 * the comment-stripped, whitespace-normalized derivation this file already applies
 * does not collapse either spelling. This guard catches accidental drift — every
 * mutation tried against it across nine fix cycles still reddens — which is what
 * it exists for; it does not withstand a deliberate adversarial edit, and it was
 * never the thing standing between this repository and a malicious commit; and
 * — the one that defeats the recovery bound outright — a `WebViewListener`
 * registered by a Capacitor plugin, whose Java lives in `node_modules` and which no
 * guard over this file's text can reach.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const MAIN_ACTIVITY_PATH = path.join(import.meta.dirname, 'MainActivity.java');
const ON_CREATE_SIGNATURE = 'protected void onCreate(';
const RENDER_PROCESS_GONE_SIGNATURE = 'public boolean onRenderProcessGone(';
const BOUND_GUARD = /if\s*\(([^)]*MAX_RENDERER_RECOVERIES[^)]*)\)/;

/**
 * Comments, and string and character literals, in one left-to-right pass, so that
 * neither can be read out of the other. A literal is bounded to its own line,
 * which Java's own grammar bounds it to as well; an escaped quote inside one
 * would end the match early, and the resulting garbled scope reddens.
 */
const COMMENT_OR_LITERAL = /"[^"\n]*"|'[^'\n]*'|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/**
 * The file as javac reads it: comments dropped, string and character literals
 * emptied. A comment satisfies a `toContain` while meaning nothing to the
 * compiler, so a left-behind `// bridgeBuilder.addWebViewListener(…)` above
 * `super.onCreate`, or a `recreate();` left in a commented-out line, would
 * otherwise hold an assertion here green over code that stopped doing it. The
 * emptied literals are what make {@link blockFrom}'s brace counting sound.
 */
function readMainActivity(): string {
  return readFileSync(MAIN_ACTIVITY_PATH, 'utf8').replaceAll(COMMENT_OR_LITERAL, (match) =>
    match.startsWith('/') ? ' ' : match.charAt(0).repeat(2)
  );
}

/**
 * The balanced `{ … }` block opening at or after `from`, or empty when there is
 * none. Brace counting stands in for a Java parser, which it can do because
 * {@link readMainActivity} empties every string and character literal first: the
 * only braces left are code. A brace that reached the counter from inside a
 * literal would widen every scope below at once rather than fail loudly.
 */
function blockFrom(source: string, from: number): string {
  const open = source.indexOf('{', from);
  if (open === -1) {
    return '';
  }
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') {
      depth += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(open, index + 1);
      }
    }
  }
  return '';
}

/**
 * The brace depth at `index` inside a block {@link blockFrom} returned, whose own
 * opening brace is index 0. A statement of that block's own body sits at depth 1;
 * anything nested in a condition, a loop, or a lambda body sits deeper.
 */
function depthAt(block: string, index: number): number {
  let depth = 0;
  for (let position = 0; position < index; position += 1) {
    if (block[position] === '{') {
      depth += 1;
    } else if (block[position] === '}') {
      depth -= 1;
    }
  }
  return depth;
}

/**
 * The body of onCreate. Ordering claims are scoped to it because textual order is
 * execution order only within one straight-line method body: a registration moved
 * into a helper declared earlier in the file precedes a call it actually runs
 * after.
 */
function readOnCreateBody(): string {
  const source = readMainActivity();
  const start = source.indexOf(ON_CREATE_SIGNATURE);
  return start === -1 ? '' : blockFrom(source, start);
}

/**
 * The anonymous WebViewListener handed to addWebViewListener. Nothing dispatches
 * a renderer-gone callback to anything else, so an override that left this
 * listener — moved onto the Activity, or into a class the listener does not
 * extend — is dead code, and scoping the handler to this block is what keeps it
 * from standing in for the registered one.
 */
function readRegisteredListener(): string {
  const onCreateBody = readOnCreateBody();
  const registration = onCreateBody.indexOf('bridgeBuilder.addWebViewListener(');
  return registration === -1 ? '' : blockFrom(onCreateBody, registration);
}

/**
 * The body of the registered listener's renderer-gone override. Assertions about
 * what the override does are scoped to it, so a matching token elsewhere in the
 * file cannot stand in for the handler itself.
 */
function readRenderProcessGoneHandler(): string {
  const listener = readRegisteredListener();
  const start = listener.indexOf(RENDER_PROCESS_GONE_SIGNATURE);
  return start === -1 ? '' : blockFrom(listener, start);
}

/** The block guarded by the bound: the path taken once recovery is spent. */
function readBoundSpentBranch(): string {
  const handler = readRenderProcessGoneHandler();
  const guard = handler.search(BOUND_GUARD);
  return guard === -1 ? '' : blockFrom(handler, guard);
}

/**
 * The condition of the `if` whose test names the bound. `readBoundSpentBranch`
 * and `readRecoveryPath` find their branch by the constant standing in this
 * condition, never by what the condition means, so the direction of the
 * comparison has to be read here.
 */
function readBoundGuardCondition(): string {
  const match = BOUND_GUARD.exec(readRenderProcessGoneHandler());
  return match?.[1]?.trim() ?? '';
}

/** The handler past that block: the path taken while the bound is unspent. */
function readRecoveryPath(): string {
  const handler = readRenderProcessGoneHandler();
  const spentBranch = readBoundSpentBranch();
  return spentBranch === '' ? '' : handler.slice(handler.indexOf(spentBranch) + spentBranch.length);
}

/**
 * Every run of whitespace collapsed to one space, ends trimmed. `readMainActivity`
 * already empties comments and literals; this is the remaining step that makes a
 * shape comparison read code rather than layout, so a reflow or an indentation
 * change cannot redden {@link EXPECTED_BOUND_SPENT_BRANCH} or
 * {@link EXPECTED_RECOVERY_PATH} — only a change to what a branch contains can.
 */
function normalizeWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/**
 * The name this file's own `class` declaration gives it, read from the source
 * rather than written down — so {@link unqualifiedCallNames}'s enclosing-instance
 * rule tracks a rename of the class itself with no edit here.
 */
function readEnclosingClassName(): string {
  const match = /\bclass\s+([A-Za-z_$][\w$]*)/.exec(readMainActivity());
  return match?.[1] ?? '';
}

/**
 * The Java reserved words that precede `(` without naming a call — `if (`,
 * `while (`, `for (`, `switch (`, `catch (`, `synchronized (` — so a branch that
 * gains one of these is not read as though it called a method by that name.
 */
const JAVA_PAREN_KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'catch', 'synchronized']);

/**
 * The set of unqualified method-call names in `text` — an identifier immediately
 * followed by `(`, not preceded by `.`, and not one of {@link JAVA_PAREN_KEYWORDS}
 * — plus every call reached through `<enclosingClassName>.this.`, which resolves
 * through the same lexical scoping a bare call does and is normalized away before
 * that check runs; every other qualified call resolves through its receiver's own
 * type instead, so it carries none of the risk this exists to catch. `text` is run
 * through {@link normalizeWhitespace} first, the same step the shape pin already
 * relies on, so a comment or a line break sitting inside `<enclosingClassName>.this.`
 * cannot spell a receiver this function fails to recognize — the prefix match tolerates
 * whatever whitespace normalization leaves at each gap in the idiom, rather than
 * requiring the zero-whitespace spelling literally. `enclosingClassName` is a plain
 * argument, never a literal inside this function, so the rule is proven below against
 * a class name unrelated to the real file rather than against the one name this file
 * happens to need protected today; the real call site derives it from the file's own
 * `class` declaration via {@link readEnclosingClassName}, so a rename of that class
 * needs no edit here.
 */
function unqualifiedCallNames(text: string, enclosingClassName: string): string[] {
  const enclosingInstancePrefix = new RegExp(
    String.raw`\b${enclosingClassName}\s*\.\s*this\s*\.\s*`,
    'g'
  );
  const stripped = normalizeWhitespace(text).replaceAll(enclosingInstancePrefix, '');
  const names = new Set<string>();
  for (const match of stripped.matchAll(/(?<!\.)\b([a-zA-Z_$][\w$]*)\s*\(/g)) {
    const name = match[1];
    if (name !== undefined && !JAVA_PAREN_KEYWORDS.has(name)) {
      names.add(name);
    }
  }
  return [...names];
}

/**
 * The bound-spent branch's whole approved shape, not a property of it: the guard
 * having matched already scopes this to the right block, so what is compared here
 * is everything between its braces. A denylist of bad forms is unbounded — this
 * run found two independently-designed one-statement constructs (a `switch`, a
 * receiver-selecting ternary) that spelled none of a keyword list's entries and
 * added no `;`, and a third that defeated both mechanisms outright. A pin has no
 * such frontier: any construct other than this exact one fails by default. Update
 * this constant, deliberately, on every legitimate change to the branch — that
 * cost is accepted, not a defect.
 */
const EXPECTED_BOUND_SPENT_BRANCH = '{ return false; }';

/** {@link EXPECTED_BOUND_SPENT_BRANCH}'s counterpart for the recovery path. */
const EXPECTED_RECOVERY_PATH = 'rendererRecoveries++; recreate(); return true; }';

describe('MainActivity renderer-death handling', () => {
  it('registers a Capacitor WebViewListener', () => {
    const source = readMainActivity();
    expect(source).toContain('import com.getcapacitor.WebViewListener;');
    expect(source).toContain('addWebViewListener(');
  });

  it('registers the listener before super.onCreate builds the bridge', () => {
    // BridgeActivity.onCreate reaches load(), which calls bridgeBuilder…create().
    // A listener added after that call is added to a builder whose bridge already
    // exists, so it is never attached and renderer deaths go unhandled — with every
    // other assertion here still green.
    const onCreateBody = readOnCreateBody();
    const registration = onCreateBody.indexOf('bridgeBuilder.addWebViewListener(');
    const superOnCreate = onCreateBody.indexOf('super.onCreate(');
    expect(registration).toBeGreaterThan(-1);
    expect(superOnCreate).toBeGreaterThan(registration);
  });

  it('registers the listener unconditionally, at the top level of onCreate', () => {
    // Textual position is not reachability. Wrapping the registration in
    // `if (savedInstanceState != null)` keeps it above super.onCreate and skips it
    // on every cold start; handing it to a `new Thread(…)` runs it off the UI
    // thread and after the bridge is built. Either leaves renderer deaths
    // unhandled with every other assertion here green. A registration Java always
    // reaches is a statement of the method body — one brace deep, no deeper.
    const onCreateBody = readOnCreateBody();
    const registration = onCreateBody.indexOf('bridgeBuilder.addWebViewListener(');
    expect(registration).toBeGreaterThan(-1);
    expect(depthAt(onCreateBody, registration)).toBe(1);
  });

  it('overrides the renderer-gone callback on the listener it registers', () => {
    // An override on any other object is never called: addWebViewListener is the
    // only thing that subscribes to a renderer death here.
    expect(readRegisteredListener()).toContain(RENDER_PROCESS_GONE_SIGNATURE);
  });

  it('leaves the renderer-gone answer to a single override', () => {
    // Capacitor ORs the listeners' answers together — `result =
    // listener.onRenderProcessGone(view, detail) || result` — so a second override
    // returning true spares the process whatever the bound just decided, and the
    // assertions here, scoped to the listener registered first, would not see it.
    // A second listener that overrides some other callback is harmless and stays
    // green: the default answer is false, which the OR discards.
    const overrides = readMainActivity().match(/onRenderProcessGone\(/g) ?? [];
    expect(overrides).toHaveLength(1);
  });

  it('claims the renderer-gone event on the path that still has recoveries left', () => {
    const recoveryPath = readRecoveryPath();
    expect(recoveryPath).toContain('return true;');
    expect(recoveryPath).not.toContain('return false;');
  });

  it('recreates the activity, because the WebView left behind is unusable', () => {
    expect(readRenderProcessGoneHandler()).toContain('recreate();');
  });

  it('recovers without any user-facing error surface', () => {
    const source = readMainActivity();
    expect(source).not.toContain('Toast');
    expect(source).not.toContain('AlertDialog');
  });
});

describe('MainActivity renderer-death recovery bound', () => {
  it('bounds recovery with a named constant set to a positive count', () => {
    // How many recoveries is deliberately free; zero is not a choice of bound but
    // the recovery switched off, which the crash-handling this file exists for
    // rules out. The digits stay unconstrained past that.
    expect(readMainActivity()).toMatch(
      /private\s+static\s+final\s+int\s+MAX_RENDERER_RECOVERIES\s*=\s*[1-9]\d*;/
    );
  });

  it('puts no numeric literal in a comparison, so the bound stays the constant', () => {
    // `readBoundGuardCondition` is asserted verbatim elsewhere in this suite,
    // which already requires the constant to stand in the guard. What is left
    // here is the rest of the handler, where a second comparison against a
    // literal would reintroduce the magic number the constant exists to remove.
    expect(readRenderProcessGoneHandler()).not.toMatch(/[<>]=?\s*\d/);
  });

  it('tests the bound before the handler does anything else', () => {
    // Counting exits bounds how many ways the handler can leave; this bounds what
    // can happen before it decides. A `throw` or a `webView.destroy()` slipped in
    // ahead of the guard changes what a renderer death does to the app while every
    // branch-scoped assertion here still finds its branch exactly where it was.
    expect(readRenderProcessGoneHandler()).toMatch(/^\{\s*if\s*\([^)]*MAX_RENDERER_RECOVERIES/);
  });

  it('exits only through the bound guard, so nothing decides ahead of it', () => {
    // Every other assertion here locates its branch from the guard, and none reads
    // the handler above it. An `if (detail.didCrash()) { return false; }` inserted
    // before the guard kills the app on the first renderer crash — the case this
    // recovery exists for — with the bound left fully intact behind it and every
    // assertion here green; the `return true;` form leaves a live process holding a
    // permanently dead WebView. Counting exits catches both: the guard's two
    // branches are the only ones there is room for.
    const exits = readRenderProcessGoneHandler().match(/\breturn\b/g) ?? [];
    expect(exits).toHaveLength(2);
  });

  it('holds exactly the branch shapes this run approved, nothing else', () => {
    // A count-plus-keyword-denylist guard held this position through five fix
    // cycles and was proven unbounded by execution: a `switch` whose labels use
    // `:` not `;`, and `(detail.didCrash() ? this : new MainActivity()).recreate();`
    // — one statement, one `;`, no listed keyword — both defeated it while every
    // other assertion here stayed green, and a third construct (a ternary over
    // method references) was caught only by coincidence. Comparing the whole
    // normalized shape has no equivalent frontier: anything other than exactly
    // this text fails, whatever form it takes.
    expect(normalizeWhitespace(readBoundSpentBranch())).toBe(EXPECTED_BOUND_SPENT_BRANCH);
    expect(normalizeWhitespace(readRecoveryPath())).toBe(EXPECTED_RECOVERY_PATH);
  });

  it('derives unqualified call names from the text it is given, never from a fixed list', () => {
    // Fixture text sharing no name with anything MainActivity.java actually
    // contains, so this proves the extraction rule generically rather than
    // demonstrating it on the one name the file happens to need protected today.
    // `bravo.charlie()` is qualified (excluded); `if (…)` is a keyword form that
    // precedes `(` without naming a call (also excluded). `Widget`, not
    // `MainActivity`, so this call also proves the enclosing-instance rule below is
    // not exercised by accident here.
    const names = unqualifiedCallNames('alpha(); bravo.charlie(); if (x) { delta(); }', 'Widget');
    expect(names).toHaveLength(2);
    expect(names).toEqual(expect.arrayContaining(['alpha', 'delta']));
  });

  it('treats a <ClassName>.this.method() call as unqualified, since it resolves like a bare call', () => {
    // `Widget`, not `MainActivity`, so this proves the rule is keyed off the
    // `enclosingClassName` argument rather than hard-coded to the one class this
    // file happens to guard today. `Other.this.foxtrot()` is qualified by a class
    // name that does not match the argument, so it stays excluded exactly like any
    // other qualified call — only the enclosing class's own `.this.` form resolves
    // through lexical scoping.
    const names = unqualifiedCallNames('Widget.this.echo(); Other.this.foxtrot();', 'Widget');
    expect(names).toEqual(['echo']);
  });

  it('treats the same idiom as unqualified whatever whitespace sits inside it', () => {
    // A reflow does not change what Java resolves `Widget.this.echo()` to, so it
    // must not change what this function derives either. Whitespace sits at every
    // gap the idiom has — after the class name, around each dot, and after `this`
    // — and `Other  .  this  .foxtrot()` proves the same tolerance does not widen
    // which class name is matched.
    const names = unqualifiedCallNames(
      'Widget\n  .this.echo(); Other  .  this  .foxtrot();',
      'Widget'
    );
    expect(names).toEqual(['echo']);
  });

  it('declares no method elsewhere in the file that could shadow an unqualified call the pinned branches make', () => {
    // The shape pin above passes byte-identical when a same-named method is
    // declared elsewhere in the file, because it never looks outside the two
    // branches it compares. Java resolves an unqualified call inside the
    // anonymous listener by ordinary lexical scoping — including a call spelled
    // `MainActivity.this.recreate()`, which resolves through the same
    // enclosing-class lookup a bare call does — finding a matching declaration on
    // the enclosing MainActivity before it ever reaches the real target on
    // BridgeActivity/Activity. So a second `recreate()` declared anywhere else in
    // this file silently replaces what the pinned call actually runs, with the
    // pinned text itself untouched, whichever of those two forms the call takes.
    // The protected names come from {@link unqualifiedCallNames} over the pinned
    // branches themselves, normalized against the class name
    // {@link readEnclosingClassName} derives from the file rather than a written-down
    // name, so a call added to either branch — in either form — is covered the
    // moment it lands.
    const pinnedText = `${normalizeWhitespace(readBoundSpentBranch())} ${normalizeWhitespace(readRecoveryPath())}`;
    const protectedNames = unqualifiedCallNames(pinnedText, readEnclosingClassName());
    expect(protectedNames.length).toBeGreaterThan(0);

    const source = readMainActivity();
    for (const name of protectedNames) {
      const pattern = new RegExp(String.raw`\b${name}\s*\(`, 'g');
      const totalOccurrences = [...source.matchAll(pattern)];
      const pinnedOccurrences = [...pinnedText.matchAll(pattern)];
      expect(totalOccurrences).toHaveLength(pinnedOccurrences.length);
    }
  });

  it('takes the killing branch once the count reaches the bound, not while it is below', () => {
    // Inverting this comparison reads "kill the process while recoveries remain,
    // recover forever once they are spent" — a full inversion of the bound that
    // leaves every branch-scoped assertion here green, since each branch is found
    // by the constant standing in the condition rather than by what it means.
    expect(readBoundGuardCondition()).toMatch(
      /^rendererRecoveries\s*>=\s*MAX_RENDERER_RECOVERIES$/
    );
  });

  it('stops recovering once the bound is spent, letting Android kill the process', () => {
    const spentBranch = readBoundSpentBranch();
    expect(spentBranch).toContain('return false;');
    expect(spentBranch).not.toContain('return true;');
  });

  it('counts recoveries in static state, which recreate() cannot reset', () => {
    // An instance field would start at zero in the Activity every recovery
    // builds, so the loop this bound exists to stop would never be counted.
    expect(readMainActivity()).toMatch(/private\s+static\s+int\s+rendererRecoveries\s*=\s*0;/);
  });

  it('spends one of the bounded recoveries on the path that recovers', () => {
    // Counted anywhere but the recovering path, the counter never moves on a
    // recovery, so the bound is never reached and the crash loop it exists to stop
    // runs forever — with every other assertion here still green.
    expect(readRecoveryPath()).toContain('rendererRecoveries++;');
  });

  it('writes the counter exactly twice, so nothing resets it', () => {
    // recreate() re-enters onCreate, so a write anywhere in the file — not only
    // inside the handler — can undo the count on every recovery and restore the
    // unbounded crash loop while every other assertion here stays green. The two
    // writes this file is allowed are the declaration's initialiser and the single
    // increment; a third of any shape is a reset, whether it is spelt `= 0` on a
    // timer or `rendererRecoveries--;` beside the increment that pays for it.
    const source = readMainActivity();
    const writes =
      source.match(
        /rendererRecoveries\s*(?:\+\+|--|[+\-*/%&|^]=|=(?!=))|(?:\+\+|--)\s*rendererRecoveries/g
      ) ?? [];
    expect(writes).toHaveLength(2);
    expect(source).toMatch(/private\s+static\s+int\s+rendererRecoveries\s*=\s*0;/);
  });
});
