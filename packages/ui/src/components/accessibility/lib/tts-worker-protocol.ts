/**
 * Message protocol between the main thread (WorkerKokoroTtsService) and
 * the TTS worker thread (tts.worker.ts).
 *
 * Each request from the main thread carries a `requestId` (UUID) so multiple
 * in-flight calls can be correlated with their responses. Audio buffers are
 * sent back as transferables (`postMessage(msg, [msg.audio.buffer])`) so
 * crossing the thread boundary is zero-copy.
 *
 * `workerReady` is the one outbound message that does NOT carry a requestId:
 * it's a per-worker readiness signal so the engine can dispatch the next
 * queued sentence to this worker. The engine identifies the source worker
 * via the message listener's closure, not via the payload.
 */

import type { TtsVoice } from './tts-engine';

export type WorkerInbound =
  | { type: 'load'; requestId: string }
  | { type: 'warmup'; requestId: string; voice: TtsVoice }
  | { type: 'speak'; requestId: string; text: string; voice: TtsVoice }
  | { type: 'cancel'; requestId: string };

export type WorkerOutbound =
  | { type: 'loadProgress'; requestId: string; loaded: number; total: number }
  | { type: 'loadDone'; requestId: string }
  | { type: 'loadError'; requestId: string; message: string }
  | { type: 'warmupDone'; requestId: string }
  | { type: 'warmupError'; requestId: string; message: string }
  | { type: 'speakReady'; requestId: string; audio: Float32Array; samplingRate: number }
  | { type: 'speakError'; requestId: string; message: string }
  | { type: 'workerReady' };

const OUTBOUND_TYPES_WITH_REQUEST_ID: ReadonlySet<string> = new Set([
  'loadProgress',
  'loadDone',
  'loadError',
  'warmupDone',
  'warmupError',
  'speakReady',
  'speakError',
]);

const OUTBOUND_TYPES_WITHOUT_REQUEST_ID: ReadonlySet<string> = new Set(['workerReady']);

export function isWorkerOutbound(value: unknown): value is WorkerOutbound {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { type?: unknown; requestId?: unknown };
  if (typeof v.type !== 'string') return false;
  if (OUTBOUND_TYPES_WITHOUT_REQUEST_ID.has(v.type)) return true;
  if (!OUTBOUND_TYPES_WITH_REQUEST_ID.has(v.type)) return false;
  return typeof v.requestId === 'string';
}
