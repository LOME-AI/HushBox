import { Readable } from 'node:stream';
import type { ResponseLike } from '../server/http';

interface FakeRequest extends Readable {
  url?: string | undefined;
  method?: string | undefined;
  /** Ends the connection, which is what an SSE client going away looks like. */
  close(): void;
}

export interface FakeResponse extends ResponseLike {
  readonly headers: Record<string, string>;
  readonly chunks: string[];
  ended: boolean;
  body(): string;
  json(): unknown;
}

/**
 * A connect-style request with an optional JSON body. Built on a real `Readable`
 * because that is what a Node `IncomingMessage` is: the body arrives by async
 * iteration and `close` is an event.
 */
export function fakeRequest(method: string, url: string, body?: unknown): FakeRequest {
  const payload = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')];
  const stream = Readable.from(payload) as FakeRequest;
  stream.url = url;
  stream.method = method;
  stream.close = (): void => {
    stream.emit('close');
  };
  return stream;
}

export function fakeResponse(): FakeResponse {
  return {
    statusCode: 0,
    headers: {},
    chunks: [],
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    write(chunk: string) {
      this.chunks.push(chunk);
      return true;
    },
    end(chunk?: string) {
      if (chunk !== undefined) this.chunks.push(chunk);
      this.ended = true;
    },
    body() {
      return this.chunks.join('');
    },
    json(): unknown {
      return JSON.parse(this.body()) as unknown;
    },
  };
}
