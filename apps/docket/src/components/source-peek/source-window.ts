import { auditSourceUrl } from '@/api/audit-routes';
import { citationKey } from './citation-target';
import type { Citation } from './citation-target';
import type { SourceWindow } from '@hushbox/docket';

export type PeekOutcome =
  | { readonly ok: true; readonly window: SourceWindow }
  | { readonly ok: false; readonly message: string };

export type SourceReader = (citation: Citation) => Promise<PeekOutcome>;

/**
 * Containment is the one refusal a reader can act on, so it is the one the
 * console says in its own words; everything else is the server's own message,
 * which is more specific than anything this side could invent.
 */
function refusalMessage(body: unknown, status: number): string {
  const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  if (error?.code === 'outside-root') {
    return 'that path resolves outside the repository, so it was not read';
  }
  if (typeof error?.message === 'string') return error.message;
  return `the source could not be read (${String(status)})`;
}

async function requestWindow(
  audit: string,
  fetchImpl: typeof fetch,
  citation: Citation
): Promise<PeekOutcome> {
  const query = new URLSearchParams({
    path: citation.path,
    start: String(citation.start),
    end: String(citation.end),
  });

  try {
    const response = await fetchImpl(auditSourceUrl(audit, query));
    const body: unknown = await response.json();
    if (!response.ok) return { ok: false, message: refusalMessage(body, response.status) };
    return { ok: true, window: body as SourceWindow };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : 'the source could not be read',
    };
  }
}

/**
 * Reads cited windows for one audit. The cache holds the promise
 * rather than the value, so two hovers of the same citation while the first is
 * still in flight share the request; anything but a served window is dropped
 * from it, because a refusal the reader can fix must not be remembered.
 */
export function createSourceReader(audit: string, fetchImpl: typeof fetch = fetch): SourceReader {
  const cache = new Map<string, Promise<PeekOutcome>>();

  return (citation) => {
    const key = citationKey(citation);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const pending = (async (): Promise<PeekOutcome> => {
      const outcome = await requestWindow(audit, fetchImpl, citation);
      if (!outcome.ok) cache.delete(key);
      return outcome;
    })();
    cache.set(key, pending);
    return pending;
  };
}
