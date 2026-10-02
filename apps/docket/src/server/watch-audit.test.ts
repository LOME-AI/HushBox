import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAuditFixture, type AuditFixture } from '../test-utils/audit-fixture';
import { watchAudit } from './watch-audit';
import type { DocketEvent } from './events';
import type { WatchDeps } from './watch-audit';

let fixture: AuditFixture;
let stop: (() => void) | null = null;

beforeEach(async () => {
  fixture = await createAuditFixture();
});

afterEach(async () => {
  stop?.();
  stop = null;
  await fixture.cleanup();
});

async function collected(
  events: DocketEvent[],
  match: (event: DocketEvent) => boolean
): Promise<void> {
  await vi.waitFor(() => {
    expect(events.some((event) => match(event))).toBe(true);
  }, 4000);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('watchAudit', () => {
  it('reports a finding that changed on disk', async () => {
    const events: DocketEvent[] = [];
    stop = watchAudit(fixture.auditDir, (event) => events.push(event));

    await fixture.writeFinding('AC-1', { title: 'Edited by the agent' });

    await collected(events, (event) => event.type === 'finding' && event.id === 'AC-1');
  });

  it('reports a finding that appeared', async () => {
    const events: DocketEvent[] = [];
    stop = watchAudit(fixture.auditDir, (event) => events.push(event));

    await fixture.writeFinding('NEW-1');

    await collected(events, (event) => event.type === 'finding' && event.id === 'NEW-1');
  });

  it('reports a finding that was removed', async () => {
    const events: DocketEvent[] = [];
    stop = watchAudit(fixture.auditDir, (event) => events.push(event));

    await fs.rm(path.join(fixture.findingsDir, 'AC-2.md'));

    await collected(events, (event) => event.type === 'removed' && event.id === 'AC-2');
  });

  it('reports the audit header changing', async () => {
    const events: DocketEvent[] = [];
    stop = watchAudit(fixture.auditDir, (event) => events.push(event));

    const auditPath = path.join(fixture.auditDir, 'audit.md');
    const header = await fs.readFile(auditPath, 'utf8');
    await fs.writeFile(auditPath, header.replace('open', 'closed'));

    await collected(events, (event) => event.type === 'audit');
  });

  it('ignores the write lock and the temporary file an atomic write leaves in the directory', async () => {
    const events: DocketEvent[] = [];
    stop = watchAudit(fixture.auditDir, (event) => events.push(event));

    await fs.writeFile(path.join(fixture.findingsDir, 'AC-1.md.lock'), 'held');
    await fs.writeFile(path.join(fixture.findingsDir, 'AC-1.md.abc.tmp'), 'partial');
    await fixture.writeFinding('AC-2', { title: 'Edited' });

    await collected(events, (event) => event.id === 'AC-2');
    expect(events.every((event) => !event.id.includes('.'))).toBe(true);
  });

  it('stops reporting once closed', async () => {
    const events: DocketEvent[] = [];
    stop = watchAudit(fixture.auditDir, (event) => events.push(event));
    stop();
    stop = null;

    await fixture.writeFinding('AC-1', { title: 'After close' });
    await delay(300);

    expect(events).toEqual([]);
  });

  it('ignores a change the platform reports with no filename', async () => {
    const events: DocketEvent[] = [];
    const listeners: ((type: string, name: string | null) => void)[] = [];
    stop = watchAudit(fixture.auditDir, (event) => events.push(event), {
      exists: (): boolean => true,
      watch: ((_dir: string, listener: (type: string, name: string | null) => void) => {
        listeners.push(listener);
        return { close: (): void => {} };
      }) as unknown as WatchDeps['watch'],
    });

    for (const listener of listeners) listener('change', null);
    await delay(150);

    expect(events).toEqual([]);
  });

  it('survives a findings directory that does not exist', () => {
    const events: DocketEvent[] = [];

    stop = watchAudit(path.join(fixture.root, 'docs', 'audits', '1999-01-01'), (event) =>
      events.push(event)
    );

    expect(events).toEqual([]);
  });
});
