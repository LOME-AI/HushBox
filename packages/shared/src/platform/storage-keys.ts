/**
 * Client-side persistence keys (browser localStorage / Zustand persist `name`).
 *
 * Keys consumed by more than one package live here so the web app and the e2e
 * suite share a single source of truth — a rename then breaks both at the type
 * level instead of silently orphaning persisted state or a test seed.
 *
 * Store-local keys with no cross-package consumer may stay literals in their
 * store file; promote them here when something outside the web app needs them.
 */

/** Zustand persist key for the web-search preference store (`stores/search.ts`). */
export const WEB_SEARCH_STORAGE_KEY = 'hushbox-search-storage';

/**
 * Announcement-banner dismissal key. Its value is the dismissed message-set hash,
 * not a boolean: the banner is dismissed only while the stored hash equals the
 * current set's hash, so a new set (new hash) re-shows automatically with no
 * stale-key cleanup. Written only on dismiss — a "not dismissed" state is the
 * absence of this key, never a stored `false`. Shared by the web app and the
 * Astro site, hence the dotted, versioned cross-app key shape.
 */
export const BANNER_DISMISSED_STORAGE_KEY = 'hushbox.banner.dismissed.v1';

/**
 * Zustand persist key for the accessibility preference store
 * (`@hushbox/ui` accessibility store). Written on every `set`, including the
 * host-supplied reduced-motion override applied at page load, so its presence
 * is normal on every HushBox surface rather than a sign of anything stored
 * deliberately.
 */
export const A11Y_STORAGE_KEY = 'hushbox.a11y.v1';

/**
 * Arms the deterministic prompt predictor an end-to-end build carries.
 *
 * That predictor answers nothing until a page asks for it, so a spec that never
 * writes this key drives exactly the composer production ships — no hint, no
 * candidate list, no extra handlers on the textarea. Presence is the whole
 * signal; the stored value is never read.
 */
export const PROMPT_PREDICTION_STUB_STORAGE_KEY = 'hushbox.e2e.prompt-prediction';
