import { and, asc, desc, eq, gte, isNotNull, lt, lte, ne, sql } from 'drizzle-orm';
import { ledgerEntries, wallets } from '@hushbox/db';
import { fromPromise } from '../../../lib/result/index.js';
import { requireRow, storeFailure } from './store-failure.js';
import type { Database } from '@hushbox/db';
import type { SettlementTx } from '../../../lib/idempotency/index.js';
import type { BillingStores, LedgerLegInput, WalletRecord, WalletType } from '../ports/index.js';

function toWalletRecord(row: {
  id: string;
  type: WalletType;
  balanceNanoUsd: bigint;
  ledgerSeq: bigint;
}): WalletRecord {
  return {
    id: row.id,
    type: row.type,
    balanceNanoUsd: row.balanceNanoUsd,
    ledgerSeq: row.ledgerSeq,
  };
}

/**
 * The row shape shared by both ledger writers (plain insert and guarded
 * insert-if-absent): optional leg fields spread in only when present. The two
 * writers must post identical leg shapes, so the mapping lives in one place.
 */
function toLedgerLegRow(leg: LedgerLegInput): typeof ledgerEntries.$inferInsert {
  return {
    transactionId: leg.transactionId,
    kind: leg.kind,
    amountNanoUsd: leg.amountNanoUsd,
    idempotencyKey: leg.idempotencyKey,
    ...(leg.walletId === undefined ? {} : { walletId: leg.walletId }),
    ...(leg.balanceAfterNanoUsd === undefined
      ? {}
      : { balanceAfterNanoUsd: leg.balanceAfterNanoUsd }),
    ...(leg.houseAccount === undefined ? {} : { houseAccount: leg.houseAccount }),
    ...(leg.usageRecordId === undefined ? {} : { usageRecordId: leg.usageRecordId }),
    ...(leg.paymentId === undefined ? {} : { paymentId: leg.paymentId }),
  };
}

/**
 * The wallet and double-entry ledger part of the slice's repository: the
 * settlement-time wallet and leg writes, the reads over both, and the
 * conservation auditors' queries.
 */
export function createWalletLedgerStores(): Pick<
  BillingStores,
  | 'insertWalletIfAbsentWithinTx'
  | 'lockWalletWithinTx'
  | 'updateWalletBalanceWithinTx'
  | 'insertLedgerLegsWithinTx'
  | 'insertLedgerLegsIfAbsentWithinTx'
  | 'readWallets'
  | 'readWalletSnapshot'
  | 'readLedgerHistory'
  | 'listLedgerTransactions'
  | 'findUnbalancedTransactions'
  | 'findWalletDrift'
> {
  return {
    async insertWalletIfAbsentWithinTx(tx: SettlementTx, userId: string, type: WalletType) {
      const inserted = await tx
        .insert(wallets)
        .values({ userId, type })
        .onConflictDoNothing({ target: [wallets.userId, wallets.type] })
        .returning({ id: wallets.id });
      const created = inserted[0];
      if (created !== undefined) return { id: created.id, created: true };
      const existing = await tx
        .select({ id: wallets.id })
        .from(wallets)
        .where(and(eq(wallets.userId, userId), eq(wallets.type, type)));
      return {
        id: requireRow(existing[0], 'wallet insert conflicted but no row exists').id,
        created: false,
      };
    },

    async lockWalletWithinTx(tx: SettlementTx, walletId: string) {
      const rows = await tx
        .select({
          id: wallets.id,
          type: wallets.type,
          balanceNanoUsd: wallets.balanceNanoUsd,
          ledgerSeq: wallets.ledgerSeq,
        })
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .for('update');
      return toWalletRecord(requireRow(rows[0], 'wallet to lock does not exist'));
    },

    async updateWalletBalanceWithinTx(
      tx: SettlementTx,
      walletId: string,
      balanceNanoUsd: bigint,
      ledgerSeq: bigint
    ) {
      const updated = await tx
        .update(wallets)
        .set({ balanceNanoUsd, ledgerSeq })
        .where(eq(wallets.id, walletId))
        .returning({ id: wallets.id });
      requireRow(updated[0], 'wallet balance update affected no row');
    },

    async insertLedgerLegsWithinTx(tx, legs) {
      if (legs.length === 0) {
        throw new Error('billing store: a ledger write needs at least one leg');
      }
      await tx.insert(ledgerEntries).values(legs.map((leg) => toLedgerLegRow(leg)));
    },

    async insertLedgerLegsIfAbsentWithinTx(tx, legs) {
      if (legs.length === 0) {
        throw new Error('billing store: a ledger write needs at least one leg');
      }
      const inserted = await tx
        .insert(ledgerEntries)
        .values(legs.map((leg) => toLedgerLegRow(leg)))
        .onConflictDoNothing({ target: ledgerEntries.idempotencyKey })
        .returning({ id: ledgerEntries.id });
      if (inserted.length === legs.length) return true;
      if (inserted.length === 0) return false;
      // Both keys derive from one event, so a partial hit means corrupt data.
      throw new Error('billing store: guarded ledger insert landed partially');
    },

    readWallets(db: Database, userId: string) {
      return fromPromise(
        db
          .select({
            id: wallets.id,
            type: wallets.type,
            balanceNanoUsd: wallets.balanceNanoUsd,
            ledgerSeq: wallets.ledgerSeq,
          })
          .from(wallets)
          .where(eq(wallets.userId, userId)),
        storeFailure
      ).map((rows) => rows.map((row) => toWalletRecord(row)));
    },

    readWalletSnapshot(db: Database, walletId: string) {
      return fromPromise(
        db
          .select({
            balanceNanoUsd: wallets.balanceNanoUsd,
            ledgerSeq: wallets.ledgerSeq,
            type: wallets.type,
          })
          .from(wallets)
          .where(eq(wallets.id, walletId)),
        storeFailure
      ).map((rows) => rows[0] ?? null);
    },

    readLedgerHistory(db, args) {
      return fromPromise(
        db
          .select({
            createdAt: ledgerEntries.createdAt,
            balanceAfterNanoUsd: sql<bigint>`${ledgerEntries.balanceAfterNanoUsd}`.mapWith(BigInt),
            kind: ledgerEntries.kind,
            amountNanoUsd: ledgerEntries.amountNanoUsd,
          })
          .from(ledgerEntries)
          .innerJoin(wallets, eq(ledgerEntries.walletId, wallets.id))
          .where(
            and(
              eq(wallets.userId, args.userId),
              gte(ledgerEntries.createdAt, args.start),
              lte(ledgerEntries.createdAt, args.end)
            )
          )
          .orderBy(asc(ledgerEntries.createdAt))
          .limit(args.limit),
        storeFailure
      );
    },

    listLedgerTransactions(db, query) {
      // User-wallet legs only (the join restricts to them); newest-first, one
      // extra row to probe a next page.
      const conditions = [eq(wallets.userId, query.userId)];
      if (query.kind !== undefined) conditions.push(eq(ledgerEntries.kind, query.kind));
      if (query.cursor !== undefined) conditions.push(lt(ledgerEntries.createdAt, query.cursor));
      const base = db
        .select({
          id: ledgerEntries.id,
          amountNanoUsd: ledgerEntries.amountNanoUsd,
          balanceAfterNanoUsd: sql<bigint>`${ledgerEntries.balanceAfterNanoUsd}`.mapWith(BigInt),
          kind: ledgerEntries.kind,
          paymentId: ledgerEntries.paymentId,
          createdAt: ledgerEntries.createdAt,
        })
        .from(ledgerEntries)
        .innerJoin(wallets, eq(ledgerEntries.walletId, wallets.id))
        .where(and(...conditions))
        .orderBy(desc(ledgerEntries.createdAt))
        .limit(query.limit);
      return fromPromise(
        query.offset === undefined ? base : base.offset(query.offset),
        storeFailure
      );
    },

    findUnbalancedTransactions(db: Database, limit: number) {
      return fromPromise(
        db
          .select({
            transactionId: ledgerEntries.transactionId,
            totalNanoUsd: sql<bigint>`sum(${ledgerEntries.amountNanoUsd})`.mapWith(BigInt),
          })
          .from(ledgerEntries)
          .groupBy(ledgerEntries.transactionId)
          .having(sql`sum(${ledgerEntries.amountNanoUsd}) <> 0`)
          // The LIMIT caps the paged sample, so without a total order which
          // violations surface is arbitrary and irreproducible across cron
          // runs; newest-first keeps the sample deterministic and puts the
          // most recently introduced break at the top.
          .orderBy(sql`max(${ledgerEntries.createdAt}) desc`)
          .limit(limit),
        storeFailure
      );
    },

    findWalletDrift(db: Database, limit: number) {
      return fromPromise(
        db
          .select({
            walletId: wallets.id,
            balanceNanoUsd: wallets.balanceNanoUsd,
            legSumNanoUsd: sql<bigint>`coalesce(sum(${ledgerEntries.amountNanoUsd}), 0)`.mapWith(
              BigInt
            ),
          })
          .from(wallets)
          .leftJoin(
            ledgerEntries,
            and(eq(ledgerEntries.walletId, wallets.id), isNotNull(ledgerEntries.walletId))
          )
          .groupBy(wallets.id)
          .having(ne(wallets.balanceNanoUsd, sql`coalesce(sum(${ledgerEntries.amountNanoUsd}), 0)`))
          // Deterministic, newest-first over the uuidv7 PK (time-ordered): the
          // LIMIT caps the paged sample, so without an order which drifting
          // wallets surface is arbitrary and irreproducible across cron runs.
          .orderBy(desc(wallets.id))
          .limit(limit),
        storeFailure
      );
    },
  };
}
