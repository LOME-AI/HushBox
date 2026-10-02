/** The brand colours a film composes, as the dark theme resolves them. */
export interface BrandColors {
  brandRed: string;
  background: string;
  paper: string;
  foreground: string;
  muted: string;
}

/** A computed style: the one way brand values are read from the stylesheet. */
interface CustomProperties {
  getPropertyValue: (property: string) => string;
}

const COLOR_PROPERTIES = {
  brandRed: '--brand-red',
  background: '--background',
  paper: '--background-paper',
  foreground: '--foreground',
  muted: '--foreground-muted',
} as const satisfies Record<keyof BrandColors, string>;

function readProperty(style: CustomProperties, property: string): string {
  const value = style.getPropertyValue(property).trim();
  if (value === '') {
    throw new Error(
      `the brand stylesheet sets no ${property}; is @hushbox/config/tailwind imported?`
    );
  }
  return value;
}

/** The brand colours, read from the custom properties of a `.dark` element's computed style. */
export function readBrandColors(style: CustomProperties): BrandColors {
  return {
    brandRed: readProperty(style, COLOR_PROPERTIES.brandRed),
    background: readProperty(style, COLOR_PROPERTIES.background),
    paper: readProperty(style, COLOR_PROPERTIES.paper),
    foreground: readProperty(style, COLOR_PROPERTIES.foreground),
    muted: readProperty(style, COLOR_PROPERTIES.muted),
  };
}
