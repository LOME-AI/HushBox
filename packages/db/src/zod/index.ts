import { createInsertSchema, createSelectSchema } from 'drizzle-zod';
import type { z } from 'zod';

import { conversations, messages, projects, users } from '../schema/index';

// Select schemas (reading from DB)
export const selectUserSchema = createSelectSchema(users);
export const selectConversationSchema = createSelectSchema(conversations);
export const selectMessageSchema = createSelectSchema(messages);
export const selectProjectSchema = createSelectSchema(projects);

// Insert schemas (writing to DB)
export const insertUserSchema = createInsertSchema(users);
export const insertConversationSchema = createInsertSchema(conversations);
export const insertMessageSchema = createInsertSchema(messages);
export const insertProjectSchema = createInsertSchema(projects);

// Type exports (using orthodox z.infer pattern)
export type User = z.infer<typeof selectUserSchema>;
export type NewUser = z.infer<typeof insertUserSchema>;
export type Conversation = z.infer<typeof selectConversationSchema>;
export type NewConversation = z.infer<typeof insertConversationSchema>;
export type Message = z.infer<typeof selectMessageSchema>;
export type NewMessage = z.infer<typeof insertMessageSchema>;
export type Project = z.infer<typeof selectProjectSchema>;
export type NewProject = z.infer<typeof insertProjectSchema>;
