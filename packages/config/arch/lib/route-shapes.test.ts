import { Node, Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { stringProperty, unwrap } from './route-shapes.js';
import type { ObjectLiteralExpression } from 'ts-morph';

/** The initializer of `const value = …`, as a rule reads a declaration. */
function initializerOf(source: string): Node | undefined {
  return new Project({ useInMemoryFileSystem: true })
    .createSourceFile('a.ts', source)
    .getVariableDeclarationOrThrow('value')
    .getInitializer();
}

function objectLiteral(source: string): ObjectLiteralExpression {
  const node = unwrap(initializerOf(source));
  if (!Node.isObjectLiteralExpression(node)) {
    throw new TypeError('the fixture must initialize an object literal');
  }
  return node;
}

describe('unwrap', () => {
  it('reaches the expression under an `as` assertion', () => {
    expect(unwrap(initializerOf("const value = 'x' as const;"))?.getText()).toBe("'x'");
  });

  it('reaches the expression under a `satisfies` clause', () => {
    expect(unwrap(initializerOf('const value = {} satisfies object;'))?.getText()).toBe('{}');
  });

  it('reaches the expression under both, however they are stacked', () => {
    expect(unwrap(initializerOf("const value = 'x' as const satisfies string;"))?.getText()).toBe(
      "'x'"
    );
  });

  it('leaves an unwrapped expression as it is', () => {
    expect(unwrap(initializerOf("const value = 'x';"))?.getText()).toBe("'x'");
  });

  it('passes a missing node through, so a caller reads one absence', () => {
    expect(unwrap(initializerOf('const value;'))).toBeUndefined();
  });
});

describe('stringProperty', () => {
  it('reads the string a named property is assigned', () => {
    expect(stringProperty(objectLiteral("const value = { kind: 'shared' };"), 'kind')).toBe(
      'shared'
    );
  });

  it('reads through the type-only wrappers the assignment can carry', () => {
    expect(
      stringProperty(objectLiteral("const value = { kind: 'shared' as const };"), 'kind')
    ).toBe('shared');
  });

  it('reads no value from a property that is not a string literal', () => {
    expect(stringProperty(objectLiteral('const value = { kind: 7 };'), 'kind')).toBeUndefined();
  });

  it('reads no value from a property written as a shorthand', () => {
    expect(
      stringProperty(objectLiteral('const kind = 1; const value = { kind };'), 'kind')
    ).toBeUndefined();
  });

  it('reads no value from a property the object does not carry', () => {
    expect(stringProperty(objectLiteral('const value = {};'), 'kind')).toBeUndefined();
  });
});
