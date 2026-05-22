import * as React from 'react';

export type FilterStatus = 'in_progress' | 'planned' | 'shipped';
export type FilterType = 'feature' | 'bug';

const ALL_STATUSES: readonly FilterStatus[] = ['in_progress', 'planned', 'shipped'];
const ALL_TYPES: readonly FilterType[] = ['feature', 'bug'];

export interface FilterState {
  statuses: ReadonlySet<FilterStatus>;
  types: ReadonlySet<FilterType>;
  toggleStatus: (status: FilterStatus) => void;
  toggleType: (type: FilterType) => void;
}

function readInitialFromUrl<T extends string>(key: string, allowed: readonly T[]): ReadonlySet<T> {
  if (typeof window === 'undefined') return new Set(allowed);
  const raw = new URLSearchParams(window.location.search).get(key);
  if (raw === null) return new Set(allowed);
  const requested = raw.split(',').filter((value): value is T => allowed.includes(value as T));
  return requested.length > 0 ? new Set(requested) : new Set(allowed);
}

function writeToUrl(key: string, values: ReadonlySet<string>, defaults: readonly string[]): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const valueList = [...values];
  const matchesDefault =
    valueList.length === defaults.length && defaults.every((v) => values.has(v));
  if (matchesDefault) {
    params.delete(key);
  } else {
    params.set(key, valueList.join(','));
  }
  const next = params.toString();
  const url = `${window.location.pathname}${next.length > 0 ? `?${next}` : ''}`;
  window.history.replaceState(null, '', url);
}

/**
 * URL-synced filter state for the roadmap page. Defaults: all statuses and
 * both types selected. The URL only carries non-default selections, so the
 * canonical /roadmap URL stays clean and shareable filtered URLs look like
 * /roadmap?status=in_progress&type=feature.
 *
 * Skipping `nuqs` here on purpose — it requires a Next/React-Router adapter
 * we don't have on the Astro marketing app. A 40-line hook is cheaper.
 */
export function useFilterState(): FilterState {
  const [statuses, setStatuses] = React.useState<ReadonlySet<FilterStatus>>(() =>
    readInitialFromUrl<FilterStatus>('status', ALL_STATUSES)
  );
  const [types, setTypes] = React.useState<ReadonlySet<FilterType>>(() =>
    readInitialFromUrl<FilterType>('type', ALL_TYPES)
  );

  const toggleStatus = React.useCallback((value: FilterStatus) => {
    setStatuses((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      const result = next.size === 0 ? new Set(ALL_STATUSES) : next;
      writeToUrl('status', result, ALL_STATUSES);
      return result;
    });
  }, []);

  const toggleType = React.useCallback((value: FilterType) => {
    setTypes((current) => {
      const next = new Set(current);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      const result = next.size === 0 ? new Set(ALL_TYPES) : next;
      writeToUrl('type', result, ALL_TYPES);
      return result;
    });
  }, []);

  return { statuses, types, toggleStatus, toggleType };
}

export { ALL_STATUSES, ALL_TYPES };
