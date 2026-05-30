/**
 * OS-agnostic resource-exhaustion scanner.
 *
 * The symptom that distinguishes a host/container resource limit from an
 * ordinary assertion failure is logged by the browser/runtime as a specific
 * errno string (e.g. `pthread_create: Resource temporarily unavailable`), and
 * those strings appear identically on every OS. So instead of reading Linux
 * counters (`/proc`, cgroups), we scan the error text the report already
 * collects. Pure string matching — no platform APIs, no external tools.
 */

export interface ResourceErrorCategory {
  /** Human-readable limit class, e.g. "process/thread limit". */
  name: string;
  /** Number of scanned entries whose text matched this category. */
  count: number;
  /** Distinct test identifiers that hit this category (capped for readability). */
  tests: string[];
}

export interface ResourceScan {
  /** Total matched entries across all categories. */
  totalHits: number;
  /** Only categories with at least one hit, most-hit first. */
  categories: ResourceErrorCategory[];
}

export interface ScanEntry {
  /** Stable identifier for the source test (used to dedupe `tests`). */
  test: string;
  /** Error / console / browser-log text to scan. */
  text: string;
}

const MAX_TESTS_PER_CATEGORY = 10;

/**
 * Ordered so the most specific/diagnostic class wins a tie in reporting.
 * Patterns are intentionally broad — these strings are emitted verbatim by
 * Node, Chromium, and WebKit regardless of platform.
 */
const PATTERNS: readonly { name: string; re: RegExp }[] = [
  {
    name: 'process/thread limit',
    re: /pthread_create|Resource temporarily unavailable|\bEAGAIN\b/i,
  },
  { name: 'open-file limit', re: /too many open files|\bEMFILE\b/i },
  {
    name: 'out of memory',
    re: /cannot allocate memory|\bENOMEM\b|out of memory|bad_alloc/i,
  },
  { name: 'process killed', re: /\bSIGKILL\b|\bsignal 9\b/i },
  {
    name: 'browser crash',
    re: /Target (?:page, context or browser has been closed|crashed)|Page crashed|browserContext\.newPage|browserType\.launch/i,
  },
];

/**
 * Scan error/console text for resource-exhaustion symptoms. Returns the
 * categories that matched, with hit counts and the distinct tests responsible.
 */
export function scanResourceErrors(entries: readonly ScanEntry[]): ResourceScan {
  const categories: ResourceErrorCategory[] = [];
  let totalHits = 0;

  for (const { name, re } of PATTERNS) {
    let count = 0;
    const tests = new Set<string>();

    for (const entry of entries) {
      if (entry.text.length > 0 && re.test(entry.text)) {
        count += 1;
        tests.add(entry.test);
      }
    }

    if (count > 0) {
      categories.push({ name, count, tests: [...tests].slice(0, MAX_TESTS_PER_CATEGORY) });
      totalHits += count;
    }
  }

  categories.sort((a, b) => b.count - a.count);
  return { totalHits, categories };
}
