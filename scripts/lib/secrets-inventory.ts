/**
 * The credential inventory as the secrets document prints it: one Markdown row
 * per declaration, in the table shape Prettier leaves untouched, because the
 * block is drift-checked byte for byte.
 */
import path from 'node:path';
import { runbookPath, type Credential } from '../../packages/shared/src/env/env-types.js';

const INVENTORY_COLUMNS = [
  'Name',
  'Family',
  'Store',
  'Description',
  'Replace',
  'On loss',
  'Escrowed',
  'User-visible',
  'Coupled with',
  'Leak impact',
] as const;

type InventoryColumn = (typeof INVENTORY_COLUMNS)[number];
type InventoryRow = Readonly<Record<InventoryColumn, string>>;

/** Prose in a table cell: a bare pipe would end the cell. */
function tableCell(text: string): string {
  return text.replaceAll('|', String.raw`\|`);
}

/**
 * Whether the escrow captures this credential. The loss class is the stance and
 * the only field that decides it: a second `backup` field would equal the loss
 * class for every credential, and two fields that must agree are the sync
 * contract `docs/CODE-RULES.md` bans.
 */
export function isEscrowed(credential: Credential): boolean {
  return credential.onLoss === 'restoreFromCopy';
}

/** One inventory row; the family links to its runbook relative to the document. */
function inventoryRow(
  [name, credential]: readonly [string, Credential],
  documentPath: string
): InventoryRow {
  const runbook = path.posix.relative(
    path.posix.dirname(documentPath),
    runbookPath(credential.family)
  );
  return {
    Name: `\`${name}\``,
    Family: `[${credential.family}](${runbook})`,
    Store: credential.store,
    Description: tableCell(credential.description),
    Replace: credential.replace,
    'On loss': credential.onLoss,
    Escrowed: isEscrowed(credential) ? 'yes' : '',
    'User-visible': tableCell(credential.userVisible),
    'Coupled with': (credential.coupledWith ?? []).map((other) => `\`${other}\``).join(', '),
    'Leak impact': credential.leakImpact,
  };
}

/**
 * A Markdown table in the shape Prettier prints, so the block is formatted as
 * written: every cell padded to its column's widest entry, three at least, and
 * the rule row filled to that width. Widths are code-unit lengths, which are
 * Prettier's display widths while every cell is ASCII.
 */
function markdownTable(rows: readonly InventoryRow[]): string {
  const widths = Object.fromEntries(
    INVENTORY_COLUMNS.map((column) => [
      column,
      Math.max(3, column.length, ...rows.map((row) => row[column].length)),
    ])
  ) as Record<InventoryColumn, number>;
  const line = (cell: (column: InventoryColumn) => string): string =>
    `| ${INVENTORY_COLUMNS.map((column) => cell(column).padEnd(widths[column])).join(' | ')} |`;

  return (
    [
      line((column) => column),
      line((column) => '-'.repeat(widths[column])),
      ...rows.map((row) => line((column) => row[column])),
    ].join('\n') + '\n'
  );
}

/**
 * The inventory table of `declarations`, in the order given, for the document
 * at `documentPath`: each row's runbook link is relative to that document.
 */
export function inventoryTable(
  declarations: readonly (readonly [string, Credential])[],
  documentPath: string
): string {
  return markdownTable(declarations.map((declaration) => inventoryRow(declaration, documentPath)));
}
