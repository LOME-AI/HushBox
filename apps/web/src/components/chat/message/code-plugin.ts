import { code } from '@streamdown/code';

type CodePlugin = typeof code;
type HighlightFunction = NonNullable<CodePlugin['highlight']>;

/**
 * Wrap `@streamdown/code` so `highlight()` short-circuits to `null` when the
 * language isn't supported. The default plugin calls Shiki's `createHighlighter`
 * unconditionally and logs `[Streamdown Code] Failed to highlight code: ShikiError`
 * for unknown langs — including partial language identifiers visible mid-stream
 * (e.g. `jso` while `json` is still typing in).
 */
export function createSafeCodePlugin(base: CodePlugin): CodePlugin {
  const supportsLanguage = base.supportsLanguage.bind(base);
  const baseHighlight: HighlightFunction = base.highlight.bind(base);
  return {
    ...base,
    highlight(options, callback) {
      if (!supportsLanguage(options.language)) return null;
      return baseHighlight(options, callback);
    },
  };
}

export const safeCode = createSafeCodePlugin(code);
