import { SHARDS } from '../../../mobile-tests/config.js';

/**
 * The stacks a checkout can run at once, each with its own generated env files,
 * its own data plane and its own band of this plan.
 */
export const STACK_MODES = ['development', 'e2e', 'test'] as const;

export type StackMode = (typeof STACK_MODES)[number];

interface StackModeDeclaration {
  /**
   * Whether the stack's own processes listen on the ports it is allocated. A
   * stack that starts no server still needs an allocation, because every
   * generated env file names every service's port — but it never competes for
   * one, which is what lets {@link buildPortBlocks} keep its band out of the
   * way of the stacks that do.
   */
  readonly bindsHostPorts: boolean;
}

/**
 * What each stack is to the allocation. Keyed by {@link StackMode}, so a stack
 * added to the set above and nowhere else fails to compile rather than being
 * laid out on a default nobody chose.
 */
export const STACK_MODE_DECLARATIONS: Record<StackMode, StackModeDeclaration> = {
  development: { bindsHostPorts: true },
  e2e: { bindsHostPorts: true },
  // Nothing binds this band. A suite that needs a real listener either takes a
  // kernel-assigned port or stands in for a server of a stack that does bind,
  // on that stack's band, so the band allocated here is never listened on. The
  // `port-requests-name-a-binding-stack` architecture rule holds callers to the
  // flag: across the source trees that layer scans, it refuses a request
  // written against a stack declared false here, outside this module and its
  // own suite. It reads requests, not listeners, so a process that takes a port
  // off a generated env file and binds it is still outside what any gate sees.
  test: { bindsHostPorts: false },
};

/**
 * The inclusive host-port range every allocated port comes from. Chosen above
 * every port an off-the-shelf service defaults to and below the ephemeral range
 * Linux hands out from 32768, so an allocation can neither shadow a well-known
 * service nor be handed to an unrelated process by the kernel.
 */
export const PORT_RANGE = { first: 10_000, last: 19_999 } as const;

/** Concurrent stacks the allocation supports; a slot is one stack's offset inside every block. */
export const SLOTS = 100;

/**
 * Who binds the host port: a container publishes it (freeing it would mean
 * stopping the container), a process of this checkout binds it directly.
 */
export type ServiceOwner = 'container' | 'host';

export interface ServiceDeclaration {
  readonly owner: ServiceOwner;
  /** Whether development and e2e each get their own port, rather than sharing one. */
  readonly modeBanded: boolean;
  /** Parallel instances of the service that must bind at once, each on its own port. */
  readonly lanes: number;
}

/**
 * Every service of the local stack that binds a host port. Declaration order is
 * block order within a band, so appending a service leaves every bound
 * allocation where it was; reordering or removing one moves them.
 */
export const SERVICES = {
  vite: { owner: 'host', modeBanded: true, lanes: 1 },
  preview: { owner: 'host', modeBanded: true, lanes: 1 },
  api: { owner: 'host', modeBanded: true, lanes: 1 },
  postgres: { owner: 'container', modeBanded: false, lanes: 1 },
  neon: { owner: 'container', modeBanded: false, lanes: 1 },
  redis: { owner: 'container', modeBanded: false, lanes: 1 },
  redisHttp: { owner: 'container', modeBanded: false, lanes: 1 },
  astro: { owner: 'host', modeBanded: true, lanes: 1 },
  emulatorAdb: { owner: 'container', modeBanded: false, lanes: SHARDS },
  emulatorVnc: { owner: 'host', modeBanded: true, lanes: 1 },
  readmePreview: { owner: 'host', modeBanded: true, lanes: 1 },
  minioApi: { owner: 'container', modeBanded: false, lanes: 1 },
  minioConsole: { owner: 'container', modeBanded: false, lanes: 1 },
  studio: { owner: 'host', modeBanded: true, lanes: 1 },
  admin: { owner: 'host', modeBanded: true, lanes: 1 },
  crawlerView: { owner: 'host', modeBanded: true, lanes: 1 },
  sandbox: { owner: 'host', modeBanded: true, lanes: 1 },
  docket: { owner: 'host', modeBanded: true, lanes: 1 },
  // The idle-killer daemon is one sentinel per slot across both modes, so it is
  // the one host-bound service that is not mode-banded.
  idleDaemon: { owner: 'host', modeBanded: false, lanes: 1 },
  // The devtools port the local Worker runtime listens on. It resolves its own
  // free port when told none, but only by probing a short run of candidates
  // from one fixed start, so enough stacks on one host collapse onto the same
  // number and one takes the other's inspector. Allocated like every other
  // bound port instead.
  apiInspector: { owner: 'host', modeBanded: true, lanes: 1 },
} satisfies Record<string, ServiceDeclaration>;

export type ServiceKey = keyof typeof SERVICES;

export const SERVICE_KEYS: readonly ServiceKey[] = Object.keys(SERVICES) as ServiceKey[];

/** One `SLOTS`-wide run of ports, serving one service on one lane in the modes it names. */
interface PortBlock {
  readonly service: string;
  readonly modes: readonly StackMode[];
  readonly lane: number;
}

interface PortBlockOptions {
  readonly range?: { readonly first: number; readonly last: number };
  readonly slots?: number;
}

/**
 * The stacks on one side of {@link StackModeDeclaration.bindsHostPorts}: the
 * ones whose processes listen on what they are allocated, or the ones that
 * listen on none of it. Published because the reclaimer needs the same split to
 * decide which bands are worth probing, and a caller deriving it again would be
 * a second reading of one declaration.
 */
export function modesBinding(bindsHostPorts: boolean): readonly StackMode[] {
  return STACK_MODES.filter(
    (mode) => STACK_MODE_DECLARATIONS[mode].bindsHostPorts === bindsHostPorts
  );
}

/** One contiguous band per mode, over the services that band. */
function bandsFor(
  services: Readonly<Record<string, ServiceDeclaration>>,
  modes: readonly StackMode[]
): PortBlock[] {
  const blocks: PortBlock[] = [];
  for (const mode of modes) {
    for (const [service, declaration] of Object.entries(services)) {
      if (!declaration.modeBanded) continue;
      for (let lane = 0; lane < declaration.lanes; lane++) {
        blocks.push({ service, modes: [mode], lane });
      }
    }
  }
  return blocks;
}

/**
 * Lay the declared services out as consecutive blocks and refuse a layout the
 * range cannot hold. Every port derives from a block index, so two services can
 * no more overlap than two array indices can.
 *
 * The stacks that bind their allocation are laid out first, service-major then
 * lane-minor, and the stacks that bind none take their bands after all of them.
 * That order is what a stack costs to add: appended at the end, a stack binding
 * nothing renumbers no port a server is listening on, while one that binds is
 * interleaved and moves the ports after it.
 */
export function buildPortBlocks(
  services: Readonly<Record<string, ServiceDeclaration>>,
  options: PortBlockOptions = {}
): readonly PortBlock[] {
  const range = options.range ?? PORT_RANGE;
  const slots = options.slots ?? SLOTS;

  const blocks: PortBlock[] = [];
  for (const [service, declaration] of Object.entries(services)) {
    const bands = declaration.modeBanded
      ? modesBinding(true).map((mode) => [mode])
      : [[...STACK_MODES]];
    for (const modes of bands) {
      for (let lane = 0; lane < declaration.lanes; lane++) {
        blocks.push({ service, modes, lane });
      }
    }
  }
  blocks.push(...bandsFor(services, modesBinding(false)));

  const needed = blocks.length * slots;
  const available = range.last - range.first + 1;
  if (needed > available) {
    throw new Error(
      `Port plan needs ${String(blocks.length)} blocks x ${String(slots)} slots = ${String(needed)} ports, but the declared range ${String(range.first)}-${String(range.last)} holds ${String(available)}. Widen the range, lower the slot count, or drop a service.`
    );
  }

  return blocks;
}

const BLOCKS = buildPortBlocks(SERVICES);

/** The block a service binds on one mode and lane, as a lookup key. */
function blockKey(service: string, mode: StackMode, lane: number): string {
  return `${service}|${mode}|${String(lane)}`;
}

const BLOCK_INDEX: ReadonlyMap<string, number> = new Map(
  BLOCKS.flatMap((block, index) =>
    block.modes.map((mode): [string, number] => [blockKey(block.service, mode, block.lane), index])
  )
);

interface PortRequest {
  readonly slot: number;
  readonly mode: StackMode;
  readonly lane?: number;
}

/** Where one service binds for a slot, mode and lane. */
export function portFor(service: ServiceKey, request: PortRequest): number {
  const lane = request.lane ?? 0;
  if (!Number.isInteger(request.slot) || request.slot < 0 || request.slot >= SLOTS) {
    throw new Error(
      `Port plan slot ${String(request.slot)} is outside the slot space 0-${String(SLOTS - 1)}.`
    );
  }
  const blockIndex = BLOCK_INDEX.get(blockKey(service, request.mode, lane));
  if (blockIndex === undefined) {
    throw new Error(
      `Service "${service}" declares ${String(SERVICES[service].lanes)} lane(s), so lane ${String(lane)} does not exist.`
    );
  }
  return PORT_RANGE.first + blockIndex * SLOTS + request.slot;
}

/**
 * Where every service binds for a slot and mode. `lane` selects the lane of
 * each service that declares more than one; a single-lane service has only its
 * own lane to bind, so it is unaffected.
 */
export function portsFor(request: PortRequest): Record<ServiceKey, number> {
  const lane = request.lane ?? 0;
  const ports = {} as Record<ServiceKey, number>;
  for (const service of SERVICE_KEYS) {
    const declared = SERVICES[service].lanes;
    ports[service] = portFor(service, { ...request, lane: lane < declared ? lane : 0 });
  }
  return ports;
}

interface PortDescription extends PortBlock {
  readonly service: ServiceKey;
  readonly slot: number;
}

/** The one service, lane, mode band and slot an allocated port belongs to, or nothing. */
export function describePort(port: number): PortDescription | undefined {
  if (port < PORT_RANGE.first || port > PORT_RANGE.last) return undefined;
  const offset = port - PORT_RANGE.first;
  const block = BLOCKS[Math.trunc(offset / SLOTS)];
  if (block === undefined) return undefined;
  return {
    service: block.service as ServiceKey,
    modes: block.modes,
    lane: block.lane,
    slot: offset % SLOTS,
  };
}
