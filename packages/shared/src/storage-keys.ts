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
