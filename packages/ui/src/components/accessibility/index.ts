/**
 * The light accessibility surface: the providers and the SVG filter defs, none
 * of which reach the TTS engine. The panel and the floating widget live behind
 * `@hushbox/ui/accessibility/panel` instead, because their graph carries the
 * speech engine's worker and runtime assets; keeping them out of this barrel is
 * what lets an app mount the providers without paying for them.
 */
export { A11yProvider } from './a11y-provider';
export { A11Y_FONT_OVERRIDE_CLASS } from './lib/class-toggles';
export { MotionProvider } from './lib/motion-provider';
export { REDUCED_MOTION_CLASS } from './lib/reduced-motion-broadcaster';
