import { useCallback, useState } from 'react';
import { useCopyToClipboard } from '@hushbox/ui';
import { useAuditAddress } from '@/api/audit-address';
import { auditBriefUrl } from '@/api/audit-routes';
import type { FindingJson } from '@hushbox/docket';

type BriefCopyStatus = 'idle' | 'working' | 'copied' | 'failed';

interface BriefCopyDeps {
  readonly fetch?: typeof globalThis.fetch;
}

interface BriefCopy {
  readonly copy: (findings: readonly FindingJson[]) => Promise<void>;
  readonly status: BriefCopyStatus;
  readonly message: string | null;
}

async function refusalMessage(response: Response): Promise<string> {
  const fallback = `the brief could not be built (${String(response.status)})`;
  try {
    const body = (await response.json()) as { error?: { message?: unknown } } | null;
    return typeof body?.error?.message === 'string' ? body.error.message : fallback;
  } catch {
    return fallback;
  }
}

/**
 * The brief is built server-side because it reads the markdown the console's
 * finding payload does not carry. Shipping those fields to every reader would
 * cost about a third again on the snapshot to serve this one button, so the
 * bytes are produced once, on demand, by the same formatter the CLI uses.
 */
export function useBriefCopy(deps: BriefCopyDeps = {}): BriefCopy {
  const audit = useAuditAddress();
  const { copy: toClipboard } = useCopyToClipboard();
  const [status, setStatus] = useState<BriefCopyStatus>('idle');
  const [message, setMessage] = useState<string | null>(null);

  const copy = useCallback(
    async (findings: readonly FindingJson[]): Promise<void> => {
      if (findings.length === 0) return;
      const call = deps.fetch ?? globalThis.fetch.bind(globalThis);
      const query = new URLSearchParams({ ids: findings.map((finding) => finding.id).join(',') });

      setMessage(null);
      setStatus('working');
      let text: string;
      try {
        const response = await call(auditBriefUrl(audit, query));
        if (!response.ok) {
          setStatus('failed');
          setMessage(await refusalMessage(response));
          return;
        }
        text = ((await response.json()) as { text: string }).text;
      } catch (error) {
        setStatus('failed');
        setMessage(error instanceof Error ? error.message : 'the brief could not be fetched');
        return;
      }

      if (await toClipboard(text)) {
        setStatus('copied');
        return;
      }
      setStatus('failed');
      setMessage('The clipboard refused the brief.');
    },
    [audit, deps, toClipboard]
  );

  return { copy, status, message };
}
