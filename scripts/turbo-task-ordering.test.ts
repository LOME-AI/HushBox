import { describe, it, expect } from 'vitest';

import { CONFIG_FILE, tasksIn } from './turbo-configs.js';

/** The marketing package's two builds: the public site, and the copy the admin origin frames. */
const SITE_BUILD = 'build';
const PREVIEW_BUILD = 'admin-preview:build';

const tasks = tasksIn(CONFIG_FILE);

describe('the marketing site built twice', () => {
  it('declares both builds, without which the rule below passes over nothing', () => {
    expect(Object.keys(tasks)).toEqual(expect.arrayContaining([SITE_BUILD, PREVIEW_BUILD]));
  });

  // Two runs of one site builder over one package, under two configurations,
  // and a run answers a configuration change by clearing the content store
  // that lives in the package. Started together they overlap end to end and
  // only one of them clears, so what each build reads is decided by the
  // interleaving. Nothing else in the task graph keeps them apart: the
  // repository-wide build reaches the site build directly and the preview
  // build through the admin origin's assets, so without an edge between them
  // the runner is free to start both at once, and a failure in either takes
  // the run down.
  it('runs the preview build behind the site build rather than beside it', () => {
    expect(tasks[PREVIEW_BUILD]).toHaveProperty('dependsOn', expect.arrayContaining([SITE_BUILD]));
  });
});
