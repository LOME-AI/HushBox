'use client';

import * as React from 'react';

/** How long a typed search holds before the next letter starts a new one, as in Radix's menu. */
const SEARCH_RESET_MS = 1000;

/**
 * The item a typed search lands on, matched the way Radix's menu matches: from the focused
 * item onward, wrapping; one letter typed again moves on to the next item it starts.
 */
function nextMatch(
  items: readonly HTMLElement[],
  search: string,
  current: HTMLElement | undefined
): HTMLElement | undefined {
  const first = search.slice(0, 1);
  const term = (search === first.repeat(search.length) ? first : search).toLowerCase();
  const start = current === undefined ? 0 : items.indexOf(current);
  const wrapped = [...items.slice(start), ...items.slice(0, start)];
  const candidates = term.length === 1 ? wrapped.filter((item) => item !== current) : wrapped;
  return candidates.find((item) => item.textContent.trim().toLowerCase().startsWith(term));
}

/**
 * Moves focus to the item a typed letter names, for the sheet's menu; the anchored menu has
 * Radix's own. Returns whether the key was a letter it took.
 */
export function useMenuTypeahead(): (
  event: React.KeyboardEvent,
  items: readonly HTMLElement[],
  current: HTMLElement | undefined
) => boolean {
  const searchRef = React.useRef('');
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  React.useEffect(
    () => () => {
      clearTimeout(timerRef.current);
    },
    []
  );

  return React.useCallback((event, items, current) => {
    const typing = event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey;
    // A space while a search is under way is part of it, not a choice.
    if (!typing || (event.key === ' ' && searchRef.current === '')) return false;
    searchRef.current += event.key;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      searchRef.current = '';
    }, SEARCH_RESET_MS);
    nextMatch(items, searchRef.current, current)?.focus();
    return true;
  }, []);
}
