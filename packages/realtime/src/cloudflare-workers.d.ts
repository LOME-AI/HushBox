// Minimal ambient shim for the Cloudflare Workers runtime surface the two
// thin-shell Durable Object classes touch. It exists so a DOM-lib consumer
// (apps/web, which transitively type-checks this package's source through the
// typed API client) can resolve `cloudflare:workers` and the DO globals
// WITHOUT pulling the full `@cloudflare/workers-types`, whose DOM redefinitions
// (Response, Element, …) are incompatible with the browser lib. Only
// workers-specific names are declared here, plus additive augmentations of
// DOM interfaces — never a DOM redefinition — so a consumer's DOM types stay
// intact. The package's own type-check uses the real workers-types.

declare module 'cloudflare:workers' {
  // Fidelity here is asymmetric, deliberately. The member *types* differ from the
  // platform's — rebinding Request/Response/WebSocket to the DOM vocabulary is this
  // shim's whole purpose. The member *list* must not differ: a base member a shell
  // overrides but this class omits makes the `override` modifier illegal (TS4113) in
  // every consumer that resolves the runtime through here, while the real types
  // demand it (TS4114) in the consumers that load them — a contradiction no flag
  // scoping can resolve. A drift detector compares the two lists and reddens the
  // build when they part. Handler parameter lists are therefore copied at the
  // platform's arity even where a shell implements a narrower one.
  export abstract class DurableObject<Env = unknown> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    fetch(request: Request): Response | Promise<Response>;
    alarm(): void | Promise<void>;
    webSocketMessage?(ws: WebSocket, message: string | ArrayBuffer): void | Promise<void>;
    webSocketClose?(
      ws: WebSocket,
      code: number,
      reason: string,
      wasClean: boolean,
    ): void | Promise<void>;
    webSocketError?(ws: WebSocket, error: unknown): void | Promise<void>;
  }
}

interface DurableObjectId {
  readonly name?: string;
  toString(): string;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
}

interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  getWebSockets(tag?: string): WebSocket[];
  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair): void;
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  // workerd provides waitUntil on DO state (extends the response's lifetime past
  // return so a post-response flush cannot be dropped mid-flight); the shell uses
  // it to carry RoomCore's terminal duties. Declared here because a DOM-lib
  // consumer resolves DurableObjectState through this shim, not the real
  // @cloudflare/workers-types (which does declare it) — omitting it breaks those
  // consumers' type-check. Promise<unknown> merges cleanly with the real type.
  waitUntil(promise: Promise<unknown>): void;
}

interface DurableObjectStub {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface AnalyticsEngineDataset {
  writeDataPoint(event?: {
    indexes?: (ArrayBuffer | string)[];
    doubles?: number[];
    blobs?: (ArrayBuffer | string | null)[];
  }): void;
}

declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
}

declare const WebSocketPair: {
  new (): { 0: WebSocket; 1: WebSocket };
};

interface WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface ResponseInit {
  webSocket?: WebSocket | null;
}
