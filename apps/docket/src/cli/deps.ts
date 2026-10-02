import path from 'node:path';
import { dayStamp } from '@hushbox/docket/types';

export interface CliDeps {
  /** The repository root; audits are read from `docs/audits` beneath it. */
  readonly repoRoot: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly now?: () => string;
}

export function auditsRoot(deps: CliDeps): string {
  return path.join(deps.repoRoot, 'docs', 'audits');
}

export function timestamp(deps: CliDeps): string {
  return (deps.now ?? ((): string => dayStamp(new Date())))();
}
