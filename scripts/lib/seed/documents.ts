/**
 * The seeded "Document showcase" conversation — one assistant message per
 * document-panel path, so a developer running `pnpm dev` can open the panel and
 * exercise every path locally without waiting on a model.
 *
 * Pure content: the seed orchestrator persists these messages verbatim through
 * the dev conversation factory.
 *
 * Streaming is deliberately not represented here. The local mock provider echoes
 * a prompt back chunk by chunk with a per-chunk delay, so pasting any document
 * below into the composer exercises the streaming path at observable speed.
 */

import { HTML_LIFE } from './documents-html.js';
import { JS_SORTING_LAB } from './documents-javascript.js';
import { REACT_BUDGET, REACT_COMPILE_ERROR, REACT_RUNTIME_ERROR } from './documents-react.js';

/** Written apart from the template literals below so no content has to escape it. */
const FENCE = '```';

/** A lead-in line, a blank line, then one fenced block — how a model answers. */
function fenced(leadIn: string, language: string, body: string): string {
  return `${leadIn}\n\n${FENCE}${language}\n${body}\n${FENCE}`;
}

const PYTHON_ANALYSIS = `import numpy as np
import matplotlib.pyplot as plt

# Twelve weeks of signups per region, straight out of the warehouse export.
regions = ["North", "South", "East", "West"]
colours = ["#4c78a8", "#f58518", "#54a24b", "#e45756"]
weeks = np.arange(1, 13)
signups = np.array(
    [
        [120, 133, 129, 145, 160, 158, 172, 181, 190, 205, 214, 232],
        [88, 92, 96, 91, 104, 118, 121, 130, 128, 141, 150, 162],
        [210, 205, 198, 221, 219, 232, 244, 238, 259, 266, 271, 288],
        [54, 61, 59, 72, 80, 77, 91, 99, 104, 112, 121, 133],
    ]
)

totals = signups.sum(axis=1)
averages = signups.mean(axis=1)
growth = (signups[:, -1] - signups[:, 0]) / signups[:, 0] * 100
slopes = np.zeros(len(regions))
fits = np.zeros_like(signups, dtype=float)

header = f"{'region':<8}{'total':>7}{'avg/wk':>9}{'growth':>9}{'trend':>8}{'R2':>7}"
print(header)
print("-" * len(header))

for i, region in enumerate(regions):
    slope, intercept = np.polyfit(weeks, signups[i], 1)
    fits[i] = slope * weeks + intercept
    residuals = signups[i] - fits[i]
    r2 = 1 - residuals.var() / signups[i].var()
    slopes[i] = slope
    print(
        f"{region:<8}{totals[i]:>7}{averages[i]:>9.1f}"
        f"{growth[i]:>8.1f}%{slope:>8.1f}{r2:>7.3f}"
    )

network = signups.sum(axis=0)
fastest = int(np.argmax(slopes))
print()
print(f"fastest climb: {regions[fastest]}, +{slopes[fastest]:.1f} signups per week")
print(f"network total: {int(network.sum())} signups across {weeks.size} weeks")
print(f"weekly change: mean {np.diff(network).mean():.1f}, sd {np.diff(network).std():.1f}")

fig, (series, bars) = plt.subplots(1, 2, figsize=(9.5, 3.8))
for i, region in enumerate(regions):
    series.plot(weeks, signups[i], marker="o", markersize=3, color=colours[i], label=region)
    series.plot(weeks, fits[i], linestyle="--", linewidth=0.9, color=colours[i], alpha=0.6)
series.set_title("Weekly signups, with least-squares trend")
series.set_xlabel("week")
series.set_ylabel("signups")
series.legend(fontsize=7)

bars.bar(regions, totals, color=colours)
bars.axhline(totals.mean(), linestyle="--", color="0.4", linewidth=1)
bars.set_title("Twelve-week totals")
bars.set_ylabel("signups")
fig.tight_layout()`;

const MERMAID_FLOW = `flowchart TD
  A[Model writes a fenced block] --> B{Language declared?}
  B -- no --> C[Stays a plain code block]
  B -- yes --> D{Mermaid, or 15+ lines?}
  D -- no --> C
  D -- yes --> E[Becomes a document card]
  E --> F{Which language?}
  F -- mermaid --> G[Rendered in the app]
  F -- html, js, jsx, python --> H[Sandbox iframe]
  H --> I{Runs on open?}
  I -- html, js, jsx --> J[Renders immediately]
  I -- python --> K[Waits for Run]
  K --> L[Console output and figures]
  J --> M[Rendered / Raw toggle]
  L --> M`;

/**
 * Fenced without a language on purpose: it is long enough to clear the
 * document line threshold, and stays a plain code block anyway because the
 * parser requires a declared language first. Its times are elapsed rather than
 * absolute because the content privacy gate refuses a committed clock reading
 * finer than a day.
 */
const UNTAGGED_LOG = `  t+0s  dispatcher  claim   shard=default batch=8
  t+0s  dispatcher  lease    job=newsletter.dispatch.v1 ttl=120s
  t+1s  worker      start    job=newsletter.dispatch.v1 attempt=1
  t+1s  worker      batch    recipients=500 issue=summer-notes
  t+3s  worker      ok       delivered=500 suppressed=3
  t+3s  dispatcher  complete job=newsletter.dispatch.v1 duration=2.1s
  t+3s  dispatcher  rearm    next=+30s
 t+33s  dispatcher  claim    shard=default batch=0
 t+33s  dispatcher  idle     decay=60s
 t+93s  dispatcher  claim    shard=default batch=1
 t+93s  worker      start    job=payment.verify.v1 attempt=2
 t+94s  worker      yield    checkpoint=awaiting-webhook
 t+94s  dispatcher  rearm    next=+16s
t+110s  worker      start    job=payment.verify.v1 attempt=3
t+111s  worker      ok       payment=settled
t+111s  dispatcher  idle     decay=120s`;

/** Title of the seeded showcase conversation, as it reads in the sidebar. */
export const DOCUMENT_SHOWCASE_TITLE = 'Document showcase';

/**
 * The showcase transcript: a user prompt, then one document per assistant
 * message. Order matches the panel's paths — the four runnable kinds (html,
 * react, js, python), the in-app diagram, the two deliberate failure cards, and
 * a block that must stay plain code.
 */
export const DOCUMENT_SHOWCASE_MESSAGES: readonly {
  content: string;
  senderType: 'user' | 'ai';
}[] = [
  {
    senderType: 'user',
    content:
      'Show me what the document panel can do — one document per reply, covering HTML, React, plain JavaScript, Python, diagrams, and what happens when a document is broken.',
  },
  {
    senderType: 'ai',
    content: fenced(
      "A whole HTML page: Conway's Game of Life on a canvas, with seed patterns and live counters.",
      'html',
      HTML_LIFE
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'A React dashboard — several components, a reducer, an inline SVG chart, and canvas-confetti straight from npm.',
      'jsx',
      REACT_BUDGET
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'A plain JavaScript module, no framework: it builds its own DOM and races four sorting algorithms.',
      'js',
      JS_SORTING_LAB
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'Python with numpy and matplotlib — press Run for the fitted table and a two-panel figure.',
      'python',
      PYTHON_ANALYSIS
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'A mermaid flowchart of how a fenced block becomes a document.',
      'mermaid',
      MERMAID_FLOW
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'Broken on purpose, not a bug: an unclosed tag, so the compile-failure card is what should appear.',
      'jsx',
      REACT_COMPILE_ERROR
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'Broken on purpose too: this one compiles, then throws while mounting — the other failure card.',
      'jsx',
      REACT_RUNTIME_ERROR
    ),
  },
  {
    senderType: 'ai',
    content: fenced(
      'And a fence with no language: long enough to be a document, but it stays plain code.',
      '',
      UNTAGGED_LOG
    ),
  },
];
