import { and, eq } from 'drizzle-orm';
import { conversations, payments, type Database } from '@lome-chat/db';

export class ResourceNotFoundError extends Error {
  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = 'ResourceNotFoundError';
  }
}

export async function getOwnedConversation(
  db: Database,
  conversationId: string,
  userId: string
): Promise<typeof conversations.$inferSelect> {
  const [conversation] = await db
    .select()
    .from(conversations)
    .where(and(eq(conversations.id, conversationId), eq(conversations.userId, userId)));

  if (!conversation) {
    throw new ResourceNotFoundError('Conversation');
  }

  return conversation;
}

export async function getOwnedPayment(
  db: Database,
  paymentId: string,
  userId: string
): Promise<typeof payments.$inferSelect> {
  const [payment] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.userId, userId)));

  if (!payment) {
    throw new ResourceNotFoundError('Payment');
  }

  return payment;
}
