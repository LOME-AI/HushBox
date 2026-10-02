import fs from 'node:fs';

/** @typedef {import('../findings.mjs').Finding} Finding */
import path from 'node:path';

import { isDiagnosticRule } from '../registry/antipatterns.mjs';
import { loadDesignSystemForCwd } from '../design-system.mjs';
import { detectHtml } from '../engines/static-html/detect-html.mjs';
import { detectText } from '../engines/regex/detect-text.mjs';
import {
  filterDetectionFindings,
  readDetectionConfig,
  shouldIgnoreDetectionFile,
} from '../../lib/impeccable-config.mjs';
import {
  HTML_EXTENSIONS,
  buildImportGraph,
  walkScope,
} from '../node/file-system.mjs';

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

/**
 * The rows a reader acts on, and the rows that tell them how far the detector
 * read, split apart.
 *
 * A row saying a declaration could not be priced is not something wrong with
 * the page — it is the detector's own reach, and counting it as an anti-pattern
 * makes a clean page unreachable for anyone whose stop condition is zero
 * findings. Which rules are which is the registry's answer
 * ({@link isDiagnosticRule}), so a rule joins this split beside its own
 * definition.
 *
 * @param {readonly Finding[]} findings
 * @returns {{ findings: Finding[], coverage: Finding[] }}
 */
function partitionCoverage(findings) {
  /** @type {Finding[]} */
  const reported = [];
  /** @type {Finding[]} */
  const coverage = [];
  for (const f of findings) (isDiagnosticRule(f.antipattern) ? coverage : reported).push(f);
  return { findings: reported, coverage };
}

/**
 * The same row twice, printed once.
 *
 * Two things can produce one: a verdict with more than one emitter — a gradient
 * behind text is read both off the cascade and off the source text, and neither
 * reading subsumes the other, so both stay — and a page stating one fact on
 * many elements, where the verdict names the fact and not the element.
 *
 * The key is everything that makes a row that row, the ENGINE INCLUDED. Two
 * engines phrase one verdict differently — `broken-image` answers
 * `<img src="">` in one and `<img src=""` in the other for the same markup — so
 * a key without it would let a collapse decide which of two engines spoke. The
 * line is in the key for the same reason: a rule firing twice in a source is two
 * places a reader has to go.
 *
 * @param {readonly Finding[]} findings
 * @returns {Finding[]}
 */
function dedupeFindings(findings) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Finding[]} */
  const kept = [];
  for (const f of findings) {
    const key = JSON.stringify([f.file, f.antipattern, f.engine ?? '', f.line ?? 0, f.snippet]);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(f);
  }
  return kept;
}

/**
 * The coverage block: per file, what each engine could not read there, and what
 * that costs a verdict drawn from the rest.
 *
 * It goes to the same channel the text report goes to, in every mode. In JSON
 * mode that keeps the array on standard output exactly what it was — the
 * findings and nothing else — while the reader still learns which files the
 * verdicts were drawn from only part of.
 *
 * @param {readonly Finding[]} coverage
 * @returns {string}
 */
function formatCoverage(coverage) {
  /** @type {Map<string, Finding[]>} */
  const byFile = new Map();
  for (const f of coverage) {
    const forFile = byFile.get(f.file) ?? [];
    forFile.push(f);
    byFile.set(f.file, forFile);
  }
  /** @type {string[]} */
  const out = ['\nCoverage — what the detector could not read. Not anti-patterns.'];
  for (const [file, items] of byFile) {
    out.push(`\n${file}`);
    /** @type {Map<string, Finding[]>} */
    const byRule = new Map();
    for (const item of items) {
      const key = `${item.antipattern}\u0000${item.engine ?? ''}`;
      const forRule = byRule.get(key) ?? [];
      forRule.push(item);
      byRule.set(key, forRule);
    }
    for (const forRule of byRule.values()) {
      const first = /** @type {Finding} */ (forRule[0]);
      const snippets = [...new Set(forRule.map((item) => item.snippet))];
      out.push(
        `  [${first.antipattern}] (engine: ${first.engine}) ${snippets.length} not read: ${snippets.join('; ')}`
      );
      out.push(`    → ${first.description}`);
    }
  }
  return out.join('\n');
}

/**
 * What the walk under `target` left out, in one line.
 *
 * The walk drops generated files, so a directory holding only build output
 * scans nothing — and an empty findings array with a clean exit is exactly what
 * a directory with nothing wrong in it produces. Without this line the two
 * cases are indistinguishable, and the quieter one is the wrong one to leave
 * unsaid. It speaks only for the walk: a path named on the command line is
 * scanned whatever the walk would have said about it, so naming a generated
 * file produces findings and no note.
 *
 * @param {string} target the path as the caller wrote it
 * @param {number} count
 */
function formatWalkExclusions(target, count) {
  return count === 1
    ? `Note: 1 file under ${target} is generated and was not scanned.`
    : `Note: ${count} files under ${target} are generated and were not scanned.`;
}

/** @param {number} count */
function formatFindingSummary(count) {
  return `${count} anti-pattern${count === 1 ? '' : 's'} found.`;
}

/**
 * @param {readonly Finding[]} findings
 * @param {boolean} jsonMode
 */
function formatFindings(findings, jsonMode) {
  if (jsonMode) return JSON.stringify(findings, null, 2);

  /** @type {Record<string, Finding[]>} */
  const grouped = {};
  for (const f of findings) {
    const forFile = (grouped[f.file] ??= []);
    forFile.push(f);
  }
  /** @type {string[]} */
  const out = [];
  for (const [file, items] of Object.entries(grouped)) {
    const importNote = items[0]?.importedBy?.length ? ` (imported by ${items[0].importedBy.join(', ')})` : '';
    out.push(`\n${file}${importNote}`);
    for (const item of items) {
      // The engine is printed per finding, not per file: one file can be read by
      // both engines, and where they disagree the report has to say which one
      // spoke rather than leaving the divergence invisible.
      out.push(`  ${item.line ? `line ${item.line}: ` : ''}[${item.antipattern}] (engine: ${item.engine}) ${item.snippet}`);
      out.push(`    → ${item.description}`);
    }
  }
  out.push(`\n${formatFindingSummary(findings.length)}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Stdin handling
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<Finding[]>}
 */
async function handleStdin(options = {}) {
  /** @type {Buffer[]} */
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = Buffer.concat(chunks).toString('utf-8');
  try {
    const parsed = JSON.parse(input);
    const fp = parsed?.tool_input?.file_path;
    if (fp && fs.existsSync(fp)) {
      return HTML_EXTENSIONS.has(path.extname(fp).toLowerCase())
        ? detectHtml(fp, options) : detectText(fs.readFileSync(fp, 'utf-8'), fp, options);
    }
  } catch { /* not JSON */ }
  return detectText(input, '<stdin>', options);
}


// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** @param {string} question */
async function confirm(question) {
  const rl = (await import('node:readline')).default.createInterface({
    input: process.stdin, output: process.stderr,
  });
  return new Promise((resolve) => {
    rl.question(`${question} [Y/n] `, (answer) => {
      rl.close();
      resolve(!answer || /^y(es)?$/i.test(answer.trim()));
    });
  });
}

function printUsage() {
  console.log(`Usage: impeccable detect [options] [file-or-dir...]

Scan files or directories for UI anti-patterns and design quality issues.

Options:
  --json              Output results as JSON
  --quiet             Leave stderr carrying the findings count and nothing else
                      (in JSON mode, nothing at all): the coverage block, the
                      unscanned-files note, the per-finding report, and the
                      large-scan confirmation — no prompt, and no abort with it
  --gpt               Also report GPT-specific provider tells (off by default)
  --gemini            Also report Gemini-specific provider tells (off by default)
  --no-config         Do not apply project config, detector ignores, inline
                      ignore comments, or DESIGN.md
  --no-inline-ignores Do not honor in-file impeccable-disable* ignore comments
  --no-design-system  Do not load local DESIGN.md / .impeccable/design.json context
  --help              Show this help message

Project config:
  Respects .impeccable/config.json and .impeccable/config.local.json detector
  settings: detector.ignoreRules, detector.ignoreFiles, detector.ignoreValues,
  and detector.designSystem.enabled.

Inline ignores:
  In-file comments waive a finding where it lives and travel with the file:
    <!-- impeccable-disable overused-font -- exported brand doc -->
    .brand { font-family: Inter } /* impeccable-disable-line overused-font */
    // impeccable-disable-next-line bounce-easing: intentional bounce
  impeccable-disable applies to the whole file; -line / -next-line are scoped.
  List one or more rule ids (comma-separated), or omit them / use * for all.

Detection modes:
  HTML files     Static HTML/CSS analysis (default, catches linked CSS)
  Non-HTML files Regex pattern matching (CSS, JSX, TSX, etc.)

Examples:
  impeccable detect src/
  impeccable detect index.html
  impeccable detect --json .
  impeccable detect --no-config src/`);
}

async function detectCli() {
  let args = process.argv.slice(2).map(arg => {
    if (arg === '-json') return '--json';
    if (arg === '-fast') return '--fast';
    return arg;
  });
  if (args[0] === 'detect') args = args.slice(1);
  const jsonMode = args.includes('--json');
  const quietMode = args.includes('--quiet');
  const helpMode = args.includes('--help');
  // --fast (regex-only) is deprecated: the static htmlparser2/css-tree HTML/CSS
  // analysis is fast and covers every rule, so the regex-only path only loses
  // coverage for no real speed win. Accept the flag for back-compat but ignore
  // it and run the full scan.
  if (args.includes('--fast')) {
    process.stderr.write(
      'Note: --fast is deprecated and ignored. The full scan is fast now and runs every rule.\n',
    );
  }
  const configEnabled = !args.includes('--no-config');
  const detectionConfig = configEnabled
    ? readDetectionConfig(process.cwd())
    : { ignoreRules: [], ignoreFiles: [], ignoreValues: [] };
  /** @type {string[]} */
  const providers = [];
  if (args.includes('--gpt')) providers.push('gpt');
  if (args.includes('--gemini')) providers.push('gemini');
  const designSystemEnabled = configEnabled && !args.includes('--no-design-system') && detectionConfig.designSystem?.enabled !== false;
  const designSystem = designSystemEnabled ? loadDesignSystemForCwd(process.cwd()) : null;
  // Inline `impeccable-disable*` waivers are part of the scanned file, so they
  // apply by default. `--no-config` (raw scan) and the dedicated
  // `--no-inline-ignores` both turn them off.
  const inlineIgnoresEnabled = configEnabled && !args.includes('--no-inline-ignores');
  /** @type {{ providers: string[], inlineIgnores: boolean, designSystem?: import('../design-system.mjs').DesignSystem }} */
  const scanOptions = { providers, inlineIgnores: inlineIgnoresEnabled };
  if (designSystem) scanOptions.designSystem = designSystem;
  const targets = args.filter(a => !a.startsWith('--'));

  if (helpMode) { printUsage(); process.exit(0); }

  /** @type {Finding[]} */
  let allFindings = [];

  if (!process.stdin.isTTY && targets.length === 0) {
    allFindings = await handleStdin(scanOptions);
  } else {
    const paths = targets.length > 0 ? targets : [process.cwd()];

    for (const target of paths) {
      const resolved = path.resolve(target);
      /** @type {import('node:fs').Stats} */
      let stat;
      try { stat = fs.statSync(resolved); }
      catch { process.stderr.write(`Warning: cannot access ${target}\n`); continue; }

      if (stat.isDirectory()) {
        const scope = walkScope(resolved);
        // Coverage, not a warning: it says how far the walk read, so it is on
        // the channel the coverage block uses and silenced by the same flag,
        // which asks for the count and nothing else.
        if (scope.generated.length > 0 && !quietMode) {
          process.stderr.write(formatWalkExclusions(target, scope.generated.length) + '\n');
        }
        const files = scope.files
          .filter(file => !shouldIgnoreDetectionFile(file, process.cwd(), detectionConfig));
        const htmlCount = files.filter(f => HTML_EXTENSIONS.has(path.extname(f).toLowerCase())).length;

        // Warn and confirm if scanning many files (static HTML/CSS processes each HTML file)
        if (files.length > 50 && process.stdin.isTTY && !jsonMode && !quietMode) {
          process.stderr.write(
            `\nFound ${files.length} files (${htmlCount} HTML) in ${target}.\n` +
            `Scanning may take a while${htmlCount > 10 ? ' (static HTML/CSS processes each HTML file individually)' : ''}.\n` +
            `Target a specific subdirectory to narrow scope.\n`
          );
          const ok = await confirm('Continue?');
          if (!ok) { process.stderr.write('Aborted.\n'); process.exit(0); }
        }

        // Build import graph for multi-file awareness
        const graph = buildImportGraph(files);
        // Build reverse map: file -> set of files that import it
        /** @type {Map<string, Set<string>>} */
        const importedByMap = new Map();
        for (const [importer, imports] of graph) {
          for (const imported of imports) {
            const importers = importedByMap.get(imported) ?? new Set();
            importers.add(importer);
            importedByMap.set(imported, importers);
          }
        }

        for (const file of files) {
          const ext = path.extname(file).toLowerCase();
          /** @type {Finding[]} */
          let fileFindings;
          if (HTML_EXTENSIONS.has(ext)) {
            fileFindings = await detectHtml(file, scanOptions);
          } else {
            fileFindings = detectText(fs.readFileSync(file, 'utf-8'), file, scanOptions);
          }
          // Annotate findings with import context
          const importers = importedByMap.get(file);
          if (importers && importers.size > 0) {
            const importerNames = [...importers].map(f => path.basename(f));
            for (const f of fileFindings) {
              f.importedBy = importerNames;
            }
          }
          allFindings.push(...fileFindings);
        }
      } else if (stat.isFile()) {
        if (shouldIgnoreDetectionFile(resolved, process.cwd(), detectionConfig)) continue;
        const ext = path.extname(resolved).toLowerCase();
        if (HTML_EXTENSIONS.has(ext)) {
          allFindings.push(...await detectHtml(resolved, scanOptions));
        } else {
          allFindings.push(...detectText(fs.readFileSync(resolved, 'utf-8'), resolved, scanOptions));
        }
      }
    }
  }

  const { findings, coverage } = partitionCoverage(
    dedupeFindings(filterDetectionFindings(allFindings, detectionConfig))
  );

  // `--quiet` asks for the count and nothing else, so it silences this block
  // exactly as it silences the per-finding report.
  if (coverage.length > 0 && !quietMode) process.stderr.write(formatCoverage(coverage) + '\n');

  if (findings.length > 0) {
    if (jsonMode) process.stdout.write(formatFindings(findings, true) + '\n');
    else if (quietMode) process.stderr.write(formatFindingSummary(findings.length) + '\n');
    else process.stderr.write(formatFindings(findings, false) + '\n');
    process.exit(2);
  }
  if (jsonMode) process.stdout.write('[]\n');
  process.exit(0);
}

export {
  dedupeFindings,
  formatCoverage,
  formatFindings,
  formatWalkExclusions,
  handleStdin,
  confirm,
  partitionCoverage,
  printUsage,
  detectCli,
};
