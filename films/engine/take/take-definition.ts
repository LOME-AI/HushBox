import { z } from 'zod';

import { FilmRenderError } from '../render/film-error.js';
import { filmDefinitionOf } from '../render/film-module.js';

import type { FilmDefinition } from '../film/spec.js';

/** A take's spec id is its own name, never its composition id, so it is read before the shape check. */
const specIdSchema = z.object({ definition: z.object({ spec: z.object({ id: z.string() }) }) });

function refusal(takeId: string, detail: string, options?: ErrorOptions): FilmRenderError {
  return new FilmRenderError({ filmId: takeId, rule: 'take', detail }, options);
}

/**
 * The `definition` a take's `score.ts` exports, checked for the shape the
 * render pipeline reads, and refused naming the take (its composition id).
 */
export function takeDefinitionOf(takeId: string, exports: unknown): FilmDefinition {
  const parsed = specIdSchema.safeParse(exports);
  if (!parsed.success) {
    throw refusal(takeId, 'score.ts must export a definition whose spec has an id');
  }
  try {
    return filmDefinitionOf(parsed.data.definition.spec.id, exports);
  } catch (error) {
    // `filmDefinitionOf` refuses only by FilmRenderError, which names the spec id; the take is named here.
    throw refusal(takeId, `score.ts: ${String(error)}`, { cause: error });
  }
}
