import type { EmailPalette } from '@hushbox/shared/design-tokens';

type PaletteRole = keyof EmailPalette;

export type EmailFace = 'serif' | 'sans' | 'mono';

/** Every element the renderer writes a colour for. */
export type EmailElement =
  | 'wordmark'
  | 'wordmarkAccent'
  | 'heading'
  | 'sectionHeading'
  | 'paragraph'
  | 'opLine'
  | 'finePrint'
  | 'link'
  | 'button'
  | 'fallback'
  | 'fallbackLink'
  | 'tableLabel'
  | 'tableValue'
  | 'logTitle'
  | 'logMeta'
  | 'bottom'
  | 'bottomLink'
  | 'code'
  | 'footText'
  | 'footLink';

export interface EmailElementStyle {
  readonly face: EmailFace;
  readonly sizePx: number;
  readonly weight: number;
  readonly colour: PaletteRole;
  /** The surface the element sits on, which its colour is read against. */
  readonly background: PaletteRole;
}

/**
 * Every palette role the writer paints comes from this table or {@link EMAIL_SURFACES},
 * and both colour schemes read them, so a changed row moves both. This table records
 * each text element's type and colour, and the surface it sits on, which is the pair the
 * contrast test reads; the button's and code's surface is their own fill. {@link EMAIL_SURFACES}
 * records the painted areas that carry no text. The wordmark's accent, `fallbackLink`,
 * `footLink` and `bottomLink` take their one host's face and size, which their rows
 * record. `link` has several hosts, each with its own face and size; its row records body
 * text, the host the contrast test pairs a link with. `code`'s row records a code block;
 * inline code takes the inline mono size. Strong and mono runs take their host's colour
 * and have no row.
 */
export const EMAIL_STYLES: Readonly<Record<EmailElement, EmailElementStyle>> = {
  wordmark: { face: 'serif', sizePx: 24, weight: 700, colour: 'text', background: 'canvas' },
  wordmarkAccent: {
    face: 'serif',
    sizePx: 24,
    weight: 700,
    colour: 'accent',
    background: 'canvas',
  },
  heading: { face: 'serif', sizePx: 22, weight: 700, colour: 'text', background: 'card' },
  sectionHeading: { face: 'serif', sizePx: 18, weight: 700, colour: 'text', background: 'card' },
  paragraph: { face: 'serif', sizePx: 16, weight: 400, colour: 'text', background: 'card' },
  opLine: { face: 'mono', sizePx: 16, weight: 400, colour: 'text', background: 'card' },
  finePrint: { face: 'sans', sizePx: 14, weight: 400, colour: 'muted', background: 'card' },
  link: { face: 'serif', sizePx: 16, weight: 400, colour: 'accent', background: 'card' },
  button: { face: 'sans', sizePx: 16, weight: 700, colour: 'onAccent', background: 'accent' },
  fallback: { face: 'sans', sizePx: 13, weight: 400, colour: 'muted', background: 'card' },
  fallbackLink: { face: 'sans', sizePx: 13, weight: 400, colour: 'accent', background: 'card' },
  tableLabel: { face: 'sans', sizePx: 14, weight: 400, colour: 'muted', background: 'card' },
  tableValue: { face: 'sans', sizePx: 14, weight: 400, colour: 'text', background: 'card' },
  logTitle: { face: 'mono', sizePx: 14, weight: 400, colour: 'text', background: 'card' },
  logMeta: { face: 'sans', sizePx: 13, weight: 400, colour: 'muted', background: 'card' },
  bottom: { face: 'sans', sizePx: 12, weight: 400, colour: 'muted', background: 'canvas' },
  bottomLink: { face: 'sans', sizePx: 12, weight: 400, colour: 'accent', background: 'canvas' },
  code: { face: 'mono', sizePx: 14, weight: 400, colour: 'text', background: 'codeWell' },
  footText: { face: 'sans', sizePx: 13, weight: 400, colour: 'muted', background: 'card' },
  footLink: { face: 'sans', sizePx: 13, weight: 400, colour: 'accent', background: 'card' },
};

/** Painted areas that carry no text: a background, a border, or both. */
export type EmailSurface = 'canvas' | 'card' | 'rule';

export interface EmailSurfaces {
  readonly canvas: { readonly background: PaletteRole };
  readonly card: { readonly background: PaletteRole; readonly border: PaletteRole };
  readonly rule: { readonly border: PaletteRole };
}

export const EMAIL_SURFACES: EmailSurfaces = {
  canvas: { background: 'canvas' },
  card: { background: 'card', border: 'cardBorder' },
  rule: { border: 'rule' },
};

/** Installed faces only: a web font is a remote fetch most clients refuse. */
export const EMAIL_FONT_STACKS: Readonly<Record<EmailFace, string>> = {
  serif: "Georgia, 'Times New Roman', serif",
  sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "ui-monospace, Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace",
};

/** A mono run inside a line of text: the face, a step below the line it sits in. */
export const EMAIL_INLINE_MONO_SIZE_PX = 13;

function kebab(name: string): string {
  return name.replaceAll(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export function elementClass(element: EmailElement): string {
  return `email-${kebab(element)}`;
}

export function surfaceClass(surface: EmailSurface): string {
  return `email-surface-${kebab(surface)}`;
}
