import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';

/**
 * What the task pool needs to know about the machine underneath it: an identity
 * to key its recordings by, and a lane ceiling to start from.
 *
 * The identity answers "what does a good schedule look like here", so it is
 * built from the machine's shape alone: one checkout driven by two
 * differently-shaped machines gives each its own file, and two machines of the
 * same shape share one because the record describes them equally — no worse
 * than the two concurrent runs on one machine that already share it.
 *
 * The thread count and the total memory are deliberately outside it. Inside a
 * container both follow the allocation, so a resize, a changed limit or a move
 * to another host would mint a fresh identity and abandon every wall learned
 * under the old one — an ordinary operational event, paid for with a run's
 * worth of relearning each time it happens. Both numbers still reach the
 * derivation, as runtime inputs the projection consumes rather than as key
 * material.
 *
 * The ceiling counts *cores*, not the threads `os.availableParallelism()`
 * reports. On a hybrid CPU those differ by more than they look: this repo's
 * reference machine reports 20 threads over 6 performance cores plus 8
 * efficiency cores, and typed lint is single-threaded and cache-hungry, so
 * thread count overstates how many can run at speed. The ceiling is only a
 * starting point — the pool measures its way down from there — so a machine
 * whose topology cannot be read loses nothing but a couple of runs.
 */

/** The machine's shape: everything the fingerprint is built from. */
interface MachineIdentity {
  readonly platform: string;
  readonly arch: string;
  readonly cpuModel: string;
}

/** The shape, plus the numbers an allocation decides. */
export interface MachineDescriptor extends MachineIdentity {
  readonly threads: number;
  readonly totalMemBytes: number;
}

export interface CpuTopologyEntry {
  readonly cpu: number;
  readonly coreId: string;
  readonly packageId: string;
}

/** Expand a Linux cpu-list (`0-3,8`) into its indices, skipping unparseable parts. */
function parseCpuRange(part: string): readonly number[] {
  const [first, last] = part.split('-');
  /* v8 ignore next -- split always yields a first element */
  const start = Number.parseInt(first ?? '', 10);
  if (!Number.isInteger(start)) return [];
  const end = last === undefined ? start : Number.parseInt(last, 10);
  if (!Number.isInteger(end)) return [];
  const out: number[] = [];
  for (let index = start; index <= end; index += 1) out.push(index);
  return out;
}

export function expandCpuList(spec: string): number[] {
  const out: number[] = [];
  for (const part of spec.trim().split(',')) {
    if (part !== '') out.push(...parseCpuRange(part));
  }
  return out;
}

/**
 * Distinct physical cores among the given threads, optionally narrowed to a
 * performance tier. Undefined when nothing matched, which the caller reads as
 * "topology unknown" rather than "zero cores".
 */
export function countPhysicalCores(
  entries: readonly CpuTopologyEntry[],
  tier?: ReadonlySet<number>
): number | undefined {
  const physical = new Set<string>();
  for (const entry of entries) {
    if (tier && !tier.has(entry.cpu)) continue;
    physical.add(`${entry.packageId}:${entry.coreId}`);
  }
  return physical.size > 0 ? physical.size : undefined;
}

/**
 * A stable short id for a machine's shape; two machines collide only if every
 * field matches, and two allocations of one machine deliberately do collide.
 */
export function fingerprintOf(identity: MachineIdentity): string {
  const canonical = JSON.stringify([identity.platform, identity.arch, identity.cpuModel]);
  return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

export function describeMachine(): MachineDescriptor {
  return {
    platform: process.platform,
    arch: process.arch,
    /* v8 ignore next -- a machine with no cpu cannot be running this */
    cpuModel: os.cpus()[0]?.model ?? 'unknown',
    threads: os.availableParallelism(),
    totalMemBytes: os.totalmem(),
  };
}

export function machineFingerprint(): string {
  return fingerprintOf(describeMachine());
}

const CPU_BASE = '/sys/devices/system/cpu';

function readLinuxTopology(): CpuTopologyEntry[] {
  const entries: CpuTopologyEntry[] = [];
  let names: string[];
  try {
    names = readdirSync(CPU_BASE);
  } catch {
    /* v8 ignore next -- unreadable only where the linux branch is itself unreachable */
    return entries;
  }
  for (const name of names) {
    const match = /^cpu(\d+)$/.exec(name);
    if (!match) continue;
    try {
      // eslint-disable-next-line no-secrets/no-secrets -- a kernel topology filename, whose spelling happens to contain a substring the Resend-key heuristic matches
      const coreId = readFileSync(`${CPU_BASE}/${name}/topology/core_id`, 'utf8').trim();
      const packageId = readFileSync(
        `${CPU_BASE}/${name}/topology/physical_package_id`,
        'utf8'
      ).trim();
      /* v8 ignore next -- the regex matched, so its group is present */
      entries.push({ cpu: Number.parseInt(match[1] ?? '', 10), coreId, packageId });
    } catch {
      // A cpu going offline between readdir and read is not a core we can use.
    }
  }
  return entries;
}

/* v8 ignore start -- reads this machine's /sys; a hybrid box never takes the
   uniform-CPU arm, and a uniform one never takes the hybrid arm */
function linuxPerformanceCores(): number | undefined {
  // Present only on hybrid parts, where it lists the performance-tier threads.
  const tierPath = '/sys/devices/cpu_core/cpus';
  let tier: ReadonlySet<number> | undefined;
  if (existsSync(tierPath)) {
    try {
      tier = new Set(expandCpuList(readFileSync(tierPath, 'utf8')));
    } catch {
      /* v8 ignore next -- the file existed a line ago; a race here just means no tier */
      tier = undefined;
    }
  }
  return countPhysicalCores(readLinuxTopology(), tier);
}
/* v8 ignore stop */

/* v8 ignore start -- darwin-only branch; CI has one macOS job and it does not exercise this */
function darwinPerformanceCores(): number | undefined {
  for (const key of ['hw.perflevel0.physicalcpu', 'hw.physicalcpu']) {
    try {
      const raw = execFileSync('/usr/sbin/sysctl', ['-n', key], { encoding: 'utf8' }).trim();
      const value = Number.parseInt(raw, 10);
      if (Number.isInteger(value) && value > 0) return value;
    } catch {
      // Older kernels lack the perflevel keys; fall through to the next one.
    }
  }
  return undefined;
}
/* v8 ignore stop */

/**
 * The lane ceiling: real cores where the platform will say, else half the
 * thread count, which is what the pool used before it could tell the
 * difference. Windows is deliberately left on the fallback — enumerating its
 * topology needs a PowerShell round trip, and no CI runner exists to prove
 * such code works, so the one platform we cannot test carries no code that
 * could quietly be wrong.
 */
/* v8 ignore start -- platform dispatch and its unreadable-topology fallback: only
   one arm can run on any one machine, and the fallback needs a machine that will
   not describe itself */
function detectPhysicalCores(): number | undefined {
  if (process.platform === 'linux') return linuxPerformanceCores();
  if (process.platform === 'darwin') return darwinPerformanceCores();
  return undefined;
}

export function performanceCoreCount(): number {
  const threads = os.availableParallelism();
  const detected = detectPhysicalCores();
  if (detected === undefined) return Math.max(1, Math.ceil(threads / 2));
  return Math.max(1, Math.min(detected, threads));
}
/* v8 ignore stop */
