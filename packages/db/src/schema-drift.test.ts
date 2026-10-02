import { describe, it, expect } from 'vitest';

import {
  HARNESS_RELATIONS,
  assertSameDatabase,
  catalogFromRows,
  latestEntry,
  renderedTypes,
  compareSchema,
  expectationFrom,
  formatDrift,
  parseSnapshot,
  readLatestSnapshot,
} from './schema-drift';

import type { Divergence, LiveCatalog, MigrationSnapshot, SnapshotTable } from './schema-drift';

const TABLE: SnapshotTable = {
  name: 'widgets',
  schema: '',
  columns: { id: { name: 'id', type: 'uuid', primaryKey: true, notNull: true } },
  indexes: { widgets_name_idx: { name: 'widgets_name_idx' } },
  foreignKeys: {},
  compositePrimaryKeys: {},
  uniqueConstraints: { widgets_id_unique: { name: 'widgets_id_unique' } },
  checkConstraints: {},
};

const SNAPSHOT: MigrationSnapshot = {
  tables: { 'public.widgets': TABLE },
  views: {
    'public.widget_totals': {
      name: 'widget_totals',
      schema: 'public',
      columns: { total: { name: 'total', type: 'integer', notNull: true } },
    },
  },
  enums: {
    'public.widget_kind': { name: 'widget_kind', schema: 'public', values: ['round', 'square'] },
  },
};

const MATCHING: LiveCatalog = {
  relations: [
    { name: 'widgets', isView: false },
    { name: 'widget_totals', isView: true },
  ],
  columns: [
    { relation: 'widgets', column: 'id', type: 'uuid', notNull: true },
    { relation: 'widget_totals', column: 'total', type: 'integer', notNull: false },
  ],
  enums: [{ name: 'widget_kind', values: ['round', 'square'] }],
  indexes: ['widgets_name_idx'],
  constraints: ['widgets_pkey', 'widgets_id_unique'],
};

const IDENTITY_TYPES = new Map([
  ['uuid', 'uuid'],
  ['integer', 'integer'],
]);

/** The live relations with `name` dropped, whatever kind it is. */
function without(name: string): LiveCatalog {
  return {
    ...MATCHING,
    relations: MATCHING.relations.filter((relation) => relation.name !== name),
    columns: MATCHING.columns.filter((column) => column.relation !== name),
  };
}

function compare(live: LiveCatalog, snapshot: MigrationSnapshot = SNAPSHOT): Divergence[] {
  return compareSchema(expectationFrom(snapshot), live, IDENTITY_TYPES);
}

describe('schema comparison', () => {
  it('reports nothing when the database holds what the snapshot records', () => {
    expect(compare(MATCHING)).toEqual([]);
  });

  it('names a table the snapshot records and the database does not hold', () => {
    expect(compare(without('widgets'))).toEqual([
      { kind: 'table', direction: 'absent', name: 'widgets' },
    ]);
  });

  it('names a table the database holds and the snapshot records nowhere', () => {
    expect(
      compare({
        ...MATCHING,
        relations: [...MATCHING.relations, { name: 'leftovers', isView: false }],
      })
    ).toEqual([{ kind: 'table', direction: 'unexpected', name: 'leftovers' }]);
  });

  it('names a view the snapshot records and the database does not hold', () => {
    expect(compare(without('widget_totals'))).toEqual([
      { kind: 'view', direction: 'absent', name: 'widget_totals' },
    ]);
  });

  it('names a view the database holds and the snapshot records nowhere', () => {
    expect(
      compare({
        ...MATCHING,
        relations: [...MATCHING.relations, { name: 'widget_old', isView: true }],
      })
    ).toEqual([{ kind: 'view', direction: 'unexpected', name: 'widget_old' }]);
  });

  it('names a column the snapshot records and the table does not hold', () => {
    expect(
      compare({
        ...MATCHING,
        columns: MATCHING.columns.filter((column) => column.column !== 'id'),
      })
    ).toEqual([{ kind: 'column', direction: 'absent', name: 'widgets.id' }]);
  });

  it('names a column the table holds and the snapshot records nowhere', () => {
    expect(
      compare({
        ...MATCHING,
        columns: [
          ...MATCHING.columns,
          { relation: 'widgets', column: 'legacy', type: 'text', notNull: false },
        ],
      })
    ).toEqual([{ kind: 'column', direction: 'unexpected', name: 'widgets.legacy' }]);
  });

  it('reports a missing table once rather than once per column it took with it', () => {
    expect(compare(without('widgets'))).toEqual([
      { kind: 'table', direction: 'absent', name: 'widgets' },
    ]);
  });

  it('names a column whose type is not the one the snapshot records', () => {
    expect(
      compare({
        ...MATCHING,
        columns: MATCHING.columns.map((column) =>
          column.column === 'id' ? { ...column, type: 'text' } : column
        ),
      })
    ).toEqual([
      {
        kind: 'column',
        direction: 'differs',
        name: 'widgets.id',
        detail: 'the migrations record type uuid; the database has text',
      },
    ]);
  });

  it('matches a type the snapshot and the database spell differently', () => {
    const snapshot: MigrationSnapshot = {
      ...SNAPSHOT,
      tables: {
        'public.widgets': {
          ...TABLE,
          columns: { id: { name: 'id', type: 'varchar(20)', notNull: true } },
        },
      },
    };
    const live: LiveCatalog = {
      ...MATCHING,
      columns: MATCHING.columns.map((column) =>
        column.column === 'id' ? { ...column, type: 'character varying(20)' } : column
      ),
    };

    expect(
      compareSchema(
        expectationFrom(snapshot),
        live,
        new Map([
          ['varchar(20)', 'character varying(20)'],
          ['integer', 'integer'],
        ])
      )
    ).toEqual([]);
  });

  it('names a table column the database lets hold nulls where the snapshot does not', () => {
    expect(
      compare({
        ...MATCHING,
        columns: MATCHING.columns.map((column) =>
          column.column === 'id' ? { ...column, notNull: false } : column
        ),
      })
    ).toEqual([
      {
        kind: 'column',
        direction: 'differs',
        name: 'widgets.id',
        detail: 'the migrations record it NOT NULL; the database lets it hold nulls',
      },
    ]);
  });

  it('leaves a view column the snapshot records NOT NULL alone, the catalog calling every view column nullable', () => {
    const viewColumn = MATCHING.columns.find((column) => column.relation === 'widget_totals');

    expect(viewColumn?.notNull).toBe(false);
    expect(
      compare(MATCHING).filter((divergence) => divergence.name.startsWith('widget_totals'))
    ).toEqual([]);
  });

  it('names an enum the snapshot records and the database does not hold', () => {
    expect(compare({ ...MATCHING, enums: [] })).toEqual([
      { kind: 'enum', direction: 'absent', name: 'widget_kind' },
    ]);
  });

  it('names an enum the database holds and the snapshot records nowhere', () => {
    expect(
      compare({ ...MATCHING, enums: [...MATCHING.enums, { name: 'widget_era', values: ['old'] }] })
    ).toEqual([{ kind: 'enum', direction: 'unexpected', name: 'widget_era' }]);
  });

  it('names an enum whose values are not the ones the snapshot records', () => {
    expect(compare({ ...MATCHING, enums: [{ name: 'widget_kind', values: ['round'] }] })).toEqual([
      {
        kind: 'enum',
        direction: 'differs',
        name: 'widget_kind',
        detail: 'the migrations record values round, square; the database has round',
      },
    ]);
  });

  it('names an enum whose values the database holds in another order', () => {
    expect(
      compare({ ...MATCHING, enums: [{ name: 'widget_kind', values: ['square', 'round'] }] })
    ).toEqual([
      {
        kind: 'enum',
        direction: 'differs',
        name: 'widget_kind',
        detail: 'the migrations record values round, square; the database has square, round',
      },
    ]);
  });

  it('names an index the snapshot records and the database does not hold', () => {
    expect(compare({ ...MATCHING, indexes: [] })).toEqual([
      { kind: 'index', direction: 'absent', name: 'widgets_name_idx' },
    ]);
  });

  it('names an index the database holds and the snapshot records nowhere', () => {
    expect(compare({ ...MATCHING, indexes: [...MATCHING.indexes, 'widgets_spare_idx'] })).toEqual([
      { kind: 'index', direction: 'unexpected', name: 'widgets_spare_idx' },
    ]);
  });

  it('names a constraint the snapshot records and the database does not hold', () => {
    expect(compare({ ...MATCHING, constraints: ['widgets_pkey'] })).toEqual([
      { kind: 'constraint', direction: 'absent', name: 'widgets_id_unique' },
    ]);
  });

  it('names the primary key the snapshot records through a column rather than a constraint', () => {
    expect(compare({ ...MATCHING, constraints: ['widgets_id_unique'] })).toEqual([
      { kind: 'constraint', direction: 'absent', name: 'widgets_pkey' },
    ]);
  });

  it('leaves alone a constraint the database holds and the snapshot records nowhere', () => {
    expect(
      compare({ ...MATCHING, constraints: [...MATCHING.constraints, 'widgets_hand_written_fk'] })
    ).toEqual([]);
  });

  it('compares a constraint name longer than an identifier truncated the way the database stores it', () => {
    const long = `widgets_${'x'.repeat(70)}_fk`;
    const snapshot: MigrationSnapshot = {
      ...SNAPSHOT,
      tables: {
        'public.widgets': { ...TABLE, foreignKeys: { [long]: { name: long } } },
      },
    };

    expect(
      compareSchema(
        expectationFrom(snapshot),
        { ...MATCHING, constraints: [...MATCHING.constraints, long.slice(0, 63)] },
        IDENTITY_TYPES
      )
    ).toEqual([]);
  });

  it('leaves alone the bookkeeping relations the local stack installs outside the chain', () => {
    const harness = [...HARNESS_RELATIONS];

    expect(harness.length).toBeGreaterThan(0);
    expect(
      compare({
        ...MATCHING,
        relations: [...MATCHING.relations, ...harness.map((name) => ({ name, isView: false }))],
        columns: [
          ...MATCHING.columns,
          ...harness.map((name) => ({
            relation: name,
            column: 'dirty',
            type: 'boolean',
            notNull: true,
          })),
        ],
      })
    ).toEqual([]);
  });
});

describe('drift report', () => {
  it('names the migration whose recorded schema the database was compared against', () => {
    expect(formatDrift('0081_optimal_miss_america', [])).toContain('0081_optimal_miss_america');
  });

  it('says of an absent object that the migrations record it and the database lacks it', () => {
    expect(
      formatDrift('0001_first', [{ kind: 'view', direction: 'absent', name: 'growth_weekly' }])
    ).toContain('view growth_weekly: the migrations record it; the database does not have it');
  });

  it('says of an unexpected object that the database holds it and no migration records it', () => {
    expect(
      formatDrift('0001_first', [{ kind: 'view', direction: 'unexpected', name: 'growth_old' }])
    ).toContain('view growth_old: the database has it; the recorded schema does not describe it');
  });

  it('carries a differing object the detail that says how the two disagree', () => {
    expect(
      formatDrift('0001_first', [
        {
          kind: 'column',
          direction: 'differs',
          name: 'users.username',
          detail: 'the migrations record type character varying(20); the database has text',
        },
      ])
    ).toContain(
      'column users.username: the migrations record type character varying(20); the database has text'
    );
  });

  it('opens on a line of its own, the step before it leaving its last line unterminated', () => {
    expect(formatDrift('0001_first', []).startsWith('\nSchema drift:')).toBe(true);
  });

  it('states what the comparison did not cover, so the reader does not read more into it', () => {
    const report = formatDrift('0001_first', []);

    expect(report).toContain('the text of view and check-constraint definitions');
    expect(report).toContain('verify:db-objects');
  });
});

describe('snapshot reader', () => {
  it('reads the snapshot of the migration the journal ends with', () => {
    const { tag, snapshot } = readLatestSnapshot();

    expect(tag).toMatch(/^\d{4}_/);
    expect(Object.keys(snapshot.tables).length).toBeGreaterThan(0);
  });

  it('refuses a snapshot that records no table, which nothing could be compared against', () => {
    expect(() => parseSnapshot({ tables: {}, views: {}, enums: {} }, '0001')).toThrow(
      'records no table'
    );
  });

  it('refuses a snapshot whose shape it does not recognise', () => {
    expect(() => parseSnapshot({ tables: 'all of them' }, '0001')).toThrow('shape');
  });

  it('refuses a table outside the schema the comparison reads', () => {
    expect(() =>
      parseSnapshot(
        { tables: { 'other.widgets': { ...TABLE, schema: 'other' } }, views: {}, enums: {} },
        '0001'
      )
    ).toThrow('other.widgets');
  });

  it('refuses a view outside the schema the comparison reads', () => {
    expect(() =>
      parseSnapshot(
        {
          tables: { 'public.widgets': TABLE },
          views: { 'other.totals': { name: 'totals', schema: 'other', columns: {} } },
          enums: {},
        },
        '0001'
      )
    ).toThrow('other.totals');
  });
});

describe('report order', () => {
  it('reads the same whatever order the divergences were found in', () => {
    const divergences: Divergence[] = [
      { kind: 'view', direction: 'unexpected', name: 'b_view' },
      { kind: 'table', direction: 'absent', name: 'z_table' },
      { kind: 'view', direction: 'absent', name: 'a_view' },
      { kind: 'view', direction: 'absent', name: 'b_view' },
    ];

    expect(formatDrift('0001_first', divergences)).toBe(
      formatDrift('0001_first', divergences.toReversed())
    );
    expect(formatDrift('0001_first', divergences).split('\n').slice(2, 6)).toEqual([
      '  table z_table: the migrations record it; the database does not have it',
      '  view a_view: the migrations record it; the database does not have it',
      '  view b_view: the migrations record it; the database does not have it',
      '  view b_view: the database has it; the recorded schema does not describe it',
    ]);
  });

  it('says the two disagree when a difference carries no detail of its own', () => {
    expect(
      formatDrift('0001_first', [{ kind: 'enum', direction: 'differs', name: 'kind' }])
    ).toContain('enum kind: the migrations and the database disagree about it');
  });
});

describe('answers a database gives back', () => {
  it('refuses a journal that ends with no migration', () => {
    expect(() => latestEntry([])).toThrow('records no migration');
  });

  it('refuses a catalog read that answered no row', () => {
    expect(() => catalogFromRows([])).toThrow('no catalog');
  });

  it('drops a recorded type this database does not know', () => {
    expect(renderedTypes([{ types: { uuid: 'uuid', mystery: null } }])).toEqual(
      new Map([['uuid', 'uuid']])
    );
  });

  it('renders no type when the database answered no row', () => {
    expect(renderedTypes([])).toEqual(new Map());
  });
});

describe('connection agreement', () => {
  it('accepts two connection strings that reach one database by different transports', () => {
    expect(() => {
      assertSameDatabase(
        'postgres://postgres:secret@localhost:10700/hushbox',
        'postgresql://postgres:secret@localhost:10600/hushbox'
      );
    }).not.toThrow();
  });

  it('refuses a pair naming different databases, which would read one and migrate the other', () => {
    expect(() => {
      assertSameDatabase(
        'postgres://postgres:secret@localhost:10700/hushbox',
        'postgresql://postgres:secret@localhost:10600/hushbox_test'
      );
    }).toThrow('hushbox_test');
  });

  it('refuses a pair naming different hosts', () => {
    expect(() => {
      assertSameDatabase(
        'postgres://postgres:secret@localhost:10700/hushbox',
        'postgresql://postgres:secret@db.example.test:10600/hushbox'
      );
    }).toThrow('db.example.test');
  });

  it('keeps the credentials out of what it says', () => {
    expect(() => {
      assertSameDatabase(
        'postgres://postgres:secret@localhost:10700/hushbox',
        'postgresql://postgres:secret@localhost:10600/other'
      );
    }).toThrow(/^(?!.*secret).*$/s);
  });
});

describe('column comparison at the edges', () => {
  it('names a table column the database holds NOT NULL where the snapshot does not', () => {
    const snapshot: MigrationSnapshot = {
      ...SNAPSHOT,
      tables: {
        'public.widgets': { ...TABLE, columns: { id: { name: 'id', type: 'uuid' } } },
      },
    };

    expect(compareSchema(expectationFrom(snapshot), MATCHING, IDENTITY_TYPES)).toEqual([
      {
        kind: 'column',
        direction: 'differs',
        name: 'widgets.id',
        detail: 'the migrations record it nullable; the database has it NOT NULL',
      },
    ]);
  });

  it('keeps the recorded spelling of a type the database could not render', () => {
    expect(compareSchema(expectationFrom(SNAPSHOT), MATCHING, new Map())).toEqual([]);
  });
});
