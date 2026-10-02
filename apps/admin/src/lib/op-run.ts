import {
  adminOpExecuteResultSchema,
  adminOpPrefillResultSchema,
  adminOpPreviewResultSchema,
  type AdminOpExecuteResult,
  type AdminOpPreviewResult,
} from '@hushbox/shared';
import { ADMIN_API_BASE, adminFetch, client, fetchJson } from '@/lib/api-client';

// Both run responses are re-validated with the shared wire schemas (the web
// app's response re-validation mechanic) before anything renders from them.

/**
 * Engine dry-run: same code path as execute, rolled back server-side. An
 * undo passes its `undoes` so the dry run validates the undo target the way
 * execute does — a preview that skipped it could pass where execute refuses.
 */
export async function previewOp(
  name: string,
  input: Record<string, unknown>,
  undoes?: string
): Promise<AdminOpPreviewResult> {
  const raw = await fetchJson<unknown>(
    client.admin.ops[':name'].preview.$post({
      param: { name },
      json: { input, ...(undoes === undefined ? {} : { undoes }) },
    })
  );
  return adminOpPreviewResultSchema.parse(raw);
}

interface ExecuteOpParams {
  readonly name: string;
  readonly input: Record<string, unknown>;
  /**
   * Minted once at form-submit time and reused for retries of that
   * submission, so a retried execute replays instead of double-applying.
   */
  readonly idempotencyKey: string;
  /** Audit row id being undone when this execute runs an inverse op. */
  readonly undoes?: string;
}

/**
 * Drops `reason` from values seeding an op form: the operator always types
 * their own justification, and an input recorded before that rule still
 * carries a machine-authored one, so the strip is unconditional on the field
 * name — never on how the value looks. It is applied where seed values become
 * form state rather than at any caller, so a seeding path cannot reach the
 * form carrying words nobody typed.
 */
export function withoutReason<T>(values: Readonly<Record<string, T>>): Record<string, T> {
  return Object.fromEntries(Object.entries(values).filter(([field]) => field !== 'reason'));
}

/**
 * Blind prefill probe fired when an op form opens. Every failure — 404 (no
 * prefill for this op), network error, malformed body — means "open blank":
 * null, no notice, no retry (there is no catalog flag advertising prefill).
 * That is why it rides the raw wrapped fetch instead of `fetchJson`, whose
 * throw-on-failure unwrap would make silence the exceptional path.
 */
export async function prefillOp(name: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await adminFetch(
      `${ADMIN_API_BASE}/admin/ops/${encodeURIComponent(name)}/prefill`,
      { credentials: 'include' }
    );
    if (!res.ok) {
      // Read, never cancelled: in Chromium an unread no-store body keeps its load pending
      // until the page unloads, and a cancel reports as an aborted request.
      await res.text();
      return null;
    }
    const parsed = adminOpPrefillResultSchema.safeParse(await res.json());
    if (!parsed.success) {
      return null;
    }
    return parsed.data.input;
  } catch {
    return null;
  }
}

export async function executeOp(params: ExecuteOpParams): Promise<AdminOpExecuteResult> {
  const raw = await fetchJson<unknown>(
    client.admin.ops[':name'].execute.$post(
      {
        param: { name: params.name },
        json: {
          input: params.input,
          ...(params.undoes === undefined ? {} : { undoes: params.undoes }),
        },
      },
      { headers: { 'Idempotency-Key': params.idempotencyKey } }
    )
  );
  return adminOpExecuteResultSchema.parse(raw);
}
