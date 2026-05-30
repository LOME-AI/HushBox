/**
 * Number of Android emulator containers to run in parallel for `pnpm mobile:test`.
 * Each emulator gets its own container, ADB port, and a disjoint subset of
 * the Maestro flows. Scale up to reduce wall-clock time at the cost of host
 * CPU/RAM; budtmo emulators need ~1.5-2 vCPU and ~2 GB RAM each, plus KVM.
 *
 * The CI runner (blacksmith-4vcpu-ubuntu-2404) tops out around 2.
 */
export const SHARDS = 2;
