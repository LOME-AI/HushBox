/**
 * The sweep every client artifact passes before it is published: a value
 * sweep for the production secrets the publishing job holds, and the pinned
 * gitleaks over the same files for credential shapes. An app archive (APK, AAB,
 * IPA) is unpacked first, so both legs read the bytes a device receives.
 *
 * The shape scan reads the repository's own `.gitleaks.toml`: a hit that is
 * not a credential is excused there, through its rule-scoped allowlists, and
 * nowhere else.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { execa } from 'execa';
import { z } from 'zod';
import { ensureGitleaks } from '../privacy/gitleaks.js';
import { withScratchDirectory } from '../scratch-directory.js';
import { encodedForms } from './forms.js';
import { sweepPlan, type Needle, type SweepSources } from './registry-values.js';

/** The repository's gitleaks configuration, the one place a shape hit is excused. */
const REPO_GITLEAKS_CONFIG = path.resolve(import.meta.dirname, '../../../.gitleaks.toml');

/** Archives a device installs, unpacked before they are read. */
const APP_ARCHIVE = /\.(?:apk|aab|ipa|zip)$/u;

interface SweepOptions {
  /** The step's environment, where its generated block binds each production value. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly sources?: SweepSources;
  readonly gitleaksConfig?: string;
}

interface SweepResult {
  readonly failed: boolean;
  /** What to print: what was not swept and why, every hit, and the totals. */
  readonly lines: readonly string[];
}

/** One target as both legs read it: a directory, and how its files are named in a report. */
interface ReadableTarget {
  /** The directory gitleaks runs from. */
  readonly cwd: string;
  /** The directory scanned, resolved from `cwd`; also the name a shape hit reports. */
  readonly scanned: string;
  /** Prefix of a file's reported name; an archive's members read `<archive>!/<member>`. */
  readonly label: string;
}

function readable(target: string, scratch: string): ReadableTarget {
  if (!existsSync(target)) throw new Error(`${target} does not exist; there is nothing to sweep`);
  if (statSync(target).isDirectory()) {
    return { cwd: process.cwd(), scanned: target, label: `${target}/` };
  }
  if (!APP_ARCHIVE.test(target)) {
    throw new Error(`${target} is neither a directory nor an app archive (apk, aab, ipa, zip)`);
  }
  const name = path.basename(target);
  new AdmZip(target).extractAllTo(path.join(scratch, name), true);
  return { cwd: scratch, scanned: name, label: `${name}!/` };
}

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)));
}

async function valueHits(
  target: ReadableTarget,
  needles: readonly Needle[]
): Promise<{ files: number; hits: string[] }> {
  const directory = path.resolve(target.cwd, target.scanned);
  const files = await filesUnder(directory);
  const forms = needles.map((needle) => ({ key: needle.key, forms: encodedForms(needle.value) }));
  const hits: string[] = [];
  for (const file of files) {
    const bytes = readFileSync(path.join(directory, file));
    for (const { key, forms: spellings } of forms) {
      const match = spellings.find(({ text }) => bytes.includes(text));
      if (match !== undefined) {
        hits.push(
          `found ${key} (${match.form}) in ${target.label}${file.split(path.sep).join('/')}`
        );
      }
    }
  }
  return { files: files.length, hits };
}

/**
 * What the sweep reads of a gitleaks finding. The report's other fields carry
 * the match and the characters around it, which the sweep never prints: a
 * workflow log masks a secret only when the whole value appears.
 */
const GITLEAKS_REPORT = z.array(
  z.object({ RuleID: z.string(), File: z.string(), StartLine: z.number() })
);

/**
 * The pinned gitleaks over one target, run from `cwd` so the paths it reports
 * start with the target as it was given. Each finding is reported as its rule,
 * file and line, read from the JSON report on standard output.
 */
async function shapeHits(target: ReadableTarget, config: string): Promise<string[]> {
  const bin = await ensureGitleaks();
  const result = await execa(
    bin,
    [
      'dir',
      target.scanned,
      '--config',
      config,
      '--redact',
      '--no-banner',
      '--log-level',
      'error',
      '--report-format',
      'json',
      '--report-path',
      '-',
    ],
    { cwd: target.cwd, reject: false }
  );
  if (result.exitCode === 0) return [];
  const report = GITLEAKS_REPORT.safeParse(JSON.parse(result.stdout || 'null'));
  const findings = report.success ? report.data : [];
  if (findings.length === 0) {
    return [
      `credential shape scan of ${target.scanned} failed with exit code ${String(result.exitCode)} and no findings: ${result.stderr}`,
    ];
  }
  const scanned = path.resolve(target.cwd, target.scanned);
  return findings.map(({ RuleID, File, StartLine }) => {
    const file = path.relative(scanned, path.resolve(target.cwd, File)).split(path.sep).join('/');
    return `credential shape found by ${RuleID} in ${target.label}${file}:${String(StartLine)}`;
  });
}

/** Sweep each target, returning what to print and whether the job fails. */
export async function sweepArtifacts(
  targets: readonly string[],
  options: SweepOptions
): Promise<SweepResult> {
  if (targets.length === 0) throw new Error('name at least one artifact to sweep');
  const plan = sweepPlan(options.env, options.sources);
  const config = options.gitleaksConfig ?? REPO_GITLEAKS_CONFIG;
  const lines = [
    ...plan.notSwept.map(({ key, reason }) => `not swept: ${key} — ${reason}`),
    ...plan.refusals.map((refusal) => `refused: ${refusal}`),
  ];
  let failed = plan.refusals.length > 0;
  if (plan.needles.length === 0) {
    lines.push('nothing to look for: no production value is bound in this step');
    failed = true;
  }
  await withScratchDirectory('hushbox-artifact-sweep-', async (scratch) => {
    for (const target of targets) {
      const resolved = readable(target, scratch);
      const { files, hits } = await valueHits(resolved, plan.needles);
      const shapes = await shapeHits(resolved, config);
      failed ||= hits.length > 0 || shapes.length > 0;
      lines.push(
        ...hits,
        ...shapes,
        `swept ${target}: ${String(plan.needles.length)} values over ${String(files)} files`
      );
    }
  });
  return { failed, lines };
}
