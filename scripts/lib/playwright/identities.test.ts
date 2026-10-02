import { describe, expect, it } from 'vitest';
import { ALL_PROJECT_NAMES } from './projects.js';
import { SLOTS_PER_PROJECT, projectCallerIp, projectGuestIp } from './identities.js';

/** Every (project, slot) pair the derivations are defined over, without wrap. */
const EVERY_PAIR = ALL_PROJECT_NAMES.flatMap((project) =>
  Array.from({ length: SLOTS_PER_PROJECT }, (_unused, slot) => ({ project, slot }))
);

/** The host octet of a derived address, as a number. */
function hostOctet(address: string): number {
  return Number(address.slice(address.lastIndexOf('.') + 1));
}

describe('projectCallerIp', () => {
  it('answers a distinct address for every project and slot pair', () => {
    const addresses = EVERY_PAIR.map(({ project, slot }) => projectCallerIp(project, slot));

    expect(new Set(addresses).size).toBe(EVERY_PAIR.length);
  });

  it('answers a distinct address for every slot of one project', () => {
    const [project] = ALL_PROJECT_NAMES;
    if (project === undefined) throw new Error('empty project registry');
    const addresses = Array.from({ length: SLOTS_PER_PROJECT }, (_unused, slot) =>
      projectCallerIp(project, slot)
    );

    expect(new Set(addresses).size).toBe(SLOTS_PER_PROJECT);
  });

  it('refuses a project the registry does not define', () => {
    expect(() => projectCallerIp('not-a-project', 0)).toThrow('absent from the registry');
  });

  it('refuses a slot that is not a whole worker index', () => {
    expect(() => projectCallerIp(ALL_PROJECT_NAMES[0]!, -1)).toThrow('worker slot');
  });

  it('keeps every caller address inside the host range of one block', () => {
    for (const { project, slot } of EVERY_PAIR) {
      const octet = hostOctet(projectCallerIp(project, slot));
      expect(octet).toBeGreaterThanOrEqual(1);
      expect(octet).toBeLessThanOrEqual(254);
    }
  });

  it('wraps a slot past the per-project allotment onto that project alone', () => {
    const [project] = ALL_PROJECT_NAMES;
    const other = ALL_PROJECT_NAMES.at(-1);
    if (project === undefined || other === undefined) throw new Error('empty project registry');

    expect(projectCallerIp(project, SLOTS_PER_PROJECT)).toBe(projectCallerIp(project, 0));
    expect(projectCallerIp(project, SLOTS_PER_PROJECT)).not.toBe(projectCallerIp(other, 0));
  });
});

describe('projectGuestIp', () => {
  it('answers a distinct address for every project and slot pair', () => {
    const addresses = EVERY_PAIR.map(({ project, slot }) => projectGuestIp(project, slot));

    expect(new Set(addresses).size).toBe(EVERY_PAIR.length);
  });

  it('keeps every guest address inside the host range of one block', () => {
    for (const { project, slot } of EVERY_PAIR) {
      const octet = hostOctet(projectGuestIp(project, slot));
      expect(octet).toBeGreaterThanOrEqual(1);
      expect(octet).toBeLessThanOrEqual(254);
    }
  });

  it('shares no address with any caller identity', () => {
    const callers = new Set(EVERY_PAIR.map(({ project, slot }) => projectCallerIp(project, slot)));
    const guests = EVERY_PAIR.map(({ project, slot }) => projectGuestIp(project, slot));

    expect(guests.filter((guest) => callers.has(guest))).toEqual([]);
  });

  it('wraps a slot past the per-project allotment onto that project alone', () => {
    const [project] = ALL_PROJECT_NAMES;
    const other = ALL_PROJECT_NAMES.at(-1);
    if (project === undefined || other === undefined) throw new Error('empty project registry');

    expect(projectGuestIp(project, SLOTS_PER_PROJECT)).toBe(projectGuestIp(project, 0));
    expect(projectGuestIp(project, SLOTS_PER_PROJECT)).not.toBe(projectGuestIp(other, 0));
  });

  it('refuses a project the registry does not define', () => {
    expect(() => projectGuestIp('not-a-project', 0)).toThrow('absent from the registry');
  });

  it('refuses a slot that is not a whole worker index', () => {
    expect(() => projectGuestIp(ALL_PROJECT_NAMES[0]!, -1)).toThrow('worker slot');
  });
});
