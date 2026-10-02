/**
 * Bans `as Idempotent<…>` and `as SettlementTx` casts everywhere except the
 * brand-minting module (apps/api/src/lib/idempotency/brands.ts). The brands
 * are compile-time-only phantom intersections, so a cast is the only way to
 * forge one — banning the cast makes the `idempotent.*` wrappers and the
 * settlement entry point the sole producers, which is the whole type-spine
 * guarantee.
 *
 * Purely syntactic: the target type annotation's source text is scanned for
 * the brand names, so a brand smuggled inside a generic
 * (`as ResultAsync<Idempotent<T>, E>`) or laundered through
 * `as unknown as SettlementTx` is caught too. A user-defined type that
 * happens to be named `Idempotent`/`SettlementTx` is reported as well —
 * deliberate: those names are reserved for the brands.
 *
 * Self-scopes by absolute filename (like the other vendored rules) because
 * flat-config glob base paths differ per consuming package.
 */

const DEFAULT_ALLOWED = String.raw`/apps/api/src/lib/idempotency/brands\.ts$`;

const BRAND_NAME_PATTERN = /\b(?:Idempotent|SettlementTx)\b/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow casting to the Idempotent/SettlementTx brands outside the brand-minting module; only the idempotent.* wrappers and the settlement entry point produce them.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowedFiles: {
            type: 'string',
            description:
              'Regex matched against the absolute filename; matching files may cast to the brands.',
          },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      banned:
        'Never cast to {{brand}} — the brand is forged only by its producer (idempotent.* wrappers / the settlement entry point). Compose through them instead.',
    },
  },
  /** @param {import('eslint').Rule.RuleContext} context */
  create(context) {
    const allowed = new RegExp(context.options[0]?.allowedFiles ?? DEFAULT_ALLOWED);
    const filename = context.filename.replaceAll('\\', '/');
    if (allowed.test(filename)) return {};

    // The assertion nodes are absent from `estree` and this package does not
    // depend on the TypeScript-ESTree types, so the shape declared is the one
    // read here.
    /** @param {import('eslint').Rule.Node & { typeAnnotation: import('eslint').Rule.Node }} node */
    const checkAnnotation = (node) => {
      const text = context.sourceCode.getText(node.typeAnnotation);
      const match = BRAND_NAME_PATTERN.exec(text);
      if (match) {
        context.report({ node, messageId: 'banned', data: { brand: match[0] } });
      }
    };

    return {
      /** @param {import('eslint').Rule.Node & { typeAnnotation: import('eslint').Rule.Node }} node */
      TSAsExpression(node) {
        checkAnnotation(node);
      },
      /** @param {import('eslint').Rule.Node & { typeAnnotation: import('eslint').Rule.Node }} node */
      TSTypeAssertion(node) {
        checkAnnotation(node);
      },
    };
  },
};
