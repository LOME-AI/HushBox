/**
 * Three root scripts whose body is the whole of what arms a guard.
 *
 * Each of the modules below is reachable only from the manifest, and each stops
 * protecting anything the moment its script names something else: the shim
 * correction is re-applied by the install hook or by nobody, since every install
 * regenerates the shim it corrects; the teardown guard refuses a destruction an
 * operator can type only while the script that types it runs the guarded entry;
 * and the unused-export scan loads build configs that read a stack's generated
 * environment, so a body that reaches the scanner any other way dies on a config
 * load instead of reporting.
 */
import { describe, it, expect } from 'vitest';
import { bodiesReachedBy, rootScripts } from './lib/root-manifest.js';

/** The hook the package manager runs after every install-class event. */
const INSTALL_HOOK = 'postinstall';

const SHIM_CORRECTION = 'scripts/exec-runtime-shim.ts';
const TEARDOWN_ENTRY = 'scripts/stack-teardown.ts';
const UNUSED_GATE = 'scripts/lint-unused.ts';
const ENV_WRAPPER = 'scripts/with-env.ts';

/** The destructive compose command the guarded entry point replaced. */
const RAW_TEARDOWN = /compose\s+down/;

/** Whether running `name` reaches a body naming `module`, however it delegates. */
function reaches(name: string, module: string): boolean {
  return bodiesReachedBy(name, rootScripts()).some((body) => body.includes(module));
}

describe('the install hook', () => {
  it('re-applies the runtime-shim correction', () => {
    expect(reaches(INSTALL_HOOK, SHIM_CORRECTION)).toBe(true);
  });

  it('is a script the manifest declares, so the case above reads a body', () => {
    expect(rootScripts()).toHaveProperty(INSTALL_HOOK);
  });
});

describe('the destructive stack teardown', () => {
  it('runs the guarded entry point, inside the environment wrapper', () => {
    // The wrapper is what registers the run claim the guard disregards, and the
    // entry reads its slot from the environment the wrapper loads, so reaching
    // the entry any other way asks the question about the wrong slot.
    const body = rootScripts()['db:down'] ?? '';
    expect(body).toContain(ENV_WRAPPER);
    expect(body).toContain(TEARDOWN_ENTRY);
  });

  it('is the only way a root script tears a compose project down', () => {
    const raw = Object.entries(rootScripts())
      .filter(([, body]) => RAW_TEARDOWN.test(body))
      .map(([name]) => name);

    expect(raw).toEqual([]);
  });
});

describe('the unused-code gate', () => {
  it('runs through the module that loads the environment its scan reads', () => {
    expect(reaches('lint:unused', UNUSED_GATE)).toBe(true);
  });
});
