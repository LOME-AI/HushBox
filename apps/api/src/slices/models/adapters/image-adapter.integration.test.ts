import { describe, expect, it } from 'vitest';
import { InferenceError } from './inference-error.js';
import {
  ROUTING_SUBJECTS,
  SHOULD_RUN,
  consume,
  finishMetadata,
  foreignZdrTag,
  imageRequest,
  listedOutputImagePrice,
  makeMediaCapture,
  useIntegrationProvider,
  useRoutingCatalog,
} from './integration.setup.js';
import { assertValidMediaBytes } from './media-assertions.js';

const IMAGE_TIMEOUT_MS = 60_000;

/** What a leg records when no exposed model carries the behaviour it proves. */
const NO_SUBJECT = 'no subject: no exposed model satisfies this proof’s predicate';

/**
 * Image inference through the {@link useIntegrationProvider} env derivation:
 * the deterministic mock locally (a real decodable PNG), real OpenRouter with
 * record-on-miss cassettes in CI-vitest (evidence recorded via the factory
 * wrapper). Each subject is derived from the catalog the suite normalizes at
 * run time, so no test names a model, and each call is pinned to the ZDR
 * endpoint tags ingestion derived for its subject. The structural media
 * invariants are provider-agnostic and run everywhere; the listed-price and
 * foreign-pin proofs run only against the real gateway, which alone prices and
 * routes the pin.
 */
describe('image adapter — provider inference', () => {
  const provider = useIntegrationProvider();
  const catalog = useRoutingCatalog();

  it(
    'generates an image on the pinned subject, emitting media-start, media-done, and a billed finish',
    { timeout: IMAGE_TIMEOUT_MS },
    async ({ annotate }) => {
      const subject = ROUTING_SUBJECTS.imagePin(await catalog());
      if (subject === undefined) {
        await annotate(NO_SUBJECT);
        return;
      }
      const capture = makeMediaCapture('image');
      const events = await consume(
        provider().infer(imageRequest(subject), subject, { mapFilePart: capture.mapFilePart })
      );

      const kinds = events.map((event) => event.kind);
      expect(kinds).toContain('media-start');
      expect(kinds).toContain('media-done');

      const metadata = finishMetadata(events);
      expect(metadata.finishReason).toBe('stop');
      expect(Number.isFinite(metadata.providerCostUsd)).toBe(true);
      expect(metadata.providerCostUsd ?? 0).toBeGreaterThan(0);

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
   * Real only: the mock's image cost is a constant, so only the Images API can
   * show that `usage.cost` is the listed price of the row the call was billed by.
   */
  it.skipIf(!SHOULD_RUN)(
    'bills one image of a flat-priced model at its listed price',
    { timeout: IMAGE_TIMEOUT_MS },
    async ({ annotate }) => {
      const routing = await catalog();
      const subject = ROUTING_SUBJECTS.imageFlat(routing);
      const listed = subject === undefined ? undefined : listedOutputImagePrice(routing, subject);
      if (subject === undefined || listed === undefined) {
        await annotate(NO_SUBJECT);
        return;
      }
      const capture = makeMediaCapture('image');
      const events = await consume(
        provider().infer(imageRequest(subject), subject, { mapFilePart: capture.mapFilePart })
      );

      expect(finishMetadata(events).providerCostUsd).toBe(Number(listed));
    }
  );

  /**
   * Real only: the mock does not route, so only the gateway can refuse a pin
   * that names none of the model's endpoints. A refusal is a 4xx, which the
   * cassette never records, so this reaches the vendor on every CI run.
   */
  it.skipIf(!SHOULD_RUN)(
    'refuses a call pinned to a ZDR tag that serves no endpoint of the model',
    { timeout: IMAGE_TIMEOUT_MS },
    async ({ annotate }) => {
      const routing = await catalog();
      const subject = ROUTING_SUBJECTS.imagePin(routing);
      const foreign = subject === undefined ? undefined : foreignZdrTag(routing, subject);
      if (subject === undefined || foreign === undefined) {
        await annotate(NO_SUBJECT);
        return;
      }
      const capture = makeMediaCapture('image');

      await expect(
        consume(
          provider().infer(
            imageRequest(subject),
            { ...subject, zdrPin: [foreign] },
            { mapFilePart: capture.mapFilePart }
          )
        )
      ).rejects.toBeInstanceOf(InferenceError);
    }
  );
});
