import { describe, expect, it } from 'vitest';

import { growthBeaconReferencesIn } from './beacon-references.ts';
import { GROWTH_BEACON_PATH } from './beacon.ts';
import { GROWTH_SCROLL_EVENTS } from './enums.ts';

describe('growthBeaconReferencesIn', () => {
  it('finds the beacon path sent from a source file', () => {
    expect(growthBeaconReferencesIn(`fetch('${GROWTH_BEACON_PATH}', { method: 'POST' })`)).toEqual([
      GROWTH_BEACON_PATH,
    ]);
  });

  it('finds the beacon path in a minified chunk, which quotes with backticks', () => {
    expect(growthBeaconReferencesIn(`fetch(\`${GROWTH_BEACON_PATH}\`,{method:\`POST\`})`)).toEqual([
      GROWTH_BEACON_PATH,
    ]);
  });

  it('leaves a longer path that merely starts with the beacon path alone', () => {
    expect(growthBeaconReferencesIn(`navigate('${GROWTH_BEACON_PATH}vents')`)).toEqual([]);
  });

  it('leaves the beacon path alone where it is not a whole string literal', () => {
    expect(growthBeaconReferencesIn('const route = `/settings/emails`;')).toEqual([]);
  });

  it('finds a scroll-depth event name', () => {
    expect(growthBeaconReferencesIn(`report("${GROWTH_SCROLL_EVENTS[0]}")`)).toEqual([
      GROWTH_SCROLL_EVENTS[0],
    ]);
  });

  it('finds every event name a source carries, in the order the tuple declares them', () => {
    const source = GROWTH_SCROLL_EVENTS.toReversed().join(' ');
    expect(growthBeaconReferencesIn(source)).toEqual([...GROWTH_SCROLL_EVENTS]);
  });

  it('finds the path and the names together', () => {
    const source = `fetch('${GROWTH_BEACON_PATH}');const s='${GROWTH_SCROLL_EVENTS[1]}';`;
    expect(growthBeaconReferencesIn(source)).toEqual([GROWTH_BEACON_PATH, GROWTH_SCROLL_EVENTS[1]]);
  });

  it('finds nothing in a source that reads the campaign tag', () => {
    expect(growthBeaconReferencesIn(`const tag = search['c'];`)).toEqual([]);
  });
});
