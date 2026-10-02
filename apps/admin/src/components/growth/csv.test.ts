import { describe, expect, it } from 'vitest';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { campaignNarrowing, figureCeilingReachedColumn, toCsv, WHOLE_READ } from './csv.js';

/** The line the referrers export opens with where its read answered in one page, unnarrowed. */
const PREAMBLE =
  'growth-referrers: the read behind this export answered in one page. No campaign selection narrowed these rows.';

/** The reference day is a Thursday, so the week it falls in began three days earlier. */
const WEEK = isoAt(TEST_DAY_START - 3 * DAY_MS);

describe('toCsv', () => {
  it('writes the header row followed by one row per record', () => {
    const csv = toCsv({
      name: 'growth-referrers',
      extent: WHOLE_READ,
      columns: [
        { header: 'Host', value: (row: { host: string; visitors: number }) => row.host },
        { header: 'Visitors', value: (row: { host: string; visitors: number }) => row.visitors },
      ],
      rows: [
        { host: 'news.ycombinator.com', visitors: 412 },
        { host: 'reddit.com', visitors: 96 },
      ],
    });
    expect(csv).toBe(`${PREAMBLE}\nHost,Visitors\nnews.ycombinator.com,412\nreddit.com,96`);
  });

  it('writes a header-only file when there are no rows', () => {
    expect(
      toCsv({
        name: 'growth-referrers',
        extent: WHOLE_READ,
        columns: [{ header: 'Host', value: () => '' }],
        rows: [],
      })
    ).toBe(`${PREAMBLE}\nHost`);
  });

  it('quotes a value holding a comma so it stays one field', () => {
    const csv = toCsv({
      name: 'growth-referrers',
      extent: WHOLE_READ,
      columns: [{ header: 'Label', value: (row: { label: string }) => row.label }],
      rows: [{ label: 'Lex Fridman, episode 4' }],
    });
    expect(csv).toBe(`${PREAMBLE}\nLabel\n"Lex Fridman, episode 4"`);
  });

  it('doubles an embedded quote so the field survives a round trip', () => {
    const csv = toCsv({
      name: 'growth-referrers',
      extent: WHOLE_READ,
      columns: [{ header: 'Label', value: (row: { label: string }) => row.label }],
      rows: [{ label: 'the "launch" post' }],
    });
    expect(csv).toBe(`${PREAMBLE}\nLabel\n"the ""launch"" post"`);
  });

  it('quotes a value holding a newline', () => {
    const csv = toCsv({
      name: 'growth-referrers',
      extent: WHOLE_READ,
      columns: [{ header: 'Label', value: (row: { label: string }) => row.label }],
      rows: [{ label: 'one\ntwo' }],
    });
    expect(csv).toBe(`${PREAMBLE}\nLabel\n"one\ntwo"`);
  });

  it('writes an absent value as an empty field rather than the word null', () => {
    const csv = toCsv({
      name: 'growth-referrers',
      extent: WHOLE_READ,
      columns: [{ header: 'Region', value: (row: { region: string | null }) => row.region }],
      rows: [{ region: null }],
    });
    expect(csv).toBe(`${PREAMBLE}\nRegion\n`);
  });
});

describe('figureCeilingReachedColumn', () => {
  it('names the figure the flag belongs to, so a file with two flagged figures reads', () => {
    const csv = toCsv({
      name: 'growth-referrers',
      extent: WHOLE_READ,
      columns: [
        figureCeilingReachedColumn(
          'Visited (daily uniques, summed)',
          (row: { hit: boolean }) => row.hit
        ),
      ],
      rows: [{ hit: true }],
    });
    expect(csv).toBe(`${PREAMBLE}\n"Visited (daily uniques, summed): Ceiling reached"\ntrue`);
  });

  it('writes a figure that stayed inside its ceiling as false', () => {
    const csv = toCsv({
      name: 'growth-referrers',
      extent: WHOLE_READ,
      columns: [figureCeilingReachedColumn('Visited', (row: { hit: boolean }) => row.hit)],
      rows: [{ hit: false }],
    });
    expect(csv).toBe(`${PREAMBLE}\nVisited: Ceiling reached\nfalse`);
  });
});

describe('an exported file stating what it covers', () => {
  it('opens with the export it came from and says the rows below are the whole read', () => {
    const csv = toCsv({
      name: 'growth-referrers',
      extent: WHOLE_READ,
      columns: [{ header: 'Host', value: (row: { host: string }) => row.host }],
      rows: [{ host: 'reddit.com' }],
    });
    expect(csv).toBe(`${PREAMBLE}\nHost\nreddit.com`);
  });

  it('says which page a paged panel was showing, counting the reader from one', () => {
    const csv = toCsv({
      name: 'growth-events',
      extent: { page: { index: 1, hasMore: true }, campaigns: null, absentColumns: null },
      columns: [{ header: 'Event', value: (row: { event: string }) => row.event }],
      rows: [{ event: 'link:/signup' }],
    });
    expect(csv).toBe(
      'growth-events: the rows below are page 2 of what the read behind this export answered; its other pages are not in this file. No campaign selection narrowed these rows.\nEvent\nlink:/signup'
    );
  });

  it('sends a reader after no other page where the read answered in the page it holds', () => {
    const csv = toCsv({
      name: 'growth-events',
      extent: { page: { index: 0, hasMore: false }, campaigns: null, absentColumns: null },
      columns: [{ header: 'Event', value: (row: { event: string }) => row.event }],
      rows: [{ event: 'link:/signup' }],
    });
    expect(csv).toBe(
      'growth-events: the read behind this export answered in one page. No campaign selection narrowed these rows.\nEvent\nlink:/signup'
    );
  });

  it('says other pages are absent on the last page of several', () => {
    const csv = toCsv({
      name: 'growth-events',
      extent: { page: { index: 2, hasMore: false }, campaigns: null, absentColumns: null },
      columns: [{ header: 'Event', value: (row: { event: string }) => row.event }],
      rows: [{ event: 'link:/signup' }],
    });
    const [line] = csv.split('\n');
    expect(line).toBe(
      'growth-events: the rows below are page 3 of what the read behind this export answered; its other pages are not in this file. No campaign selection narrowed these rows.'
    );
  });

  it('names the campaigns a selection narrowed the rows to, and says others were dropped', () => {
    const csv = toCsv({
      name: 'growth-funnel',
      extent: {
        page: null,
        campaigns: campaignNarrowing(['podcast-ad', 'hn-launch'], []),
        absentColumns: null,
      },
      columns: [{ header: 'Campaign', value: (row: { campaign: string }) => row.campaign }],
      rows: [{ campaign: 'hn-launch' }],
    });
    expect(csv).toBe(
      '"growth-funnel: the read behind this export answered in one page. A campaign selection narrowed these rows to hn-launch, podcast-ad when this file was written; rows for other campaigns are not in this file."\nCampaign\nhn-launch'
    );
  });

  it('states both absences where the rows are one page of a narrowed read', () => {
    const csv = toCsv({
      name: 'growth-events',
      extent: {
        page: { index: 0, hasMore: true },
        campaigns: { campaigns: ['hn-launch'], unreachedFigures: [] },
        absentColumns: null,
      },
      columns: [{ header: 'Campaign', value: (row: { campaign: string }) => row.campaign }],
      rows: [{ campaign: 'hn-launch' }],
    });
    expect(csv).toBe(
      'growth-events: the rows below are page 1 of what the read behind this export answered; its other pages are not in this file. A campaign selection narrowed these rows to hn-launch when this file was written; rows for other campaigns are not in this file.\nCampaign\nhn-launch'
    );
  });

  it('treats an empty selection as no narrowing, not as every campaign', () => {
    expect(campaignNarrowing([], [])).toBeNull();
  });

  it('states no narrowing where nothing was selected, whatever a figure is scoped by', () => {
    expect(campaignNarrowing([], ['Visitors (daily uniques, summed)'])).toBeNull();
  });

  it('still says a selection missed a figure the page had no column for', () => {
    const csv = toCsv({
      name: 'growth-headline',
      extent: {
        page: null,
        campaigns: campaignNarrowing(
          ['hn-launch', 'x-thread'],
          ['Visitors (daily uniques, summed)']
        ),
        absentColumns: {
          selectedWeek: WEEK,
          columns: [
            {
              header: 'Visitors (daily uniques, summed)',
              reason: 'No whole-site row for this week.',
            },
          ],
        },
      },
      columns: [{ header: 'Week', value: (row: { week: string }) => row.week }],
      rows: [{ week: WEEK }],
    });
    const [line] = csv.split('\n');
    expect(line).toBe(
      '"growth-headline: the read behind this export answered in one page. A campaign selection narrowed these rows to hn-launch, x-thread when this file was written; rows for other campaigns are not in this file. That selection does not reach Visitors (daily uniques, summed), which count every campaign. ' +
        `The week selected when this file was written began ${WEEK}. ` +
        'Visitors (daily uniques, summed) has no column here: No whole-site row for this week."'
    );
  });

  it('says which figures a selection does not reach, so the columns it left alone say so', () => {
    const csv = toCsv({
      name: 'growth-headline',
      extent: {
        page: null,
        campaigns: campaignNarrowing(
          ['podcast-ad', 'hn-launch'],
          ['Visitors (daily uniques, summed)', 'Product entry clicks (hourly uniques, summed)']
        ),
        absentColumns: null,
      },
      columns: [{ header: 'Week', value: (row: { week: string }) => row.week }],
      rows: [{ week: WEEK }],
    });
    const [line] = csv.split('\n');
    expect(line).toBe(
      '"growth-headline: the read behind this export answered in one page. A campaign selection narrowed these rows to hn-launch, podcast-ad when this file was written; rows for other campaigns are not in this file. That selection does not reach Visitors (daily uniques, summed) and Product entry clicks (hourly uniques, summed), which count every campaign."'
    );
  });
});

describe('a file whose columns the page decided', () => {
  it('names a column it has not got, and gives the reason the page gave for it', () => {
    const csv = toCsv({
      name: 'growth-headline',
      extent: {
        page: null,
        campaigns: null,
        absentColumns: {
          selectedWeek: WEEK,
          columns: [{ header: 'First payments', reason: 'No ladder row for this week.' }],
        },
      },
      columns: [{ header: 'Week', value: (row: { week: string }) => row.week }],
      rows: [{ week: WEEK }],
    });
    const [line] = csv.split('\n');
    expect(line).toBe(
      'growth-headline: the read behind this export answered in one page. ' +
        'No campaign selection narrowed these rows. ' +
        `The week selected when this file was written began ${WEEK}. ` +
        'First payments has no column here: No ladder row for this week.'
    );
  });

  it('says nothing about absent columns where the page could name every figure', () => {
    const csv = toCsv({
      name: 'growth-headline',
      extent: {
        page: null,
        campaigns: null,
        absentColumns: { selectedWeek: WEEK, columns: [] },
      },
      columns: [{ header: 'Week', value: (row: { week: string }) => row.week }],
      rows: [{ week: WEEK }],
    });
    const [line] = csv.split('\n');
    expect(line).toBe(
      'growth-headline: the read behind this export answered in one page. No campaign selection narrowed these rows.'
    );
  });
});

describe('a ceiling column over rows that do not all carry a reading', () => {
  it('leaves the field empty where the row has no reading rather than writing a false', () => {
    const csv = toCsv({
      name: 'growth-referrers',
      extent: WHOLE_READ,
      columns: [figureCeilingReachedColumn('Visited', (row: { hit: boolean | null }) => row.hit)],
      rows: [{ hit: true }, { hit: null }],
    });
    expect(csv).toBe(`${PREAMBLE}\nVisited: Ceiling reached\ntrue\n`);
  });
});
