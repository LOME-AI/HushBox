// What a hook may spend, and it is a larger number rather than a cleverer
// instrument. Absent it a hook is measured against the runner's 10s default, a
// number sized for a host running one suite. The shape that needs more is a
// hook waiting on a cold child boot: across a batch of ten concurrent
// cold-boot runs the median such hook took upward of eight seconds and the
// slowest thirteen, so the default fails roughly one of them in ten with
// nothing wrong. Measured under that same load, a hook that only makes a
// directory peaked just under two seconds and one that reaps a signalled child
// just under two and a half — this budget is not sized for those. Bounding
// waiting is all it does; no decision about whether anything is true reads it.
// The cost, paid deliberately: a genuinely wedged hook takes three times as
// long to surface. Worth it, because a budget sized for an idle host turns
// ordinary load into a failure a reader cannot tell from a real one.
// A floor rather than an override — a file whose hooks additionally wait on a
// fixture becoming ready declares its own larger number, and the number a hook
// declares is the one that measures it.
// A module of its own, with no top-level work, because some importers cannot
// load the shared vitest config: the worker-pool projects cannot merge it (its
// setup files run node-only code that workerd cannot execute), and a browser-
// environment test cannot evaluate its top-level loads. Each takes the same
// number by importing it rather than by spelling a second one.
export const HOOK_TIMEOUT_MS = 30_000;
