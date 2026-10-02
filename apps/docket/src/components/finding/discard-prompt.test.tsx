import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { parseFinding } from '@hushbox/docket';
import { makeFinding } from '@/test-utils/finding-fixture';
import { TEST_AUDIT, withAuditAddress } from '@/test-utils/audit-address';
import { fakeRequest, fakeResponse } from '@/test-utils/fake-http';
import { createAuditService } from '@/server/audit-service';
import { createEventHub } from '@/server/events';
import { createRouter } from '@/server/routes';
import { TEST_IDS } from '@/test-ids';
import { DiscardPrompt } from './discard-prompt';
import { FindingCard } from './finding-card';
import type { FindingJson, ProgressNote } from '@hushbox/docket';

function note(text: string): ProgressNote {
  return { at: '2026-07-30', by: 'agent', text };
}

/** The ruling a ruled finding has to carry: `state: 'ruled'` without one is refused as invalid. */
const RULING = { option: 'A', text: null, note: null, at: '2026-07-30' };

function worked(notes: readonly ProgressNote[]): ReturnType<typeof makeFinding> {
  return makeFinding({
    id: 'A-1',
    state: 'ruled',
    ruling: RULING,
    progress: { status: 'in-progress', updated: null, verified: false, notes },
  });
}

/**
 * An agent has worked on a finding nobody has decided yet. A first decision here
 * discards that work and archives nothing, which is the other way into this
 * dialog.
 */
function undecidedWithWork(): ReturnType<typeof makeFinding> {
  return makeFinding({
    id: 'A-1',
    state: 'open',
    progress: { status: 'in-progress', updated: null, verified: false, notes: [note('one')] },
  });
}

describe('DiscardPrompt', () => {
  it('renders nothing while no ruling is waiting', () => {
    const { container } = render(
      <DiscardPrompt finding={worked([])} pending={null} onConfirm={vi.fn()} onClose={vi.fn()} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('names the finding whose ruling would change', () => {
    render(
      <DiscardPrompt
        finding={worked([note('one')])}
        pending={{ kind: 'rule', input: { option: 'B' } }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole('heading', { name: 'Change the ruling on A-1?' })).toBeInTheDocument();
  });

  it('titles a first ruling by the work it discards, there being no ruling to change', () => {
    render(
      <DiscardPrompt
        finding={undecidedWithWork()}
        pending={{ kind: 'rule', input: { option: 'B' } }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByRole('heading', { name: 'Rule, and discard the work recorded on A-1?' })
    ).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.confirmAccept)).toHaveTextContent('Rule on it');
  });

  it('titles a first denial by the work it discards', () => {
    render(
      <DiscardPrompt
        finding={undecidedWithWork()}
        pending={{ kind: 'deny', reason: null }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByRole('heading', { name: 'Deny, and discard the work recorded on A-1?' })
    ).toBeInTheDocument();
  });

  it('claims nothing is archived where the finding carries no decision', () => {
    render(
      <DiscardPrompt
        finding={undecidedWithWork()}
        pending={{ kind: 'rule', input: { option: 'B' } }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByText(/archived into the finding/u)).toBeNull();
    expect(screen.getByText('It is marked In progress, with 1 progress note.')).toBeInTheDocument();
  });

  it('says the decision it replaces is archived rather than lost', () => {
    render(
      <DiscardPrompt
        finding={worked([note('one')])}
        pending={{ kind: 'rule', input: { option: 'B' } }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(/archived into the finding/u)).toBeInTheDocument();
  });

  it('says what the work is, not a bare zero, when the status is the work', () => {
    render(
      <DiscardPrompt
        finding={makeFinding({
          id: 'A-1',
          state: 'ruled',
          ruling: RULING,
          progress: { status: 'in-progress', updated: null, verified: false, notes: [] },
        })}
        pending={{ kind: 'rule', input: { option: 'B' } }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByText('It is marked In progress, with no progress notes.')
    ).toBeInTheDocument();
    expect(screen.queryByText(/0 progress notes/u)).toBeNull();
  });

  it('says the notes survive the discard', () => {
    render(
      <DiscardPrompt
        finding={worked([note('one')])}
        pending={{ kind: 'rule', input: { option: 'B' } }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText(/notes are kept/u)).toBeInTheDocument();
  });

  it('says the status and the verification do not survive it', () => {
    render(
      <DiscardPrompt
        finding={worked([note('one')])}
        pending={{ kind: 'rule', input: { option: 'B' } }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByText(/status and verification return to their defaults/u)
    ).toBeInTheDocument();
  });

  it('says nothing about work on a finding that carries none', () => {
    render(
      <DiscardPrompt
        finding={makeFinding({ id: 'A-1', state: 'ruled', ruling: RULING })}
        pending={{ kind: 'rule', input: { option: 'B' } }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.queryByText(/return to their defaults/u)).toBeNull();
  });

  it('titles the denial by what it discards', () => {
    render(
      <DiscardPrompt
        finding={worked([note('one')])}
        pending={{ kind: 'deny', reason: null }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByRole('heading', { name: 'Deny, and discard the ruling on A-1?' })
    ).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.confirmAccept)).toHaveTextContent('Deny it');
  });

  it('hands back the denial that was waiting', () => {
    const onConfirm = vi.fn();
    render(
      <DiscardPrompt
        finding={worked([note('one')])}
        pending={{ kind: 'deny', reason: 'not worth it' }}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    expect(onConfirm).toHaveBeenCalledWith({ kind: 'deny', reason: 'not worth it' });
  });

  it('names a single note without pluralising it', () => {
    render(
      <DiscardPrompt
        finding={worked([note('one')])}
        pending={{ kind: 'rule', input: { option: 'B' } }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('It is marked In progress, with 1 progress note.')).toBeInTheDocument();
  });

  it('names several notes', () => {
    render(
      <DiscardPrompt
        finding={worked([note('one'), note('two')])}
        pending={{ kind: 'rule', input: { option: 'B' } }}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(
      screen.getByText('It is marked In progress, with 2 progress notes.')
    ).toBeInTheDocument();
  });

  it('hands back the ruling that was waiting', () => {
    const onConfirm = vi.fn();
    render(
      <DiscardPrompt
        finding={worked([note('one')])}
        pending={{ kind: 'rule', input: { option: 'B', note: 'and log it' } }}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    expect(onConfirm).toHaveBeenCalledWith({
      kind: 'rule',
      input: { option: 'B', note: 'and log it' },
    });
  });

  it('backs out without ruling', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <DiscardPrompt
        finding={worked([note('one')])}
        pending={{ kind: 'rule', input: { option: 'B' } }}
        onConfirm={onConfirm}
        onClose={onClose}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

const AUDIT = `---
layout_version: 1
date: "2026-07-30"
title: "Scratch audit"
scope: "One finding."
status: "open"
---

# Scratch audit
`;

const RULED_WITH_WORK = `---
id: "A-1"
title: "A decision somebody has already started on"
severity: "medium"
kind: "decision"
status: "live"
status_note: null
area: "apps/docket"
needs_ruling: true
needs_options: false
warning: false
related: []
group: null
dedicated: false
state: "ruled"
ruling:
  option: "C"
  text: null
  note: null
  at: "2026-07-30"
denial: null
history: []
questions: []
progress:
  status: "in-progress"
  updated: "2026-07-30"
  verified: false
  notes:
    - { at: "2026-07-30", by: "agent", text: "Half of the ruled option is built." }
---

**What this is.** A decision with work already done against it.

## Options

### A — Keep the current shape
**Recommended**

Keep it.

### B — Replace it wholesale

Replace it.

### C — Leave it for later

Leave it.
`;

/**
 * The console wired to its own server over a throwaway audit, which is the only
 * arrangement that can show whether a keystroke reaches the file. The directory
 * carries a date because the server serves only dated audits, and it is the
 * name the console addresses its write to.
 */
async function scratchConsole(): Promise<{
  finding: FindingJson;
  call: typeof globalThis.fetch;
  rulingOnDisk: () => Promise<string>;
  cleanup: () => Promise<void>;
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'docket-modal-guard-'));
  const auditDir = path.join(root, 'docs', 'audits', TEST_AUDIT);
  const findingPath = path.join(auditDir, 'findings', 'A-1.md');
  await fs.mkdir(path.dirname(findingPath), { recursive: true });
  await fs.writeFile(path.join(auditDir, 'audit.md'), AUDIT);
  await fs.writeFile(findingPath, RULED_WITH_WORK);

  const service = createAuditService({ repoRoot: root, defaultAudit: TEST_AUDIT });
  const router = createRouter({
    service,
    events: createEventHub(),
    now: () => '2026-07-31',
  });
  const snapshot = await service.snapshot();
  const [finding] = snapshot.findings;
  if (finding === undefined) throw new Error('the throwaway audit produced no finding');

  return {
    finding,
    call: async (input, init) => {
      // Narrowed rather than coerced: the console posts a json string to a
      // path, and anything else is a change this harness must be told about.
      if (typeof input !== 'string' || typeof init?.body !== 'string') {
        throw new TypeError('the console posts a json body to a path');
      }
      const res = fakeResponse();
      const request = fakeRequest(init.method ?? 'GET', input, JSON.parse(init.body));
      await router.handle(request, res);
      return new Response(res.body(), { status: res.statusCode });
    },
    rulingOnDisk: async () => {
      const parsed = parseFinding(await fs.readFile(findingPath, 'utf8'), findingPath);
      return parsed.ok ? (parsed.value.ruling?.option ?? 'none') : 'unreadable';
    },
    cleanup: () => fs.rm(root, { recursive: true, force: true }),
  };
}

/** A keystroke from wherever focus is, which is inside the dialog once one is up. */
function press(key: string): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, bubbles: true });
}

let close: (() => Promise<void>) | null = null;

afterEach(async () => {
  await close?.();
  close = null;
});

describe('a decision waiting on the reader', () => {
  async function raisePrompt(): Promise<{ rulingOnDisk: () => Promise<string> }> {
    const scratch = await scratchConsole();
    close = scratch.cleanup;
    render(
      <FindingCard
        finding={scratch.finding}
        findings={[scratch.finding]}
        queue={[scratch.finding]}
        active
        sectionState="ruled"
        put={vi.fn()}
        onFocus={vi.fn()}
        onJump={vi.fn()}
        onLand={vi.fn()}
        api={{ fetch: scratch.call, attempts: 1 }}
        notify={vi.fn()}
      />,
      { wrapper: withAuditAddress }
    );

    press('2');
    expect(screen.getByRole('heading', { name: 'Change the ruling on A-1?' })).toBeInTheDocument();
    return { rulingOnDisk: scratch.rulingOnDisk };
  }

  it('writes the ruling the reader confirmed, not one a keystroke put in its place', async () => {
    const { rulingOnDisk } = await raisePrompt();

    press('1');
    fireEvent.click(screen.getByTestId(TEST_IDS.confirmAccept));

    await waitFor(async () => {
      expect(await rulingOnDisk()).toBe('B');
    });
  });

  it('takes no keystroke away for the card underneath it', async () => {
    await raisePrompt();

    press('d');

    expect(screen.getByLabelText('Reason for denying')).not.toHaveFocus();
  });
});
