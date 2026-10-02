import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  applyWrite,
  expectedHash,
  formatBrief,
  indexRepositoryFiles,
  listAuditNames,
  loadAudit,
  readSource,
  renderFinding,
  resolveAuditDir,
  undoWrite,
} from '@hushbox/docket';
import { BRIEF_SEPARATOR } from '../cli/list.ts';
import type {
  Audit,
  Finding,
  FindingJson,
  PathIndex,
  SourceOutcome,
  Transition,
  ValidationEntry,
  WriteError,
  WriteErrorCode,
} from '@hushbox/docket';

export interface Snapshot {
  readonly audit: Audit;
  /** The audit directory name, which is its date. */
  readonly name: string;
  readonly findings: readonly FindingJson[];
  readonly validation: readonly ValidationEntry[];
  readonly audits: readonly string[];
}

export interface WriteEffect {
  readonly finding: FindingJson;
  /** Spend this at the undo route to put the previous bytes back. */
  readonly undoToken: string;
}

export type ServiceErrorCode = WriteErrorCode | 'not-found';

export interface ServiceError {
  readonly code: ServiceErrorCode;
  readonly message: string;
  readonly fields?: readonly string[];
}

export type ServiceResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly error: ServiceError };

interface AuditServiceOptions {
  readonly repoRoot: string;
  /** Defaults to `<repoRoot>/docs/audits`. */
  readonly auditsRoot?: string;
  /** The audit served to a caller that names none. */
  readonly defaultAudit?: string | null;
  /** Bounds the undo history one long console session accumulates. */
  readonly maxUndoTokens?: number;
}

/**
 * Every audit-scoped method acts on the audit it is given and falls back to the
 * served default when given none. None of them checks that name: it reaches
 * `path.join` inside the store, so a caller taking one off the wire admits it
 * against {@link AuditService.auditNames} first.
 */
export interface AuditService {
  /** The audits this console can serve, newest first. */
  auditNames(): Promise<readonly string[]>;
  snapshot(audit?: string): Promise<Snapshot>;
  /** The named findings as `--list --brief` writes them, in the order asked for. */
  brief(ids: readonly string[], audit?: string): Promise<ServiceResult<string>>;
  /**
   * `base` is the file version the caller's copy came from. It names the state
   * the write was decided on, and the fields the write turns out to touch are
   * hashed as that version had them, so only a same-field race is refused.
   */
  write(
    id: string,
    transition: Transition,
    base?: string,
    audit?: string
  ): Promise<ServiceResult<WriteEffect>>;
  undo(token: string): Promise<ServiceResult<WriteEffect>>;
  source(
    request: { path: string; start: number; end?: number },
    audit?: string
  ): Promise<SourceOutcome>;
  auditDir(audit?: string): Promise<string>;
}

interface CacheEntry {
  readonly hash: string;
  readonly json: FindingJson;
}

/**
 * How many versions of one finding stay resolvable. Bounding this per path
 * rather than across the console is what keeps a long ruling session working: a
 * single budget spent on the findings being written would evict the opening
 * snapshot's versions first, and every untouched finding on the reader's screen
 * would then be refused for a race that never happened.
 */
const VERSIONS_PER_FINDING = 3;

function notFound(message: string): ServiceError {
  return { code: 'not-found', message };
}

function serviceError(error: WriteError): ServiceError {
  return {
    code: error.code,
    message: error.message,
    ...(error.fields === undefined ? {} : { fields: error.fields }),
  };
}

/**
 * The console's view of the audits on disk. Two caches earn their place: the
 * repository path index (a full tree walk, needed once per process to resolve
 * citations) and the per-finding render, keyed by the file hash so a changed
 * file re-renders and an unchanged one costs nothing, whatever the audit's size.
 */
export function createAuditService(options: AuditServiceOptions): AuditService {
  const auditsRoot = options.auditsRoot ?? path.join(options.repoRoot, 'docs', 'audits');
  const servedByDefault = options.defaultAudit ?? undefined;
  const maxUndoTokens = options.maxUndoTokens ?? 500;
  const renders = new Map<string, CacheEntry>();
  const versions = new Map<string, Map<string, Finding>>();
  const undos = new Map<string, { path: string; previousText: string; writtenHash: string }>();
  let index: PathIndex | null = null;

  async function pathIndex(): Promise<PathIndex> {
    index ??= await indexRepositoryFiles(options.repoRoot);
    return index;
  }

  function mintUndo(filePath: string, previousText: string, writtenHash: string): string {
    const token = randomUUID();
    undos.set(token, { path: filePath, previousText, writtenHash });
    for (const oldest of undos.keys()) {
      if (undos.size <= maxUndoTokens) break;
      undos.delete(oldest);
    }
    return token;
  }

  /**
   * Every version the console hands out is kept here, because a client can only
   * name a version it was served. Recorded where the render happens, which is
   * the one place holding both the hash the client will quote back and the
   * parsed finding that hash stands for.
   */
  function remember(filePath: string, hash: string, finding: Finding): void {
    const byHash = versions.get(filePath) ?? new Map<string, Finding>();
    versions.set(filePath, byHash);
    byHash.set(hash, finding);
    for (const oldest of byHash.keys()) {
      if (byHash.size <= VERSIONS_PER_FINDING) break;
      byHash.delete(oldest);
    }
  }

  function render(
    finding: Finding,
    filePath: string,
    hash: string,
    resolved: PathIndex
  ): FindingJson {
    remember(filePath, hash, finding);
    const cached = renders.get(filePath);
    if (cached?.hash === hash) return cached.json;

    const json = renderFinding(finding, {
      index: resolved,
      path: path.relative(options.repoRoot, filePath),
      hash,
    });
    renders.set(filePath, { hash, json });
    return json;
  }

  function load(audit: string | undefined): ReturnType<typeof loadAudit> {
    return loadAudit(auditsRoot, audit ?? servedByDefault);
  }

  async function snapshot(audit?: string): Promise<Snapshot> {
    const loaded = await load(audit);
    const resolved = await pathIndex();
    return {
      audit: loaded.audit,
      name: loaded.name,
      findings: loaded.findings.map((entry) =>
        render(entry.finding, entry.path, entry.hash, resolved)
      ),
      validation: loaded.validation,
      audits: loaded.audits,
    };
  }

  async function findingPath(id: string, audit: string | undefined): Promise<string | null> {
    const loaded = await load(audit);
    return loaded.findings.find((entry) => entry.finding.id === id)?.path ?? null;
  }

  async function afterWrite(
    filePath: string,
    result: { finding: Finding; hash: string; previousText: string }
  ): Promise<WriteEffect> {
    const resolved = await pathIndex();
    return {
      finding: render(result.finding, filePath, result.hash, resolved),
      // The write's own hash is what the undo is fenced against, so the token
      // carries the version it is entitled to put back.
      undoToken: mintUndo(filePath, result.previousText, result.hash),
    };
  }

  return {
    snapshot,

    async auditNames() {
      return listAuditNames(auditsRoot);
    },

    /**
     * The brief is built here rather than in the console because it reads the
     * markdown `renderFinding` converts away: shipping those fields to every
     * reader costs a third again on the snapshot to serve one button.
     */
    async brief(ids, audit) {
      const loaded = await load(audit);
      const briefs: string[] = [];
      for (const id of ids) {
        const entry = loaded.findings.find((candidate) => candidate.finding.id === id);
        if (entry === undefined) {
          return { ok: false, error: notFound(`no finding "${id}" in this audit`) };
        }
        briefs.push(formatBrief(entry.finding));
      }
      return { ok: true, value: briefs.join(`\n${BRIEF_SEPARATOR}\n`) };
    },

    async write(id, transition, base, audit) {
      const filePath = await findingPath(id, audit);
      if (filePath === null) {
        return { ok: false, error: notFound(`no finding "${id}" in this audit`) };
      }

      let expect: string | undefined;
      if (base !== undefined) {
        const seen = versions.get(filePath)?.get(base);
        if (seen === undefined) {
          return {
            ok: false,
            error: {
              code: 'conflict',
              message: `version ${base} of "${id}" is no longer one this console holds`,
            },
          };
        }
        // Null means the transition already fails against the version the caller
        // read, so the write has nothing to guard and the store reports the real
        // refusal instead of a conflict standing in for it.
        expect = expectedHash(seen, transition) ?? undefined;
      }

      const outcome = await applyWrite(
        filePath,
        transition,
        expect === undefined ? {} : { expect }
      );
      if (!outcome.ok) return { ok: false, error: serviceError(outcome.error) };
      return { ok: true, value: await afterWrite(filePath, outcome.value) };
    },

    async undo(token) {
      const entry = undos.get(token);
      if (entry === undefined) {
        return { ok: false, error: notFound('that undo token is spent or unknown') };
      }
      const outcome = await undoWrite(entry.path, entry.previousText, entry.writtenHash);
      if (!outcome.ok) {
        // A held lock is another writer holding the file for the milliseconds a
        // write takes, so this undo was never attempted and the reader keeps it.
        // Every other refusal is terminal: once the finding has moved, restoring
        // the frontmatter would discard whatever moved it, so a retry is not an
        // operation the reader should be offered.
        if (outcome.error.code !== 'locked') undos.delete(token);
        return { ok: false, error: serviceError(outcome.error) };
      }
      undos.delete(token);
      return { ok: true, value: await afterWrite(entry.path, outcome.value) };
    },

    async source(request, audit) {
      const loaded = await load(audit);
      return readSource(options.repoRoot, {
        path: request.path,
        start: request.start,
        ...(request.end === undefined ? {} : { end: request.end }),
        auditDate: loaded.audit.date,
      });
    },

    async auditDir(audit) {
      return resolveAuditDir(auditsRoot, audit ?? servedByDefault);
    },
  };
}
