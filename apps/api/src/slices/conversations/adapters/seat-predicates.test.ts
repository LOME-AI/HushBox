import { describe, expect, it } from 'vitest';
import { alias, PgDialect } from 'drizzle-orm/pg-core';
import { conversationMembers } from '@hushbox/db';
import { activeInConversation, notLeft } from './seat-predicates.js';
import type { SQL } from 'drizzle-orm';

const dialect = new PgDialect();

function rendered(predicate: SQL | undefined): string {
  if (predicate === undefined) throw new Error('predicate built nothing');
  return dialect.sqlToQuery(predicate).sql;
}

describe('notLeft', () => {
  it('tests the unaliased member table for a seat not left', () => {
    expect(rendered(notLeft(conversationMembers))).toBe('"conversation_members"."left_at" is null');
  });

  it('tests an alias of the member table through that alias', () => {
    const seat = alias(conversationMembers, 'seat');
    expect(rendered(notLeft(seat))).toBe('"seat"."left_at" is null');
  });
});

describe('activeInConversation', () => {
  it('admits seats not left in the one conversation named', () => {
    expect(rendered(activeInConversation('conversation-a'))).toBe(
      '("conversation_members"."conversation_id" = $1 and "conversation_members"."left_at" is null)'
    );
  });

  it('admits seats not left in any conversation of the set named', () => {
    expect(rendered(activeInConversation(['conversation-a', 'conversation-b']))).toBe(
      '("conversation_members"."conversation_id" in ($1, $2) and "conversation_members"."left_at" is null)'
    );
  });
});
