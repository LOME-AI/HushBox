import { describe, expect, it } from 'vitest';
import {
  SHOULD_RUN,
  consume,
  finishMetadata,
  imageDescriptor,
  imageRequest,
  makeMediaCapture,
  useIntegrationProvider,
} from './integration.setup.js';
import { assertValidMediaBytes } from './media-assertions.js';

const IMAGE_TIMEOUT_MS = 60_000;

/**
 * Image inference through the {@link useIntegrationProvider} env derivation:
 * the deterministic mock locally (a real decodable PNG), real OpenRouter with
 * record-on-miss cassettes in CI-vitest (evidence recorded via the factory
 * wrapper). Image emits no inline cost — settlement uses the deterministic
 * estimate. The structural media invariants are provider-agnostic and run
 * everywhere; the absent-cost assertion runs only against a real response, for
 * the reason stated on it.
 */
describe('image adapter — provider inference', () => {
  const provider = useIntegrationProvider();

  it(
    'generates an image emitting media-start, media-done, and a terminal finish',
    { timeout: IMAGE_TIMEOUT_MS },
    async () => {
      const capture = makeMediaCapture('image');
      const events = await consume(
        provider().infer(imageRequest(), imageDescriptor(), { mapFilePart: capture.mapFilePart })
      );

      const kinds = events.map((event) => event.kind);
      expect(kinds).toContain('media-start');
      expect(kinds).toContain('media-done');

      const metadata = finishMetadata(events);
      expect(metadata.finishReason).toBe('stop');

      expect(capture.captured.length).toBeGreaterThan(0);
      const bytes = capture.captured[0];
      if (bytes === undefined) throw new Error('expected captured image bytes');
      // Magic-byte + size-bound validation (bounds ported from the legacy
      // image integration suite): the provider must return decodable
      // PNG/JPEG/WebP bytes, not merely a non-empty buffer.
      assertValidMediaBytes(bytes, ['image/png', 'image/jpeg', 'image/webp'], {
        min: 32,
        max: 10_000_000,
      });
    }
  );

  /**
   * Image is the one modality settlement charges at its catalog estimate, and
   * what this pins is the adapter half of that: driven over a real response,
   * the image adapter still finishes with no cost term, so settlement still
   * estimates.
   *
   * It does not watch the provider, and cannot: `image-adapter.ts` builds its
   * finish without a cost argument at all, and the builder in
   * `media-generate.ts` omits the key when that argument is absent — so an
   * inline cost appearing in OpenRouter's images API would leave this green
   * while the estimate silently became the wrong charge. Nothing here or
   * anywhere else watches for that day.
   *
   * Gated to the real provider because the mock's image branch hardcodes the
   * same absence, which its own suite already pins — asserting it here under the
   * mock would prove the mock, not the adapter.
   */
  it.skipIf(!SHOULD_RUN)(
    'carries no inline provider cost, leaving settlement on the catalog estimate',
    { timeout: IMAGE_TIMEOUT_MS },
    async () => {
      const capture = makeMediaCapture('image');
      const events = await consume(
        provider().infer(imageRequest(), imageDescriptor(), { mapFilePart: capture.mapFilePart })
      );

      expect(finishMetadata(events).providerCostUsd).toBeUndefined();
    }
  );
});
