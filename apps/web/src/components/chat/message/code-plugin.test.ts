import { describe, expect, it, vi } from 'vitest';
import type { code } from '@streamdown/code';
import { createSafeCodePlugin } from '@/components/chat/message/code-plugin';

type CodePlugin = typeof code;
type HighlightArgs = Parameters<CodePlugin['highlight']>;

function makeBasePlugin(supported: ReadonlySet<string>): {
  base: CodePlugin;
  highlightSpy: ReturnType<typeof vi.fn>;
} {
  const highlightSpy = vi.fn(() => null);
  const base = {
    name: 'shiki',
    type: 'code-highlighter',
    supportsLanguage: (lang: string) => supported.has(lang),
    getSupportedLanguages: () => [...supported],
    getThemes: () => ['github-light', 'github-dark'],
    highlight: highlightSpy,
  } as unknown as CodePlugin;
  return { base, highlightSpy };
}

function callHighlight(plugin: CodePlugin, language: string): unknown {
  const args: HighlightArgs = [
    { code: '{}', language, themes: ['github-light', 'github-dark'] } as HighlightArgs[0],
    vi.fn(),
  ];
  return plugin.highlight(...args);
}

describe('createSafeCodePlugin', () => {
  it('delegates to base.highlight when language is supported', () => {
    const { base, highlightSpy } = makeBasePlugin(new Set(['json']));
    const plugin = createSafeCodePlugin(base);

    callHighlight(plugin, 'json');

    expect(highlightSpy).toHaveBeenCalledOnce();
  });

  it('returns null without calling base.highlight when language is not supported', () => {
    const { base, highlightSpy } = makeBasePlugin(new Set(['json']));
    const plugin = createSafeCodePlugin(base);

    const result = callHighlight(plugin, 'jso');

    expect(result).toBeNull();
    expect(highlightSpy).not.toHaveBeenCalled();
  });

  it('preserves the other plugin fields (name, type, supportsLanguage)', () => {
    const { base } = makeBasePlugin(new Set(['json']));
    const plugin = createSafeCodePlugin(base);

    expect(plugin.name).toBe('shiki');
    expect(plugin.type).toBe('code-highlighter');
    expect(plugin.supportsLanguage('json' as never)).toBe(true);
    expect(plugin.supportsLanguage('jso' as never)).toBe(false);
  });
});
