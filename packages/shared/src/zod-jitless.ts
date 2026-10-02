import { config } from 'zod';

/**
 * Turns off Zod's JIT schema compilation for the realm that imports this.
 *
 * Zod decides whether it may compile by constructing `new Function('')` the
 * first time an object schema is built, inside a try/catch. A
 * Content-Security-Policy that names no `'unsafe-eval'` refuses that
 * construction: Zod falls back to its interpreted path and validation is
 * unaffected, but the browser still reports a policy violation for the attempt,
 * and a console guard promotes one to a failure. `jitless` short-circuits ahead
 * of the probe, so the refused construction never happens.
 *
 * It is a side-effect module with nothing exported, and that is what makes it
 * correct rather than convenient: the probe runs at schema CONSTRUCTION, and a
 * module that builds its schemas at module scope has already constructed them
 * by the time an importer's own body could call anything. So the setting has to
 * be applied by import order — this module evaluated before any module that
 * builds a schema — and an exported function would offer a consumer a way to
 * apply it too late.
 */
config({ jitless: true });
