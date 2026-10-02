import { z } from 'zod';
import { dayStamp } from '@hushbox/docket/types';
import { FINDING_ACTIONS } from '../finding-actions.ts';
import { buildTransition } from './action-transitions.ts';
import { parseUrl, readJsonBody, sendJson } from './http.ts';
import type { FindingAction } from '../finding-actions.ts';
import type {
  AuditService,
  ServiceErrorCode,
  ServiceResult,
  WriteEffect,
} from './audit-service.ts';
import type { EventHub } from './events.ts';
import type { BodyStream, RequestLike, ResponseLike } from './http.ts';

/** An SSE client is only reachable while its connection is open. */
export interface StreamingRequest extends RequestLike {
  on?(event: 'close', listener: () => void): unknown;
  /** True once the connection is gone, however long before it went. */
  readonly destroyed?: boolean;
}

export type ApiRequest = StreamingRequest & BodyStream;

interface RouterOptions {
  readonly service: AuditService;
  readonly events: EventHub;
  readonly now?: () => string;
}

export interface Router {
  /** Resolves true when the request was an API request and was answered. */
  handle(req: ApiRequest, res: ResponseLike): Promise<boolean>;
}

/**
 * `locked` is a refusal, not a failure: another writer holds the file and the
 * correct client behavior is to retry, so it carries 503 and `retryable` rather
 * than joining the 4xx family the console reports as an error.
 */
const STATUS_BY_CODE: Record<ServiceErrorCode, number> = {
  'not-found': 404,
  conflict: 409,
  'invalid-transition': 409,
  invalid: 400,
  'unknown-question': 400,
  'not-owned': 400,
  unreadable: 500,
  locked: 503,
};

const AUDIT_ROUTE = /^\/api\/audits\/([^/]+)\/([a-z]+)$/;
const FINDING_ROUTE = /^\/api\/audits\/([^/]+)\/finding\/([^/]+)\/([a-z]+)$/;

const UNDO = z.object({ token: z.string().min(1) });

function sendError(res: ResponseLike, status: number, code: string, message: string): void {
  sendJson(res, status, {
    error: { code, message, ...(code === 'locked' ? { retryable: true } : {}) },
  });
}

/**
 * What a refused write reads as, written here rather than forwarded from the
 * store: the store's own messages name the absolute path of the finding or of
 * the lock beside it, which is the operator's host layout and is nothing a
 * reader can act on. That detail stays in the console's log, where whoever is
 * debugging the write already looks.
 */
const CAUSE_BY_CODE: Record<Exclude<ServiceErrorCode, 'not-found'>, string> = {
  locked: 'Another writer holds this file, so try again in a moment.',
  unreadable: 'The finding could not be read or written. The console log has the detail.',
  conflict: 'This finding changed on disk since you loaded it, so reload before writing again.',
  'invalid-transition': 'The finding is not in a state that allows this.',
  invalid: 'The change would leave the finding invalid.',
  'not-owned': 'One of those fields belongs to a different writer.',
  'unknown-question': 'That question is no longer there.',
};

interface RefusalCopy {
  /** Leads every refusal, because the outcome is what the reader needs first. */
  readonly lead: string;
  /** `not-found` means something different per route, so each names its own. */
  readonly missing: string;
}

const WRITE_REFUSAL: RefusalCopy = {
  lead: 'Nothing was saved.',
  missing: 'That finding is not in this audit.',
};

const UNDO_REFUSAL: RefusalCopy = {
  lead: 'Nothing was restored.',
  missing: 'That undo is spent or unknown.',
};

const INTERNAL_MESSAGE =
  'The console hit an unexpected error and did not finish. Its log has the detail, and a reload is the way back.';

/**
 * The answer to a defect, which no route can describe: whether the write landed
 * is genuinely unknown, so the copy claims only what is certain and points at
 * the log. Without it the throw escapes as an unhandled rejection and ends the
 * console, taking every undo token it holds in memory with it.
 */
export function sendInternalError(res: ResponseLike): void {
  sendError(res, 500, 'internal', INTERNAL_MESSAGE);
}

function sendResult(
  res: ResponseLike,
  outcome: ServiceResult<WriteEffect>,
  copy: RefusalCopy
): void {
  if (outcome.ok) {
    sendJson(res, 200, outcome.value);
    return;
  }
  const { code } = outcome.error;
  sendError(
    res,
    STATUS_BY_CODE[code],
    code,
    `${copy.lead} ${code === 'not-found' ? copy.missing : CAUSE_BY_CODE[code]}`
  );
}

/** `null` means the body was rejected and the response is already written. */
function validate<TSchema extends z.ZodType>(
  res: ResponseLike,
  schema: TSchema,
  body: unknown
): z.infer<TSchema> | null {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  sendError(res, 400, 'invalid', parsed.error.issues.map((issue) => issue.message).join('; '));
  return null;
}

async function readBody(
  req: ApiRequest,
  res: ResponseLike
): Promise<Record<string, unknown> | null> {
  const body = await readJsonBody(req);
  if (body.ok) return body.value;
  sendError(res, 400, 'invalid', `the request body is ${body.error}`);
  return null;
}

function requireMethod(res: ResponseLike, actual: string, expectedMethod: string): boolean {
  if (actual === expectedMethod) return true;
  sendError(res, 405, 'method-not-allowed', `this route is a ${expectedMethod}`);
  return false;
}

function positiveInteger(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : null;
}

type Clock = () => string;

/**
 * A capture group of a matched route. None of the route patterns makes a group
 * optional, so the absent case `exec`'s type carries cannot arise.
 */
function group(match: RegExpExecArray, index: number): string {
  return match[index] ?? '';
}

/**
 * Whether a request is the event stream, which the idle window does not count as
 * activity: a forgotten background tab holds one open forever, and the point of
 * the window is that such a tab still lets the server die. Published from here
 * because this file owns the route shape the answer depends on.
 */
export function isEventStream(rawUrl: string | undefined): boolean {
  const match = AUDIT_ROUTE.exec(parseUrl(rawUrl).pathname);
  return match !== null && group(match, 2) === 'events';
}

/**
 * A name whose escapes are malformed is one no audit can carry, so it is refused
 * along with every other name off the allowlist rather than thrown from.
 */
function decodeSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** What an audit-addressed read is handed once its audit name is admitted. */
interface AuditedRead {
  readonly req: ApiRequest;
  readonly res: ResponseLike;
  readonly params: URLSearchParams;
  readonly audit: string;
}

function isAction(value: string): value is FindingAction {
  return Object.hasOwn(FINDING_ACTIONS, value);
}

/**
 * The console's HTTP surface. It holds no domain logic: every mutation is a
 * store transition applied through the service, and every refusal keeps the
 * store's own code so the client can tell a race from a typo from a held lock.
 */
export function createRouter({ service, events, now }: RouterOptions): Router {
  const at: Clock = now ?? ((): string => dayStamp(new Date()));

  /**
   * The subscription is what holds this audit's watcher open, so nothing but
   * the release below closes it: the hook goes on before the directory
   * resolves, and a connection that went before the hook was even attached is
   * caught afterwards by the request's own state.
   */
  async function openEventStream(
    req: StreamingRequest,
    res: ResponseLike,
    audit: string
  ): Promise<void> {
    let release: (() => void) | null = null;
    let closed = false;
    const clientHasGone = (): boolean => closed || req.destroyed === true;
    req.on?.('close', () => {
      closed = true;
      release?.();
    });

    const auditDir = await service.auditDir(audit);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.write(': connected\n\n');

    release = events.subscribe(auditDir, (event) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });
    if (clientHasGone()) release();
  }

  /**
   * The audit name is the one path segment that arrives from the wire and
   * reaches a `path.join` in the store, so it is admitted by membership in the
   * served set before any path is built from it. The check is on the decoded
   * segment because `%2F` survives URL parsing intact: `..%2F..%2Fetc` is a
   * single segment that decodes to a climb out of the audits root, and only an
   * allowlist refuses that along with every other spelling of it.
   */
  async function admit(res: ResponseLike, raw: string): Promise<string | null> {
    const name = decodeSegment(raw);
    if (name !== null) {
      const served = await service.auditNames();
      if (served.includes(name)) return name;
    }
    sendError(res, 404, 'not-found', 'no audit by that name in this repository');
    return null;
  }

  async function serveSource(
    res: ResponseLike,
    params: URLSearchParams,
    audit: string
  ): Promise<void> {
    const requested = params.get('path');
    const start = positiveInteger(params.get('start'));
    const end = positiveInteger(params.get('end'));
    if (requested === null || requested === '' || start === null) {
      sendError(res, 400, 'invalid', 'path and a positive start line are required');
      return;
    }

    const outcome = await service.source(
      end === null ? { path: requested, start } : { path: requested, start, end },
      audit
    );
    if (outcome.ok) {
      sendJson(res, 200, outcome.value);
      return;
    }
    sendError(res, 400, outcome.error, `the source request was refused: ${outcome.error}`);
  }

  async function serveBrief(
    res: ResponseLike,
    params: URLSearchParams,
    audit: string
  ): Promise<void> {
    const ids = (params.get('ids') ?? '').split(',').filter((id) => id !== '');
    if (ids.length === 0) {
      sendError(res, 400, 'invalid', 'name at least one finding in ids');
      return;
    }

    const outcome = await service.brief(ids, audit);
    if (outcome.ok) {
      sendJson(res, 200, { text: outcome.value });
      return;
    }
    sendError(res, STATUS_BY_CODE[outcome.error.code], outcome.error.code, outcome.error.message);
  }

  /**
   * The reads that name no audit. `/api/audit` is how a client with nothing
   * in its address bar learns which audit it gets and what else it could ask
   * for, so it is the one snapshot served from the default.
   */
  const reads: Record<string, (req: ApiRequest, res: ResponseLike) => Promise<void> | void> = {
    '/api/ping': (_req, res) => {
      sendJson(res, 200, { ok: true });
    },
    '/api/audit': async (_req, res) => {
      sendJson(res, 200, await service.snapshot());
    },
  };

  const audited: Record<string, (context: AuditedRead) => Promise<void> | void> = {
    audit: async ({ res, audit }) => {
      sendJson(res, 200, await service.snapshot(audit));
    },
    brief: async ({ res, params, audit }) => serveBrief(res, params, audit),
    events: async ({ req, res, audit }) => openEventStream(req, res, audit),
    source: async ({ res, params, audit }) => serveSource(res, params, audit),
  };

  async function applyFindingRoute(
    req: ApiRequest,
    res: ResponseLike,
    route: {
      readonly method: string;
      readonly rawId: string;
      readonly action: string;
      readonly audit: string;
    }
  ): Promise<void> {
    const { method, rawId, action, audit } = route;
    if (!isAction(action)) {
      sendError(res, 404, 'not-found', `no finding action named ${action}`);
      return;
    }
    if (!requireMethod(res, method, 'POST')) return;

    const body = await readBody(req, res);
    if (body === null) return;
    const input = validate(res, FINDING_ACTIONS[action].schema, body);
    if (input === null) return;

    const base = typeof body['base'] === 'string' ? body['base'] : undefined;
    sendResult(
      res,
      await service.write(
        decodeURIComponent(rawId),
        buildTransition(action, input, at()),
        base,
        audit
      ),
      WRITE_REFUSAL
    );
  }

  async function applyUndo(req: ApiRequest, res: ResponseLike): Promise<void> {
    const body = await readBody(req, res);
    if (body === null) return;
    const input = validate(res, UNDO, body);
    if (input === null) return;
    sendResult(res, await service.undo(input.token), UNDO_REFUSAL);
  }

  /** The audit-addressed routes; `false` leaves the path to the ones that name none. */
  async function serveAudited(
    req: ApiRequest,
    res: ResponseLike,
    incoming: {
      readonly params: URLSearchParams;
      readonly method: string;
      readonly pathname: string;
    }
  ): Promise<boolean> {
    const { params, method, pathname } = incoming;
    const findingRoute = FINDING_ROUTE.exec(pathname);
    if (findingRoute !== null) {
      const audit = await admit(res, group(findingRoute, 1));
      if (audit !== null) {
        await applyFindingRoute(req, res, {
          method,
          audit,
          rawId: group(findingRoute, 2),
          action: group(findingRoute, 3),
        });
      }
      return true;
    }

    const auditRoute = AUDIT_ROUTE.exec(pathname);
    if (auditRoute === null) return false;

    const name = group(auditRoute, 2);
    const read = Object.hasOwn(audited, name) ? audited[name] : undefined;
    if (read === undefined) {
      sendError(res, 404, 'not-found', `no route ${pathname}`);
      return true;
    }
    const audit = await admit(res, group(auditRoute, 1));
    if (audit !== null && requireMethod(res, method, 'GET')) {
      await read({ req, res, params, audit });
    }
    return true;
  }

  return {
    async handle(req, res) {
      const { pathname, params } = parseUrl(req.url);
      if (!pathname.startsWith('/api/')) return false;

      const method = req.method ?? 'GET';
      if (await serveAudited(req, res, { params, method, pathname })) return true;

      const read = reads[pathname];
      if (read !== undefined) {
        if (requireMethod(res, method, 'GET')) await read(req, res);
        return true;
      }

      if (pathname === '/api/undo') {
        if (requireMethod(res, method, 'POST')) await applyUndo(req, res);
        return true;
      }

      sendError(res, 404, 'not-found', `no route ${pathname}`);
      return true;
    },
  };
}
