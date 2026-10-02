import { useCallback, useState } from 'react';

const KEY = 'docket.filter-rail.closed';

function stored(): boolean | null {
  const raw = globalThis.localStorage.getItem(KEY);
  if (raw === null) return null;
  return raw === '1';
}

/**
 * Whether the filter rail is folded away. It lives in browser storage rather
 * than in the url the rest of the console's view rides: closing the rail is how
 * the reader has set their console up for a long sitting, not a view a link
 * reproduces, and reopening it on every reload would be the console taking that
 * decision back.
 *
 * Nothing is stored until the reader says either way, so the fallback decides
 * until then — which is what lets a viewport with no room for the rail open
 * folded while a wide one opens with the filters on screen.
 */
export function useRailClosed(fallback: boolean): readonly [boolean, (closed: boolean) => void] {
  const [chosen, setChosen] = useState<boolean | null>(stored);

  const choose = useCallback((closed: boolean): void => {
    globalThis.localStorage.setItem(KEY, closed ? '1' : '0');
    setChosen(closed);
  }, []);

  return [chosen ?? fallback, choose];
}
