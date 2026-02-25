import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const gmailAccounts = pgTable("gmail_accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  label: text("label").notNull(),
  email: text("email").notNull().unique(),
  source: text("source").notNull().default("manual"),
});

export const entities = pgTable("entities", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
});

export const emailMappings = pgTable("email_mappings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  entityId: varchar("entity_id").notNull().references(() => entities.id, { onDelete: "cascade" }),
  pattern: text("pattern").notNull(),
});

export const insertGmailAccountSchema = createInsertSchema(gmailAccounts).omit({ id: true });
export const insertEntitySchema = createInsertSchema(entities).omit({ id: true });
export const insertEmailMappingSchema = createInsertSchema(emailMappings).omit({ id: true });

export type GmailAccount = typeof gmailAccounts.$inferSelect;
export type InsertGmailAccount = z.infer<typeof insertGmailAccountSchema>;
export type Entity = typeof entities.$inferSelect;
export type InsertEntity = z.infer<typeof insertEntitySchema>;
export type EmailMapping = typeof emailMappings.$inferSelect;
export type InsertEmailMapping = z.infer<typeof insertEmailMappingSchema>;
