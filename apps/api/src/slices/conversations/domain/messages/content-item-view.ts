import { toBase64 } from '@hushbox/shared';
import type { ContentItemResponse } from '@hushbox/shared';
import type { ContentItemRow } from '../../ports/index.js';

/**
 * The content-item fields common to every read of a content item; each read
 * extends this base with its own additions rather than serving it directly.
 * The declaration lives in `@hushbox/shared`; this annotation is what makes a
 * field rename there a compile error here.
 */
type ContentItemView = ContentItemResponse;

export function contentItemView(row: ContentItemRow): ContentItemView {
  return {
    id: row.id,
    position: row.position,
    contentType: row.contentType,
    mimeType: row.mimeType,
    byteLength: row.sizeBytes,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    encryptedBlob: row.encryptedBlob === null ? null : toBase64(row.encryptedBlob),
  };
}
