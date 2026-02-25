import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import {
  gmailAccounts, entities, emailMappings,
  type GmailAccount, type InsertGmailAccount,
  type Entity, type InsertEntity,
  type EmailMapping, type InsertEmailMapping,
} from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required");
}

export const db = drizzle(process.env.DATABASE_URL);

export interface IStorage {
  getAccounts(): Promise<GmailAccount[]>;
  createAccount(account: InsertGmailAccount): Promise<GmailAccount>;
  deleteAccount(id: string): Promise<void>;

  getEntities(): Promise<Entity[]>;
  createEntity(entity: InsertEntity): Promise<Entity>;
  deleteEntity(id: string): Promise<void>;

  getMappings(entityId?: string): Promise<EmailMapping[]>;
  createMapping(mapping: InsertEmailMapping): Promise<EmailMapping>;
  deleteMapping(id: string): Promise<void>;
  deleteMappingsByEntity(entityId: string): Promise<void>;

  bulkImportEntities(data: { name: string; patterns: string[] }[]): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getAccounts(): Promise<GmailAccount[]> {
    return db.select().from(gmailAccounts);
  }

  async createAccount(account: InsertGmailAccount): Promise<GmailAccount> {
    const [result] = await db.insert(gmailAccounts).values(account).returning();
    return result;
  }

  async deleteAccount(id: string): Promise<void> {
    await db.delete(gmailAccounts).where(eq(gmailAccounts.id, id));
  }

  async getEntities(): Promise<Entity[]> {
    return db.select().from(entities);
  }

  async createEntity(entity: InsertEntity): Promise<Entity> {
    const [result] = await db.insert(entities).values(entity).returning();
    return result;
  }

  async deleteEntity(id: string): Promise<void> {
    await db.delete(entities).where(eq(entities.id, id));
  }

  async getMappings(entityId?: string): Promise<EmailMapping[]> {
    if (entityId) {
      return db.select().from(emailMappings).where(eq(emailMappings.entityId, entityId));
    }
    return db.select().from(emailMappings);
  }

  async createMapping(mapping: InsertEmailMapping): Promise<EmailMapping> {
    const [result] = await db.insert(emailMappings).values(mapping).returning();
    return result;
  }

  async deleteMapping(id: string): Promise<void> {
    await db.delete(emailMappings).where(eq(emailMappings.id, id));
  }

  async deleteMappingsByEntity(entityId: string): Promise<void> {
    await db.delete(emailMappings).where(eq(emailMappings.entityId, entityId));
  }

  async bulkImportEntities(data: { name: string; patterns: string[] }[]): Promise<void> {
    for (const item of data) {
      const [entity] = await db.insert(entities).values({ name: item.name }).returning();
      if (item.patterns.length > 0) {
        await db.insert(emailMappings).values(
          item.patterns.map(p => ({ entityId: entity.id, pattern: p }))
        );
      }
    }
  }
}

export const storage = new DatabaseStorage();
