/**
 * Bans wildcard re-exports that republish a module's own declarations.
 *
 * `export * from './fees.js'` makes every future `export const` in that leaf a
 * member of the package's public surface with no line written at any barrel —
 * so a surface widens without a reviewer ever seeing it widen. Named
 * re-exports (`export { … } from`) make the widening the explicit line it is.
 *
 * The ban is structural rather than a list of blessed paths: a star is allowed
 * exactly when its target is a PURE RE-EXPORT BARREL — a module that declares
 * none of its own exports and only forwards names from elsewhere. Widening
 * such a barrel already costs an explicit line, and because the barrel is
 * itself inside the banned scope the same test applies to its own stars, so
 * the property holds down the whole chain. A module named `index.ts` earns
 * nothing by that name: `linear/index.ts` and `notifications/index.ts` declare
 * their own exports and are leaves, which is why the classification reads
 * content instead of filenames.
 *
 * `export * as ns from './leaf.js'` is deliberately NOT banned. It binds a
 * single reviewer-visible name; widening the target changes what hangs off
 * `ns`, never the barrel's own name set, so it is not the silent-widening
 * shape this rule exists to stop.
 *
 * Exemptions are data in exactly one place — the topic config next to this
 * file — because deciding that some other gate replaces enumeration is a
 * policy decision, not a lint fix.
 *
 * A vendored rule instead of core `no-restricted-syntax` because flat config
 * replaces (never merges) a rule key across config objects, and because the
 * leaf-versus-barrel decision requires reading the target module.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { WRITTEN_EXTENSIONS } from '../../written-extensions.mjs';

/** True when a statement publishes a name this module declares itself. */
/** @param {import('typescript').Statement} statement */
function declaresOwnExport(statement) {
  if (ts.isExportDeclaration(statement)) return statement.moduleSpecifier === undefined;
  if (!ts.canHaveModifiers(statement)) return false;
  return (ts.getModifiers(statement) ?? []).some(
    (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
  );
}

/** True when every export the module publishes is forwarded from elsewhere. */
/** @param {string} file */
function isPureReexportBarrel(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    false
  );
  return !source.statements.some((statement) => declaresOwnExport(statement));
}

/** The TypeScript file a relative specifier names, or null when it names none. */
/**
 * @param {string} fromFile
 * @param {string} specifier
 * @returns {string | null}
 */
function resolveTarget(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const stem = specifier.replace(WRITTEN_EXTENSIONS, '');
  const target = path.resolve(path.dirname(fromFile), `${stem}.ts`);
  return existsSync(target) ? target : null;
}

/** The exemption covering this file, or undefined when none does. */
/**
 * @param {string} filename
 * @param {readonly { file: string, exceptTargetsUnder?: string }[]} exemptions
 */
function exemptionFor(filename, exemptions) {
  return exemptions.find((entry) => filename.endsWith(`/${entry.file}`));
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Forbid wildcard re-exports that republish a module’s own declarations, so a public surface cannot widen without an explicit line.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          scopeDir: { type: 'string' },
          exemptions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                file: { type: 'string' },
                exceptTargetsUnder: { type: 'string' },
              },
              required: ['file'],
              additionalProperties: false,
            },
          },
        },
        required: ['scopeDir', 'exemptions'],
        additionalProperties: false,
      },
    ],
    messages: {
      starIntoLeaf:
        "`export * from '{{specifier}}'` republishes a module that declares its own exports, so adding an export there widens the package surface with no line written at any barrel. Re-export the names explicitly instead.",
      starIntoUnresolvedModule:
        "`export * from '{{specifier}}'` republishes a module this rule cannot read, so nothing establishes that the surface only widens on purpose. Re-export the names explicitly instead.",
      starIntoUngovernedBarrel:
        "`export * from '{{specifier}}'` republishes a barrel outside `{{scopeDir}}`, where this rule does not run — so that barrel's own wildcards are ungoverned and the chain reopens. Re-export the names explicitly instead.",
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const { scopeDir, exemptions } = context.options[0];
    const filename = context.filename.replaceAll('\\', '/');
    if (!filename.includes(`/${scopeDir}`)) return {};
    const exemption = exemptionFor(filename, exemptions);

    return {
      /** @param {Extract<import('eslint').Rule.Node, { type: 'ExportAllDeclaration' }>} node */
      ExportAllDeclaration(node) {
        // `export * as ns from` binds one explicit name, not the target's set.
        if (node.exported !== null) return;
        // A module specifier is a string literal by grammar; ESTree types a
        // literal's value as every literal kind.
        const specifier = /** @type {string} */ (node.source.value);
        const target = resolveTarget(filename, specifier);
        if (target === null) {
          context.report({ node, messageId: 'starIntoUnresolvedModule', data: { specifier } });
          return;
        }
        const protectedTarget =
          exemption?.exceptTargetsUnder !== undefined &&
          target.includes(`/${exemption.exceptTargetsUnder}`);
        if (exemption !== undefined && !protectedTarget) return;
        if (!isPureReexportBarrel(target)) {
          context.report({ node, messageId: 'starIntoLeaf', data: { specifier } });
          return;
        }
        if (!target.includes(`/${scopeDir}`)) {
          context.report({
            node,
            messageId: 'starIntoUngovernedBarrel',
            data: { specifier, scopeDir },
          });
        }
      },
    };
  },
};
