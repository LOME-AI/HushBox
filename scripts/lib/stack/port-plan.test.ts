import { describe, it, expect } from 'vitest';

import {
  PORT_RANGE,
  SERVICES,
  SERVICE_KEYS,
  SLOTS,
  STACK_MODES,
  STACK_MODE_DECLARATIONS,
  buildPortBlocks,
  describePort,
  portFor,
  portsFor,
  type ServiceDeclaration,
  type ServiceKey,
} from './port-plan.js';

/** The stacks whose own processes listen on what the plan allocates them. */
const bindingModes = STACK_MODES.filter((mode) => STACK_MODE_DECLARATIONS[mode].bindsHostPorts);

/** The stacks that are allocated a band and bind none of it. */
const unboundModes = STACK_MODES.filter((mode) => !STACK_MODE_DECLARATIONS[mode].bindsHostPorts);

/** Every (service, mode, lane, slot) the plan can be asked for. */
function* everyRequest(): Generator<{
  service: ServiceKey;
  mode: (typeof STACK_MODES)[number];
  lane: number;
  slot: number;
}> {
  for (const service of SERVICE_KEYS) {
    for (const mode of STACK_MODES) {
      for (let lane = 0; lane < SERVICES[service].lanes; lane++) {
        for (let slot = 0; slot < SLOTS; slot++) {
          yield { service, mode, lane, slot };
        }
      }
    }
  }
}

describe('buildPortBlocks', () => {
  it('gives a mode-banded service one block per stack mode', () => {
    const blocks = buildPortBlocks({
      banded: { owner: 'host', modeBanded: true, lanes: 1 },
    });

    expect(blocks.map((block) => block.modes)).toStrictEqual(
      [...bindingModes, ...unboundModes].map((mode) => [mode])
    );
  });

  it('lays every band of a stack that binds no host port after every band that does', () => {
    const blocks = buildPortBlocks({
      first: { owner: 'host', modeBanded: true, lanes: 1 },
      second: { owner: 'host', modeBanded: true, lanes: 1 },
    });
    const bound = blocks.filter((block) =>
      block.modes.every((mode) => STACK_MODE_DECLARATIONS[mode].bindsHostPorts)
    );

    expect(blocks.slice(0, bound.length)).toStrictEqual(bound);
  });

  it('gives a service that is not mode-banded one block serving every stack mode', () => {
    const blocks = buildPortBlocks({
      shared: { owner: 'container', modeBanded: false, lanes: 1 },
    });

    expect(blocks).toStrictEqual([{ service: 'shared', modes: [...STACK_MODES], lane: 0 }]);
  });

  it('gives a laned service one block per lane', () => {
    const blocks = buildPortBlocks({
      laned: { owner: 'container', modeBanded: false, lanes: 3 },
    });

    expect(blocks.map((block) => block.lane)).toStrictEqual([0, 1, 2]);
  });

  it('throws when the blocks it needs would outgrow the declared range', () => {
    const services: Record<string, ServiceDeclaration> = {};
    for (let index = 0; index < 11; index++) {
      services[`service${String(index)}`] = {
        owner: 'host',
        modeBanded: false,
        lanes: 1,
      };
    }

    expect(() => buildPortBlocks(services, { range: { first: 10_000, last: 10_999 }, slots: 100 }))
      .toThrowErrorMatchingInlineSnapshot(`
        [Error: Port plan needs 11 blocks x 100 slots = 1100 ports, but the declared range 10000-10999 holds 1000. Widen the range, lower the slot count, or drop a service.]
      `);
  });

  it('accepts a declaration that exactly fills the range', () => {
    const services: Record<string, ServiceDeclaration> = {};
    for (let index = 0; index < 10; index++) {
      services[`service${String(index)}`] = {
        owner: 'host',
        modeBanded: false,
        lanes: 1,
      };
    }

    expect(
      buildPortBlocks(services, { range: { first: 10_000, last: 10_999 }, slots: 100 })
    ).toHaveLength(10);
  });
});

describe('the declared service set', () => {
  it('fits the declared range', () => {
    expect(buildPortBlocks(SERVICES).length * SLOTS).toBeLessThanOrEqual(
      PORT_RANGE.last - PORT_RANGE.first + 1
    );
  });

  it('mode-bands exactly the host-owned services other than the idle daemon', () => {
    const banded = SERVICE_KEYS.filter((key) => SERVICES[key].modeBanded);
    const expected = SERVICE_KEYS.filter(
      (key) => SERVICES[key].owner === 'host' && key !== 'idleDaemon'
    );

    expect(banded).toStrictEqual(expected);
  });
});

describe('portFor', () => {
  it('starts the allocation at the first port of the range', () => {
    const slot0 = SERVICE_KEYS.map((service) => portFor(service, { slot: 0, mode: 'development' }));

    expect(Math.min(...slot0)).toBe(PORT_RANGE.first);
  });

  it('offsets a slot by one port inside its block', () => {
    const first = portFor('vite', { slot: 0, mode: 'development' });

    expect(portFor('vite', { slot: 7, mode: 'development' })).toBe(first + 7);
  });

  it('puts a lane a whole block away from its neighbour', () => {
    const lane0 = portFor('emulatorAdb', { slot: 0, mode: 'development', lane: 0 });

    expect(portFor('emulatorAdb', { slot: 0, mode: 'development', lane: 1 })).toBe(lane0 + SLOTS);
  });

  it('gives a mode-banded service a different port per mode', () => {
    expect(portFor('vite', { slot: 3, mode: 'development' })).not.toBe(
      portFor('vite', { slot: 3, mode: 'e2e' })
    );
  });

  it('gives a service that is not mode-banded the same port in every mode', () => {
    const ports = STACK_MODES.map((mode) => portFor('postgres', { slot: 3, mode }));

    expect(new Set(ports).size).toBe(1);
  });

  it('gives a stack that binds no host port a band of its own', () => {
    for (const unbound of unboundModes) {
      const band = portFor('vite', { slot: 3, mode: unbound });

      for (const bound of bindingModes) {
        expect(band).not.toBe(portFor('vite', { slot: 3, mode: bound }));
      }
    }
  });

  it('rejects a slot outside the slot space', () => {
    expect(() => portFor('vite', { slot: SLOTS, mode: 'development' })).toThrow(/slot/i);
  });

  it('rejects a lane the service does not declare', () => {
    expect(() => portFor('vite', { slot: 0, mode: 'development', lane: 1 })).toThrow(/lane/i);
  });
});

describe('portsFor', () => {
  it('names every declared service', () => {
    expect(Object.keys(portsFor({ slot: 0, mode: 'development' }))).toStrictEqual([
      ...SERVICE_KEYS,
    ]);
  });

  it('selects the requested lane of a laned service', () => {
    expect(portsFor({ slot: 4, mode: 'development', lane: 1 }).emulatorAdb).toBe(
      portFor('emulatorAdb', { slot: 4, mode: 'development', lane: 1 })
    );
  });

  it('leaves a single-lane service on its only lane', () => {
    expect(portsFor({ slot: 4, mode: 'development', lane: 1 }).vite).toBe(
      portFor('vite', { slot: 4, mode: 'development' })
    );
  });
});

describe('allocation invariants', () => {
  it('gives every block a port of its own in every slot', () => {
    const blocks = buildPortBlocks(SERVICES);
    const seen = new Set<number>();

    for (let slot = 0; slot < SLOTS; slot++) {
      for (const block of blocks) {
        for (const mode of block.modes) {
          seen.add(portFor(block.service as ServiceKey, { slot, mode, lane: block.lane }));
        }
      }
    }

    expect(seen.size).toBe(blocks.length * SLOTS);
  });

  it('keeps every allocated port inside the declared range', () => {
    for (const request of everyRequest()) {
      const port = portFor(request.service, request);
      expect(port).toBeGreaterThanOrEqual(PORT_RANGE.first);
      expect(port).toBeLessThanOrEqual(PORT_RANGE.last);
    }
  });

  it('keeps every allocated port above the privileged range and below the ephemeral one', () => {
    for (const request of everyRequest()) {
      const port = portFor(request.service, request);
      expect(port).toBeGreaterThan(1024);
      expect(port).toBeLessThan(32_768);
    }
  });

  it('describes every allocated port back to exactly one service, lane and mode', () => {
    for (const request of everyRequest()) {
      const described = describePort(portFor(request.service, request));

      expect(described).toStrictEqual({
        service: request.service,
        modes: expect.arrayContaining([request.mode]),
        lane: request.lane,
        slot: request.slot,
      });
    }
  });

  // Why the layout is bound-first rather than service-major throughout: a stack
  // that binds nothing still needs an allocation, because every generated env
  // file names every service's port, and appending its band anywhere earlier
  // would renumber ports that live servers are already listening on.
  it('keeps every port no binding stack uses above every port one does', () => {
    const reached: number[] = [];
    const unreached: number[] = [];

    for (const request of everyRequest()) {
      const port = portFor(request.service, request);
      const modes = describePort(port)?.modes ?? [];
      if (modes.some((mode) => STACK_MODE_DECLARATIONS[mode].bindsHostPorts)) reached.push(port);
      else unreached.push(port);
    }

    expect(Math.min(...unreached)).toBeGreaterThan(Math.max(...reached));
  });

  it('describes nothing for a port outside the range', () => {
    expect(describePort(PORT_RANGE.first - 1)).toBeUndefined();
    expect(describePort(PORT_RANGE.last + 1)).toBeUndefined();
  });

  it('describes nothing for a port past the last allocated block', () => {
    const unallocated = PORT_RANGE.first + buildPortBlocks(SERVICES).length * SLOTS;

    expect(describePort(unallocated)).toBeUndefined();
  });
});
