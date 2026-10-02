import { describe, it, expect } from 'vitest';

import { parseJsonc, readJsonc } from './jsonc.js';

describe('parseJsonc', () => {
  it('drops a comment occupying a whole line', () => {
    expect(parseJsonc('{\n  // why a is one\n  "a": 1\n}')).toEqual({ a: 1 });
  });

  it('drops a comment following content on the same line', () => {
    expect(parseJsonc('{\n  "a": 1 // why a is one\n}')).toEqual({ a: 1 });
  });

  it('drops a comment closing the file without a trailing newline', () => {
    expect(parseJsonc('{ "a": 1 } // why nothing follows')).toEqual({ a: 1 });
  });

  it('drops a block comment between two properties', () => {
    expect(parseJsonc('{\n  "a": 1, /* why b follows */ "b": 2\n}')).toEqual({ a: 1, b: 2 });
  });

  it('drops a block comment spanning several lines', () => {
    expect(parseJsonc('{\n  /*\n   * why a is one\n   */\n  "a": 1\n}')).toEqual({ a: 1 });
  });

  it('treats an unterminated block comment as running to the end of input', () => {
    expect(parseJsonc('{ "a": 1 } /* why nothing follows')).toEqual({ a: 1 });
  });

  it('drops a trailing comma before a closing brace', () => {
    expect(parseJsonc('{\n  "a": 1,\n}')).toEqual({ a: 1 });
  });

  it('drops a trailing comma before a closing bracket', () => {
    expect(parseJsonc('{\n  "a": [1, 2,]\n}')).toEqual({ a: [1, 2] });
  });

  it('keeps a // inside a string value', () => {
    expect(parseJsonc('{ "$schema": "https://turbo.build/schema.json" }')).toEqual({
      $schema: 'https://turbo.build/schema.json',
    });
  });

  it('keeps a /* inside a string value', () => {
    expect(parseJsonc('{ "glob": "/*.ts", "a": 1 }')).toEqual({ glob: '/*.ts', a: 1 });
  });

  it('keeps an escaped quote from ending a string', () => {
    expect(parseJsonc(String.raw`{ "a": "say \" // now", "b": 2 }`)).toEqual({
      a: 'say " // now',
      b: 2,
    });
  });

  it('rejects an unterminated string', () => {
    expect(() => parseJsonc('{ "a": "unterminated')).toThrow(SyntaxError);
  });
});

describe('readJsonc', () => {
  it('parses a repo config whose $schema URL contains //', () => {
    const config = readJsonc('turbo.json') as { $schema: string };

    expect(config.$schema).toContain('//');
  });
});
