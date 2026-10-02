import { describe, expect, it } from 'vitest';
import {
  SHOULD_RUN,
  consume,
  finishMetadata,
  makeMediaCapture,
  useIntegrationProvider,
  videoDescriptor,
  videoRequest,
} from './integration.setup.js';
import { assertValidMediaBytes } from './media-assertions.js';
import { createCassetteStore } from './cassette/cassette-store.js';
import { recordedMediaCostUsd } from './cassette/recorded-cost.js';
import { CASSETTE_ROOT } from './resolve-model-provider.js';

const VIDEO_TIMEOUT_MS = 300_000;

/**
 * Video inference through the {@link useIntegrationProvider} env derivation:
 * the deterministic mock locally (a minimal valid MP4), real OpenRouter with
 * record-on-miss cassettes in CI-vitest (submit → poll → download inside the
 * video adapter; evidence recorded via the factory wrapper). Video carries an
 * inline cost and a generation id on its finish, so both are asserted. Those
 * bodies are provider-agnostic and run everywhere, except the one comparing the
 * billed cost against the recording that carried it, which has nothing to read
 * where no real response was recorded.
 */
describe('video adapter — provider inference', () => {
  const provider = useIntegrationProvider();

  it(
    'generates a video emitting media-start, media-done, and a finish with cost and generation id',
    { timeout: VIDEO_TIMEOUT_MS },
    async () => {
      const capture = makeMediaCapture('video');
      const events = await consume(
        provider().infer(videoRequest(), videoDescriptor(), { mapFilePart: capture.mapFilePart })
      );

      const kinds = events.map((event) => event.kind);
      expect(kinds).toContain('media-start');
      expect(kinds).toContain('media-done');

      const metadata = finishMetadata(events);
      expect(metadata.generationId).toBeDefined();
      expect(metadata.generationId?.length ?? 0).toBeGreaterThan(0);
      expect(metadata.providerCostUsd).toBeDefined();

      expect(capture.captured.length).toBeGreaterThan(0);
      const bytes = capture.captured[0];
      if (bytes === undefined) throw new Error('expected captured video bytes');
      // Magic-byte + size-bound validation (bounds ported from the legacy
      // video integration suite): the provider must return decodable
      // MP4/WebM bytes, not merely a non-empty buffer.
      assertValidMediaBytes(bytes, ['video/mp4', 'video/webm'], {
        min: 16,
        max: 50_000_000,
      });
    }
  );

  /**
   * The media read path is its own surface — `openrouter.cost`, with no
   * `.usage` between — so proving the language path proves nothing here. The
   * recording it is compared against is the completed poll, which is the
   * exchange the generation id and the cost both ride on.
   *
   * Both halves are load-bearing. Defined is what fails when the metadata field
   * moves: the extractor yields `undefined`, settlement silently degrades to
   * the catalog estimate, and without this half a vanished field would compare
   * `undefined` to `undefined` and pass. Equality is what fails on a value that
   * is present but is not the charged cost.
   */
  it.skipIf(!SHOULD_RUN)(
    'bills exactly the inline cost the recorded provider response carried',
    { timeout: VIDEO_TIMEOUT_MS },
    async () => {
      const capture = makeMediaCapture('video');
      const events = await consume(
        provider().infer(videoRequest(), videoDescriptor(), { mapFilePart: capture.mapFilePart })
      );

      const metadata = finishMetadata(events);
      const generationId = metadata.generationId;
      if (generationId === undefined) {
        throw new Error('expected a generation id to locate the recording by');
      }
      const recorded = await recordedMediaCostUsd(
        createCassetteStore({ rootDir: CASSETTE_ROOT }),
        generationId
      );

      expect(recorded).toBeDefined();
      expect(metadata.providerCostUsd).toBeDefined();
      expect(metadata.providerCostUsd).toBe(recorded);
    }
  );
});
