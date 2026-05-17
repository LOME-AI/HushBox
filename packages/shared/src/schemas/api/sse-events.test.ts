import { describe, it, expect } from 'vitest';
import { doneEventDataSchema } from './sse-events.js';

describe('doneEventDataSchema', () => {
  it('parses the actual image done payload emitted by serializeMediaContentItem', () => {
    // Mirrors `serializeMediaContentItem` in apps/api/src/lib/stream-pipeline.ts:
    // media items omit `encryptedBlob` and `storageKey`. The wire shape is
    // smaller than `contentItemResponseSchema` (which is the read-endpoint
    // shape) — done events deliver only what the live patch needs.
    const wirePayload = {
      userMessageId: 'u-1',
      assistantMessageId: 'a-1',
      userSequence: 1,
      aiSequence: 2,
      epochNumber: 1,
      cost: '0.01',
      models: [
        {
          modelId: 'google/imagen-4.0-fast-generate-001',
          assistantMessageId: 'a-1',
          aiSequence: 2,
          cost: '0.01',
          wrappedContentKey: 'BASE64_WRAP',
          contentItems: [
            {
              id: 'ci-1',
              contentType: 'image' as const,
              position: 0,
              downloadUrl: 'https://r2/presigned',
              mimeType: 'image/png',
              sizeBytes: 12_345,
              width: 1024,
              height: 1024,
              durationMs: null,
              modelName: 'google/imagen-4.0-fast-generate-001',
              cost: '0.01',
              isSmartModel: false,
            },
          ],
        },
      ],
    };

    expect(doneEventDataSchema.safeParse(wirePayload).success).toBe(true);
  });

  it('parses the actual text done payload emitted by serializeTextContentItem', () => {
    // `serializeTextContentItem` omits storageKey / mimeType / sizeBytes /
    // width / height / durationMs — text rows on the wire carry only the
    // base64 encryptedBlob plus the shared metadata fields.
    const wirePayload = {
      userMessageId: 'u-1',
      assistantMessageId: 'a-1',
      userSequence: 1,
      aiSequence: 2,
      epochNumber: 1,
      cost: '0.01',
      models: [
        {
          modelId: 'openai/gpt-4o',
          assistantMessageId: 'a-1',
          aiSequence: 2,
          cost: '0.01',
          wrappedContentKey: 'BASE64_WRAP',
          contentItems: [
            {
              id: 'ci-1',
              contentType: 'text' as const,
              position: 0,
              encryptedBlob: 'BASE64_CIPHERTEXT',
              modelName: 'openai/gpt-4o',
              cost: '0.01',
              isSmartModel: false,
            },
          ],
        },
      ],
    };

    expect(doneEventDataSchema.safeParse(wirePayload).success).toBe(true);
  });

  it('still accepts the trial-chat empty done payload', () => {
    expect(doneEventDataSchema.safeParse({}).success).toBe(true);
  });
});
