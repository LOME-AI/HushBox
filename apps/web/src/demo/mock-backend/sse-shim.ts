/**
 * Builds the SSE wire frames the real `use-chat-stream` consumer expects, so a
 * director-driven "send" streams a canned reply through the genuine
 * token-by-token render path. The client adopts `start.models[].assistantMessageId`
 * as authoritative, so the same id is reused in `model:done`.
 */

/** Media-generation attributes for a turn whose reply is an image/video. */
export interface SseTurnMedia {
  readonly mediaType: 'image' | 'video';
  readonly mimeType: string;
}

export interface SseTurnParams {
  readonly userMessageId: string;
  readonly modelId: string;
  readonly assistantMessageId: string;
  readonly content: string;
  /** Characters per `token` frame. */
  readonly chunkSize?: number;
  /** Present for image/video turns; drives the synthetic generation frames. */
  readonly media?: SseTurnMedia;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Synthetic mid-generation percent (`model:done` is the authoritative 100%). */
const MEDIA_PROGRESS_PERCENT = 50;

export function buildSseTurnFrames(params: SseTurnParams): string[] {
  const { userMessageId, modelId, assistantMessageId, content, chunkSize = 18, media } = params;
  const frames: string[] = [
    frame('start', { userMessageId, models: [{ modelId, assistantMessageId }] }),
  ];
  // A media turn announces generation (so the placeholder reads "Generating
  // image…" with the right shape) and ticks one progress frame before the
  // asset lands, mirroring the real server's pre-gateway media events.
  if (media !== undefined) {
    frames.push(
      frame('model:media:start', {
        modelId,
        assistantMessageId,
        mediaType: media.mediaType,
        mimeType: media.mimeType,
      }),
      frame('model:media:progress', {
        modelId,
        assistantMessageId,
        percent: MEDIA_PROGRESS_PERCENT,
      })
    );
  }
  for (let index = 0; index < content.length; index += chunkSize) {
    frames.push(frame('token', { modelId, content: content.slice(index, index + chunkSize) }));
  }
  frames.push(frame('model:done', { modelId, assistantMessageId }), frame('done', {}));
  return frames;
}

/**
 * A `text/event-stream`-ready byte stream that emits frames with an inter-frame
 * delay (so the reply "types out"), plus a one-time `leadDelayMs` pause after the
 * `start` frame — used to simulate image/video generation time, during which the
 * client shows its "Generating…" state before the media lands.
 */
export function createSseStream(
  frames: string[],
  delayMs: number,
  leadDelayMs = 0
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index >= frames.length) {
        controller.close();
        return;
      }
      if (delayMs > 0 && index > 0) await sleep(delayMs);
      // One-time generation pause between `start` and the first reply frame.
      if (leadDelayMs > 0 && index === 1) await sleep(leadDelayMs);
      controller.enqueue(encoder.encode(frames[index] ?? ''));
      index += 1;
    },
  });
}
