import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import type { z } from 'zod';
import { z as zodInstance } from 'zod';

import {
  conversationMembers,
  conversationSpending,
  conversations,
  epochMembers,
  epochs,
  ledgerEntries,
  llmCompletions,
  memberBudgets,
  messages,
  payments,
  projects,
  serviceEvidence,
  sharedLinks,
  sharedMessages,
  usageRecords,
  users,
  wallets,
} from '../schema/index';

// --- Users ---
export const selectUserSchema = createSelectSchema(users, {
  opaqueRegistration: () => zodInstance.instanceof(Uint8Array),
  publicKey: () => zodInstance.instanceof(Uint8Array),
  passwordWrappedPrivateKey: () => zodInstance.instanceof(Uint8Array),
  recoveryWrappedPrivateKey: () => zodInstance.instanceof(Uint8Array),
});
export const insertUserSchema = createInsertSchema(users);

// --- Conversations ---
export const selectConversationSchema = createSelectSchema(conversations, {
  title: () => zodInstance.instanceof(Uint8Array),
});
export const insertConversationSchema = createInsertSchema(conversations, {
  title: () => zodInstance.instanceof(Uint8Array),
});

// --- Messages ---
export const selectMessageSchema = createSelectSchema(messages, {
  encryptedBlob: () => zodInstance.instanceof(Uint8Array),
});
export const insertMessageSchema = createInsertSchema(messages, {
  encryptedBlob: () => zodInstance.instanceof(Uint8Array),
});

// --- Projects ---
export const selectProjectSchema = createSelectSchema(projects, {
  encryptedName: () => zodInstance.instanceof(Uint8Array),
  encryptedDescription: () => zodInstance.instanceof(Uint8Array).nullable(),
});
export const insertProjectSchema = createInsertSchema(projects, {
  encryptedName: () => zodInstance.instanceof(Uint8Array),
  encryptedDescription: () => zodInstance.instanceof(Uint8Array).nullable(),
});

// --- Payments ---
export const selectPaymentSchema = createSelectSchema(payments);
export const insertPaymentSchema = createInsertSchema(payments);

// --- Service Evidence ---
export const selectServiceEvidenceSchema = createSelectSchema(serviceEvidence);
export const insertServiceEvidenceSchema = createInsertSchema(serviceEvidence);

// --- Wallets ---
export const selectWalletSchema = createSelectSchema(wallets);
export const insertWalletSchema = createInsertSchema(wallets);

// --- Usage Records ---
export const selectUsageRecordSchema = createSelectSchema(usageRecords);
export const insertUsageRecordSchema = createInsertSchema(usageRecords);

// --- LLM Completions ---
export const selectLlmCompletionSchema = createSelectSchema(llmCompletions);
export const insertLlmCompletionSchema = createInsertSchema(llmCompletions);

// --- Ledger Entries ---
export const selectLedgerEntrySchema = createSelectSchema(ledgerEntries);
export const insertLedgerEntrySchema = createInsertSchema(ledgerEntries);

// --- Shared Links ---
export const selectSharedLinkSchema = createSelectSchema(sharedLinks, {
  linkPublicKey: () => zodInstance.instanceof(Uint8Array),
});
export const insertSharedLinkSchema = createInsertSchema(sharedLinks, {
  linkPublicKey: () => zodInstance.instanceof(Uint8Array),
});

// --- Conversation Members ---
export const selectConversationMemberSchema = createSelectSchema(conversationMembers);
export const insertConversationMemberSchema = createInsertSchema(conversationMembers);

// --- Epochs ---
export const selectEpochSchema = createSelectSchema(epochs, {
  epochPublicKey: () => zodInstance.instanceof(Uint8Array),
  confirmationHash: () => zodInstance.instanceof(Uint8Array),
  chainLink: () => zodInstance.instanceof(Uint8Array).nullable(),
});
export const insertEpochSchema = createInsertSchema(epochs, {
  epochPublicKey: () => zodInstance.instanceof(Uint8Array),
  confirmationHash: () => zodInstance.instanceof(Uint8Array),
  chainLink: () => zodInstance.instanceof(Uint8Array).nullable(),
});

// --- Epoch Members ---
export const selectEpochMemberSchema = createSelectSchema(epochMembers, {
  memberPublicKey: () => zodInstance.instanceof(Uint8Array),
  wrap: () => zodInstance.instanceof(Uint8Array),
});
export const insertEpochMemberSchema = createInsertSchema(epochMembers, {
  memberPublicKey: () => zodInstance.instanceof(Uint8Array),
  wrap: () => zodInstance.instanceof(Uint8Array),
});

// --- Shared Messages ---
export const selectSharedMessageSchema = createSelectSchema(sharedMessages, {
  shareBlob: () => zodInstance.instanceof(Uint8Array),
});
export const insertSharedMessageSchema = createInsertSchema(sharedMessages, {
  shareBlob: () => zodInstance.instanceof(Uint8Array),
});

// --- Member Budgets ---
export const selectMemberBudgetSchema = createSelectSchema(memberBudgets);
export const insertMemberBudgetSchema = createInsertSchema(memberBudgets);

// --- Conversation Spending ---
export const selectConversationSpendingSchema = createSelectSchema(conversationSpending);
export const insertConversationSpendingSchema = createInsertSchema(conversationSpending);

// --- Type Exports ---
export type User = typeof users.$inferSelect;
export type NewUser = z.infer<typeof insertUserSchema>;
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = z.infer<typeof insertConversationSchema>;
export type Message = typeof messages.$inferSelect;
export type NewMessage = z.infer<typeof insertMessageSchema>;
export type Project = z.infer<typeof selectProjectSchema>;
export type NewProject = z.infer<typeof insertProjectSchema>;
export type Payment = z.infer<typeof selectPaymentSchema>;
export type NewPayment = z.infer<typeof insertPaymentSchema>;
export type ServiceEvidence = z.infer<typeof selectServiceEvidenceSchema>;
export type NewServiceEvidence = z.infer<typeof insertServiceEvidenceSchema>;
export type Wallet = z.infer<typeof selectWalletSchema>;
export type NewWallet = z.infer<typeof insertWalletSchema>;
export type UsageRecord = z.infer<typeof selectUsageRecordSchema>;
export type NewUsageRecord = z.infer<typeof insertUsageRecordSchema>;
export type LlmCompletion = z.infer<typeof selectLlmCompletionSchema>;
export type NewLlmCompletion = z.infer<typeof insertLlmCompletionSchema>;
export type LedgerEntry = z.infer<typeof selectLedgerEntrySchema>;
export type NewLedgerEntry = z.infer<typeof insertLedgerEntrySchema>;
export type SharedLink = z.infer<typeof selectSharedLinkSchema>;
export type NewSharedLink = z.infer<typeof insertSharedLinkSchema>;
export type ConversationMember = z.infer<typeof selectConversationMemberSchema>;
export type NewConversationMember = z.infer<typeof insertConversationMemberSchema>;
export type Epoch = z.infer<typeof selectEpochSchema>;
export type NewEpoch = z.infer<typeof insertEpochSchema>;
export type EpochMember = z.infer<typeof selectEpochMemberSchema>;
export type NewEpochMember = z.infer<typeof insertEpochMemberSchema>;
export type SharedMessage = z.infer<typeof selectSharedMessageSchema>;
export type NewSharedMessage = z.infer<typeof insertSharedMessageSchema>;
export type MemberBudget = z.infer<typeof selectMemberBudgetSchema>;
export type NewMemberBudget = z.infer<typeof insertMemberBudgetSchema>;
export type ConversationSpending = z.infer<typeof selectConversationSpendingSchema>;
export type NewConversationSpending = z.infer<typeof insertConversationSpendingSchema>;
