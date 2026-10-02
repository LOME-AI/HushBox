import path from 'node:path';

import { BaseSequencer } from 'vitest/node';
import type { TestSpecification } from 'vitest/node';

interface FileRank {
  readonly failed: boolean;
  readonly duration: number;
}

/**
 * Longest-processing-time-first file ordering across every project in the run.
 *
 * BaseSequencer groups files by project name before consulting durations, so a
 * heavy package late in the alphabet queues behind light ones and stretches the
 * run's tail. This sequencer sorts the whole queue by one rule set instead:
 * previously-failed files first, then unknown files (no recorded duration —
 * assume long, the same policy the base sequencer applies within a project),
 * then longest recorded duration first. Durations come from vitest's own
 * results cache, so ordering needs no data source of ours.
 */
export class LptSequencer extends BaseSequencer {
  public override sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const rank = (spec: TestSpecification): FileRank => {
      const key = `${spec.project.name}:${path.relative(this.ctx.config.root, spec.moduleId)}`;
      const results = this.ctx.cache.getFileTestResults(key);
      return {
        failed: results?.failed ?? false,
        duration: results?.duration ?? Number.POSITIVE_INFINITY,
      };
    };
    const sorted = files.toSorted((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra.failed !== rb.failed) {
        return ra.failed ? -1 : 1;
      }
      if (ra.duration !== rb.duration) {
        return rb.duration - ra.duration;
      }
      if (a.moduleId < b.moduleId) {
        return -1;
      }
      return a.moduleId > b.moduleId ? 1 : 0;
    });
    return Promise.resolve(sorted);
  }
}
