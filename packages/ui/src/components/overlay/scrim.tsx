// The scrim's classes live in a .tsx module because the app stylesheets scan only .tsx files in
// this package for Tailwind classes; in a .ts module these would never reach the built CSS.

/** Drawn alone, without {@link SCRIM_BLUR_CLASS}, where the page behind the scrim stays unblurred. */
export const SCRIM_BASE_CLASS = 'fixed inset-0 bg-black/50';

export const SCRIM_BLUR_CLASS = 'backdrop-blur-sm';
