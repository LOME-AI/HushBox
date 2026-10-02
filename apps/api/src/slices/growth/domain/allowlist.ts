import { z } from 'zod';
// The attribute is what the development seeding door needs: it reaches this
// module through Node's own loader, which refuses a JSON import without one.
// Every other consumer bundles, so the attribute reads as removable and is not.
import generated from './growth-index.json' with { type: 'json' };
import type { GrowthEventIndex } from '@hushbox/shared';

/**
 * The built page-and-event index the beacon validates against.
 *
 * It maps each page the marketing site actually built to the event names that
 * page's own links and buttons derive, and it is EXTRACTED at build time
 * rather than maintained: a new call to action is measured from the deploy
 * that ships it, and a name nothing on the page derives cannot be minted by a
 * sender. That matters more here than it would elsewhere, because growth rows
 * are kept forever — a junk path or an attacker-chosen event name is not a bad
 * row for an afternoon, it is a permanent one.
 *
 * The index reaches the Worker as a generated module the marketing build
 * writes beside this file, so nothing is read from disk and nothing is fetched
 * at runtime. It is committed, so a checkout carries one without building the
 * site and the local stacks bundle that copy; the Worker's own build command
 * runs the same extractor before a deploy bundles, so what deploys describes
 * the site deployed with it. It sits inside the
 * slice that reads it because the slice perimeter classifies a module by where
 * it lives: a shared `generated/` directory would be a target no layer is
 * allowed to import, and this is one slice's own data.
 */

const eventIndexSchema = z.record(z.string(), z.array(z.string()));

/**
 * The index, validated. It throws rather than answering a partial value: a
 * shape this cannot read means the build that produced it went wrong, and a
 * Worker that started anyway would validate beacons against nothing.
 *
 * An index carrying no page is refused for the same reason and is the worse
 * case, because it parses: every click the site sends would be rejected
 * against an allowlist naming nothing, and no error anywhere would say so. The
 * refusal lives here rather than only in the extractor because every path that
 * reaches an index passes through this function, so the guarantee holds by
 * construction rather than by which producer ran.
 */
export function parseGrowthEventIndex(raw: unknown): GrowthEventIndex {
  const parsed = eventIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error('growth event index: the built page-and-event index is not readable');
  }
  if (Object.keys(parsed.data).length === 0) {
    throw new Error(
      'growth event index: the built page-and-event index carries no page, so every event would be rejected; rebuild the marketing site and extract it again'
    );
  }
  return parsed.data;
}

const BUNDLED: GrowthEventIndex = parseGrowthEventIndex(generated);

/** The index this build bundled. */
export function bundledGrowthEventIndex(): GrowthEventIndex {
  return BUNDLED;
}
