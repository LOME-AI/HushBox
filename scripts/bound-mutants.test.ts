import { describe, it, expect } from 'vitest';
import {
  maskNonCode,
  enumerateBoundMutants,
  applyBoundMutant,
  formatBoundMutants,
} from './bound-mutants.js';

const kindsOf = (source: string): string[] => [
  ...new Set(enumerateBoundMutants(source).map((mutant) => mutant.kind)),
];

const replacementsFor = (source: string, kind: string): string[] =>
  enumerateBoundMutants(source)
    .filter((mutant) => mutant.kind === kind)
    .map((mutant) => mutant.replacement);

describe('maskNonCode', () => {
  it('leaves the source length and its line breaks alone', () => {
    const source = "const a = 1; // note\nconst b = 'text';\n";
    const masked = maskNonCode(source);
    expect(masked).toHaveLength(source.length);
    expect(masked.split('\n')).toHaveLength(source.split('\n').length);
  });

  it('blanks a line comment and keeps the code before it', () => {
    const masked = maskNonCode('const a = 7; // seven\n');
    expect(masked).toContain('const a = 7;');
    expect(masked).not.toContain('seven');
  });

  it('blanks a block comment across lines', () => {
    const masked = maskNonCode('/**\n * 5 things\n */\nconst a = 1;\n');
    expect(masked).not.toContain('things');
    expect(masked).toContain('const a = 1;');
  });

  it('blanks string contents and keeps the quotes', () => {
    const masked = maskNonCode("const a = 'build-01';");
    expect(masked).not.toContain('build');
    expect(masked.replaceAll(' ', '')).toBe("consta='';");
  });

  it('keeps an escaped quote inside a string from ending it', () => {
    const masked = maskNonCode(String.raw`const a = 'it\'s'; const b = 9;`);
    expect(masked).toContain('const b = 9;');
  });

  it('blanks template text but keeps the code inside an interpolation', () => {
    const masked = maskNonCode('const a = `id ${value.slice(0, 12)} seen`;');
    expect(masked).not.toContain('seen');
    expect(masked).toContain('${value.slice(0, 12)}');
  });

  it('keeps a regular expression literal verbatim', () => {
    const masked = maskNonCode('const r = /[a-z]{2,4}/g;');
    expect(masked).toContain('/[a-z]{2,4}/g');
  });

  it('reads a slash after an identifier as division rather than a regex', () => {
    const masked = maskNonCode("const a = total / count; const b = 'x';");
    expect(masked).toContain('total / count');
    expect(masked.replaceAll(' ', '')).toContain("constb='';");
  });

  it('reads a regex that opens the file', () => {
    expect(maskNonCode('/a/.test(x);')).toContain('/a/');
  });

  it('reads a slash after a closing paren as division', () => {
    const masked = maskNonCode("const a = f(b) / c; const d = 'x';");
    expect(masked).toContain('f(b) / c');
    expect(masked.replaceAll(' ', '')).toContain("constd='';");
  });

  it('reads a regex after a keyword that cannot be divided', () => {
    expect(maskNonCode('return /a/.test(x);')).toContain('/a/');
  });

  it('does not end a regex at an escaped slash', () => {
    expect(maskNonCode(String.raw`const r = /a\/b/;`)).toContain(String.raw`/a\/b/`);
  });

  it('leaves a slash alone when no closing slash follows on the line', () => {
    const source = 'const a = 1 /\nb;';
    expect(maskNonCode(source)).toBe(source);
  });

  it('leaves a slash alone when the file ends before the regex closes', () => {
    const source = 'const r = /abc';
    expect(maskNonCode(source)).toBe(source);
  });

  it('blanks a line comment that runs to the end of the file', () => {
    const masked = maskNonCode('const a = 1; // trailing');
    expect(masked).not.toContain('trailing');
    expect(masked).toContain('const a = 1;');
  });

  it('blanks a block comment that is never closed', () => {
    const masked = maskNonCode('const a = 1; /* open');
    expect(masked).not.toContain('open');
    expect(masked).toContain('const a = 1;');
  });

  it('does not run a string past the end of its line', () => {
    const masked = maskNonCode("const a = 'unclosed\nconst b = 2;");
    expect(masked).toContain('const b = 2;');
  });

  it('keeps braces that belong to a block', () => {
    expect(maskNonCode('function f() { return 1; }')).toContain('{ return 1; }');
  });

  it('keeps a nested object literal inside an interpolation', () => {
    const masked = maskNonCode('const a = `x ${f({ n: 2 })} y`;');
    expect(masked).toContain('${f({ n: 2 })}');
    expect(masked).not.toContain('x ');
  });

  it('blanks an escape inside template text', () => {
    const masked = maskNonCode('const a = `p\\`q`;');
    expect(masked).not.toContain('q');
    expect(masked.replaceAll(' ', '')).toBe('consta=``;');
  });

  it('blanks a template that the file ends inside', () => {
    const masked = maskNonCode('const a = `open');
    expect(masked).not.toContain('open');
  });

  it('does not end a regex at a slash inside its character class', () => {
    const masked = maskNonCode("const r = /[/]/g; const b = 'text';");
    expect(masked).toContain('/[/]/g');
    expect(masked).not.toContain('text');
  });
});

describe('enumerateBoundMutants', () => {
  it('moves an integer literal one step in both directions', () => {
    expect(replacementsFor('const cap = 20;', 'numeric-literal')).toEqual(['19', '21']);
  });

  it('classifies a literal that indexes an array', () => {
    expect(kindsOf('const first = parts[0];')).toEqual(['array-index']);
  });

  it('flips the strictness of a comparison in both directions', () => {
    expect(replacementsFor('if (count < cap) return;', 'comparison-strictness')).toEqual(['<=']);
    expect(replacementsFor('if (count <= cap) return;', 'comparison-strictness')).toEqual(['<']);
    expect(replacementsFor('if (count > cap) return;', 'comparison-strictness')).toEqual(['>=']);
    expect(replacementsFor('if (count >= cap) return;', 'comparison-strictness')).toEqual(['>']);
  });

  it('does not read a generic type parameter as a comparison', () => {
    expect(kindsOf('const seen = new Set<string>();')).toEqual([]);
  });

  it('does not read an arrow as a comparison', () => {
    expect(kindsOf('const f = (a) => a;')).toEqual([]);
  });

  it('moves each endpoint of a character-class range in both directions', () => {
    expect(replacementsFor('const r = /[b-y]/;', 'class-range-endpoint')).toEqual([
      'a',
      'c',
      'x',
      'z',
    ]);
  });

  it('does not read a hyphen inside a string as a class range', () => {
    expect(kindsOf("const a = 'b-y';")).toEqual([]);
  });

  it('moves a fixed quantifier bound in both directions', () => {
    expect(replacementsFor('const r = /x{4}/;', 'quantifier-bound')).toEqual(['3', '5']);
  });

  it('moves both bounds of a ranged quantifier', () => {
    expect(replacementsFor('const r = /x{2,6}/;', 'quantifier-bound')).toEqual([
      '1',
      '3',
      '5',
      '7',
    ]);
  });

  it('moves an open-ended quantifier bound', () => {
    expect(replacementsFor('const r = /x{2,}/;', 'quantifier-bound')).toEqual(['1', '3']);
  });

  it('moves a position predicate to each other rung of the ladder', () => {
    expect(replacementsFor('if (name.startsWith(mark)) return;', 'position-predicate')).toEqual([
      '.includes(',
      '.endsWith(',
    ]);
    expect(replacementsFor('if (name.includes(mark)) return;', 'position-predicate')).toEqual([
      '.startsWith(',
      '.endsWith(',
    ]);
    expect(replacementsFor('if (name.endsWith(mark)) return;', 'position-predicate')).toEqual([
      '.startsWith(',
      '.includes(',
    ]);
  });

  it('enumerates nothing inside a comment or a string', () => {
    expect(enumerateBoundMutants("// cap is 20\nconst a = 'up to 20';\n")).toEqual([]);
  });

  it('walks a region a coverage pragma excludes from measurement', () => {
    const source = '/* v8 ignore start */\nconst cap = 20;\n/* v8 ignore stop */\n';
    expect(replacementsFor(source, 'numeric-literal')).toEqual(['19', '21']);
  });

  it('ignores a digit that sits inside a regex body', () => {
    expect(enumerateBoundMutants('const r = /x9/;')).toEqual([]);
  });

  it('ignores a literal too large to step through safely', () => {
    expect(enumerateBoundMutants('const huge = 99999999999999999999;')).toEqual([]);
  });

  it('ignores a comparison that sits inside a regex body', () => {
    expect(kindsOf('const r = / < /;')).toEqual([]);
  });

  it('ignores a position predicate that sits inside a regex body', () => {
    expect(kindsOf('const r = /a.includes(b)/;')).toEqual([]);
  });

  it('treats a hyphen at the start of a class as a literal', () => {
    expect(kindsOf('const r = /[-a]/;')).toEqual([]);
  });

  it('treats a hyphen at the end of a class as a literal', () => {
    expect(kindsOf('const r = /[a-]/;')).toEqual([]);
  });

  it('leaves a shorthand endpoint alone and still moves its partner', () => {
    expect(replacementsFor(String.raw`const r = /[\w-z]/;`, 'class-range-endpoint')).toEqual([
      'y',
      '{',
    ]);
  });

  it('moves an escaped endpoint by the character it escapes', () => {
    expect(replacementsFor(String.raw`const r = /[\\-a]/;`, 'class-range-endpoint')).toEqual([
      String.raw`\[`,
      String.raw`\]`,
      '`',
      'b',
    ]);
  });

  it('escapes an endpoint that moves outside the printable band', () => {
    expect(replacementsFor('const r = /[ -~]/;', 'class-range-endpoint')).toEqual([
      String.raw`\u001f`,
      '!',
      '}',
      String.raw`\u007f`,
    ]);
  });

  it('reads both ranges of a class that carries two', () => {
    expect(replacementsFor('const r = /[a-c0-9]/;', 'class-range-endpoint')).toEqual([
      '`',
      'b',
      'b',
      'd',
      '/',
      '1',
      '8',
      ':',
    ]);
  });

  it('does not read a brace inside a character class as a quantifier', () => {
    expect(kindsOf('const r = /[{2}]/;')).toEqual([]);
  });

  it('does not read a brace that is not a quantifier at all', () => {
    expect(kindsOf('const r = /a{b}/;')).toEqual([]);
  });

  it('moves a zero quantifier bound only upward', () => {
    expect(replacementsFor('const r = /x{0,2}/;', 'quantifier-bound')).toEqual(['1', '1', '3']);
  });

  it('skips an escaped brace when looking for quantifiers', () => {
    expect(replacementsFor(String.raw`const r = /\{x{2}/;`, 'quantifier-bound')).toEqual([
      '1',
      '3',
    ]);
  });

  it('reports the line each mutant sits on', () => {
    const mutants = enumerateBoundMutants('const a = 1;\nconst b = 2;\n');
    expect(mutants.map((mutant) => mutant.line)).toEqual([1, 1, 2, 2]);
  });

  it('reads a bound inside a template interpolation', () => {
    expect(replacementsFor('const a = `id ${value.slice(12)}`;', 'numeric-literal')).toEqual([
      '11',
      '13',
    ]);
  });

  it('skips a digit that belongs to an identifier', () => {
    expect(enumerateBoundMutants('const sha256 = other.utf8;')).toEqual([]);
  });

  it('skips a decimal fraction rather than guessing its step', () => {
    expect(enumerateBoundMutants('const ratio = 1.5;')).toEqual([]);
  });

  it('drops the separators when it moves an underscore-grouped literal', () => {
    expect(replacementsFor('const bound = 10_000;', 'numeric-literal')).toEqual(['9999', '10001']);
  });
});

describe('applyBoundMutant', () => {
  it('rewrites exactly the span the mutant names', () => {
    const source = 'const cap = 20;';
    const [first] = enumerateBoundMutants(source);
    expect(applyBoundMutant(source, first!)).toBe('const cap = 19;');
  });

  it('leaves every other mutant site untouched', () => {
    const source = 'const a = 1;\nconst b = 2;\n';
    const mutants = enumerateBoundMutants(source);
    expect(applyBoundMutant(source, mutants[2]!)).toBe('const a = 1;\nconst b = 1;\n');
  });
});

describe('formatBoundMutants', () => {
  it('renders one line per mutant, located and classified', () => {
    const source = 'const cap = 20;';
    expect(formatBoundMutants('scripts/example.ts', enumerateBoundMutants(source))).toBe(
      [
        'scripts/example.ts:1 numeric-literal 20 -> 19',
        'scripts/example.ts:1 numeric-literal 20 -> 21',
      ].join('\n')
    );
  });

  it('says so when a file yields no bounds at all', () => {
    expect(formatBoundMutants('scripts/example.ts', [])).toBe(
      'scripts/example.ts: no bound-bearing construct'
    );
  });
});
