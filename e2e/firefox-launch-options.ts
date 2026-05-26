// Stability tunings applied to every Playwright Firefox launch in this repo.
// Companion to patches/playwright-core@1.58.2.patch — the patch throttles
// concurrent firefox.launch() calls; these prefs neutralize the GPU/JIT
// codegen path Firefox SIGSEGVs in under high parallelism on headless Linux.
//
// Failure mode (from /var/log/syslog at the time of the crashes):
//   llvmpipe-N[pid]: segfault at <addr> ip <addr> sp <addr> error 14
//   SkiaGPUWorker[pid]: segfault at <addr> ip <addr> sp <addr> error 15
// `ip == sp` + error 14/15 = the CPU jumped into a non-executable page from
// Mesa's llvmpipe rasterizer / Skia GPU worker JIT threads. Disabling WebGL,
// accelerated canvas, and hardware webrender removes that codegen path.
// MOZ_CRASHREPORTER_DISABLE stops a crashed Firefox from forking a
// minidump-writer that races on /tmp; MOZ_DISABLE_RDD_SANDBOX lets the
// remote-data-decoder safely codegen on machines where seccomp+tsync trips.

import type { LaunchOptions } from '@playwright/test';

export const firefoxLaunchOptions: LaunchOptions = {
  firefoxUserPrefs: {
    'webgl.disabled': true,
    'gfx.canvas.accelerated': false,
    'layers.acceleration.disabled': true,
    'gfx.webrender.software': true,
  },
  env: {
    ...process.env,
    MOZ_CRASHREPORTER_DISABLE: '1',
    MOZ_DISABLE_RDD_SANDBOX: '1',
  },
};
