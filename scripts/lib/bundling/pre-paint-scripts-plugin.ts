/**
 * Vite plugin that inlines the pre-paint bootstrap scripts into an SPA's shell.
 *
 * Every surface that paints HushBox chrome has to resolve the stored theme and
 * accessibility preferences before the first pixel is committed, and the only
 * thing that runs that early is a blocking inline `<script>` in `<head>`. The
 * bodies are owned by `packages/ui` — the components that write those
 * preferences at runtime evaluate the same rules — so an app registering this
 * plugin is what puts them in the shell, rather than each `index.html` keeping
 * its own transcription of them.
 *
 * Inline rather than an emitted `<script src>`: an external file is a blocking
 * network fetch before first paint on every cold load, including inside the
 * Capacitor WebView, which is exactly the cost these scripts exist to avoid.
 *
 * `injectTo: 'head'` appends before `</head>`, deliberately not the
 * `head-prepend` default: prepending a couple of kilobytes ahead of the charset
 * declaration risks pushing it past the byte window the HTML spec requires it
 * inside. Placement relative to the entry module is not load-bearing — a
 * classic inline script executes during parse, ahead of any deferred module.
 *
 * This module reaches `packages/ui` by relative path rather than by its package
 * name: an app's Vite config imports this module, and Vite's config loader
 * externalizes every bare specifier, leaving plain Node to follow the package's
 * own source. `@hushbox/scripts` declares no `@hushbox/ui` dependency, so no
 * bare specifier for it resolves from this module at all.
 */
import { A11Y_INIT_SCRIPT } from '../../../packages/ui/src/components/accessibility/lib/init-script.ts';
import { THEME_INIT_SCRIPT } from '../../../packages/ui/src/components/theme/init-script.ts';

import type { HtmlTagDescriptor, Plugin } from 'vite';

/**
 * The scripts a built SPA shell must carry, in the order they run: the theme
 * resolves the light/dark class the accessibility rules then adjust against.
 *
 * Named rather than anonymous because `scripts/verify-bundle.ts` reads this map
 * to check the built shell, and a violation has to say which script is missing.
 */
export const PRE_PAINT_SCRIPTS: ReadonlyMap<string, string> = new Map([
  ['theme', THEME_INIT_SCRIPT],
  ['accessibility', A11Y_INIT_SCRIPT],
]);

export function prePaintScriptsPlugin(): Plugin {
  return {
    name: 'pre-paint-scripts',
    transformIndexHtml(): HtmlTagDescriptor[] {
      return [...PRE_PAINT_SCRIPTS.values()].map((children) => ({
        tag: 'script',
        children,
        injectTo: 'head',
      }));
    },
  };
}
