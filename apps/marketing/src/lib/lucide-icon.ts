import * as lucideIcons from 'lucide-static';

/**
 * The icon's SVG, marked decorative: the feature name beside it carries the meaning.
 *
 * The namespace holds one member that is not an icon — the CommonJS interop's
 * `default` — so the lookup is narrowed rather than trusted.
 */
export function lucideIconSvg(name: string): string {
  const icons: Record<string, unknown> = lucideIcons;
  const svg = icons[name];
  if (typeof svg === 'string') {
    return svg.replace('<svg', '<svg aria-hidden="true" focusable="false"');
  }
  throw new Error(`Lucide icon "${name}" not found in lucide-static.`);
}
