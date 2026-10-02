/**
 * Brand tokens for code that reads colours off the cascade rather than wearing
 * them as classes — canvas fills, the native status bar, `readThemeColors()`.
 *
 * A test document carries no stylesheet, so every custom property resolves to
 * the empty string, which those readers treat as a config failure and refuse.
 * Values are deliberately unlike the real palette: a surface asserting one of
 * them proves it read the cascade instead of a literal of its own.
 *
 * The rule targets every element, not `:root`: the readers resolve against a
 * scope element (a theme-scoped wrapper div), and custom-property inheritance
 * from `:root` down to an arbitrary descendant is not something the test DOM
 * can be relied on to model.
 */
const THEME_TOKEN_FIXTURE: Readonly<Record<string, string>> = {
  '--background': '#fffdf8',
  '--foreground': '#101112',
  '--brand-red': '#c0ffee',
  '--foreground-muted': '#767472',
};

function installSheet(tokens: Readonly<Record<string, string>>): () => void {
  const declarations = Object.entries(tokens)
    .map(([property, value]) => `${property}: ${value};`)
    .join(' ');

  const sheet = document.createElement('style');
  sheet.textContent = `* { ${declarations} }`;
  document.head.append(sheet);

  return () => {
    sheet.remove();
  };
}

/**
 * Install the tokens for the current test and hand back their removal, so a
 * suite that asserts the absent-token refusal can still run in the same file.
 */
export function installThemeTokens(overrides: Record<string, string> = {}): () => void {
  return installSheet({ ...THEME_TOKEN_FIXTURE, ...overrides });
}

/**
 * Install the palette minus the named tokens. A surface that still renders under
 * this resolved only the tokens it asked for; one that resolves the whole palette
 * dies naming a token its caller never wanted.
 */
export function installThemeTokensWithout(omitted: readonly string[]): () => void {
  return installSheet(
    Object.fromEntries(
      Object.entries(THEME_TOKEN_FIXTURE).filter(([property]) => !omitted.includes(property))
    )
  );
}

export { THEME_TOKEN_FIXTURE };
