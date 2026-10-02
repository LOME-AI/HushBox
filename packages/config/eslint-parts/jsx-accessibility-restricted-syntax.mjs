// @ts-check

/**
 * The JSX accessibility `no-restricted-syntax` selectors: inline colour/font in
 * a `style` prop, and a raw `<img>` element.
 *
 * Inline colour/font cannot be overridden by the global accessibility CSS layer
 * (contrast, font scaling, dyslexia fonts), and a raw `<img>` bypasses the
 * `<Img>`/`<Logo>` wrappers that enforce alt-text typing and lazy loading.
 *
 * Exported separately because flat config replaces (never merges) a rule key:
 * any config entry that sets `no-restricted-syntax` for files these also cover
 * must re-list them or the bans silently vanish for those files.
 *
 * @type {{selector: string, message: string}[]}
 */
/* eslint-disable no-secrets/no-secrets -- the style-property AST selector alternates
   every property it covers, which trips the entropy heuristic; it is a public selector
   string, not a credential. */
export const jsxAccessibilityRestrictedSyntax = [
  {
    selector:
      "JSXAttribute[name.name='style'] Property[key.name=/^(color|backgroundColor|borderColor|fontFamily|fontSize|fill|stroke|background|border|borderTop|borderRight|borderBottom|borderLeft|outline|font|boxShadow)$/]",
    message:
      'Do not set color/font in inline styles. Use Tailwind classes or CSS variables so accessibility settings (contrast, font scaling) can override them.',
  },
  {
    selector: "JSXOpeningElement[name.name='img']",
    message: 'Use <Img> from @hushbox/ui (content) or <Logo> (decorative) — never raw <img>.',
  },
];
/* eslint-enable no-secrets/no-secrets */
