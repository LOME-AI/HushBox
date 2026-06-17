/**
 * Builds the SSE wire frames the real `use-chat-stream` consumer expects, so a
 * director-driven "send" streams a canned reply through the genuine
 * token-by-token render path. The client adopts `start.models[].assistantMessageId`
 * as authoritative, so the same id is reused in `model:done`.
 */

export interface SseTurnParams {
  readonly userMessageId: string;
  readonly modelId: string;
  readonly assistantMessageId: string;
  readonly content: string;
  /** Characters per `token` frame. */
  readonly chunkSize?: number;
}

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function buildSseTurnFrames(params: SseTurnParams): string[] {
  const { userMessageId, modelId, assistantMessageId, content, chunkSize = 18 } = params;
  const frames: string[] = [
    frame('start', { userMessageId, models: [{ modelId, assistantMessageId }] }),
  ];
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
