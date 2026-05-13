import { describe, expect, it } from 'vitest';
import { ALLOWED_MEDIA_MIME_TYPES, DEFAULT_MIME_TYPE_BY_MODALITY } from './message-shares.js';

describe('DEFAULT_MIME_TYPE_BY_MODALITY', () => {
  // The `as const satisfies Record<..., AllowedMediaMimeType>` clause already
  // enforces this at compile time; this is the runtime belt-and-suspenders
  // guarding against anyone widening the type with `as` casts in the future.
  it('every default value passes the ALLOWED_MEDIA_MIME_TYPES allowlist', () => {
    for (const mime of Object.values(DEFAULT_MIME_TYPE_BY_MODALITY)) {
      expect(ALLOWED_MEDIA_MIME_TYPES.safeParse(mime).success).toBe(true);
    }
  });

  it('covers every non-text modality', () => {
    // Hardcoded expected set (instead of sorting keys) avoids the
    // unicorn/no-array-sort + sonarjs/no-alphabetical-sort rules and is
    // also clearer: the schema must cover exactly these three modalities.
    expect(new Set(Object.keys(DEFAULT_MIME_TYPE_BY_MODALITY))).toEqual(
      new Set(['image', 'video', 'audio'])
    );
  });
});
