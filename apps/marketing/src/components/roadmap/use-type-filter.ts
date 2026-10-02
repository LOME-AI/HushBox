import * as React from 'react';
import type { TypeFilterValue } from './types';

interface TypeFilterState {
  type: TypeFilterValue;
  setType: (type: TypeFilterValue) => void;
}

const TYPE_PARAM = 'type';

function readTypeFromUrl(): TypeFilterValue {
  const raw = new URLSearchParams(globalThis.location.search).get(TYPE_PARAM);
  return raw === 'feature' || raw === 'bug' ? raw : 'all';
}

function writeTypeToUrl(type: TypeFilterValue): void {
  const params = new URLSearchParams(globalThis.location.search);
  if (type === 'all') params.delete(TYPE_PARAM);
  else params.set(TYPE_PARAM, type);
  const next = params.toString();
  const search = next.length > 0 ? `?${next}` : '';
  globalThis.history.replaceState(null, '', `${globalThis.location.pathname}${search}`);
}

/**
 * The roadmap's type filter, kept in the URL so a filtered view can be shared:
 * `?type=feature` or `?type=bug`, and nothing for All. Any other value, including
 * the older comma-separated list and the retired `status` parameter, reads as All.
 * The first render is All, as the static page was built, and the URL's type applies
 * once hydrated; reading the URL during that first render would mismatch the page.
 */
export function useTypeFilter(): TypeFilterState {
  const [type, setTypeState] = React.useState<TypeFilterValue>('all');

  React.useEffect(() => {
    setTypeState(readTypeFromUrl());
  }, []);

  const setType = React.useCallback((next: TypeFilterValue) => {
    setTypeState(next);
    writeTypeToUrl(next);
  }, []);

  return { type, setType };
}
