import { randomUUID } from "crypto";
import {
  type GmailAccount, type InsertGmailAccount,
  type Entity, type InsertEntity,
  type EmailMapping, type InsertEmailMapping,
} from "@shared/schema";

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

// All entity/mapping data is held only in process memory.
// It is cleared on every server restart — nothing is written to disk or a database.
export class InMemoryStorage implements IStorage {
  private accounts: Map<string, GmailAccount> = new Map();
  private entities: Map<string, Entity> = new Map();
  private mappings: Map<string, EmailMapping> = new Map();

  async getAccounts(): Promise<GmailAccount[]> {
    return Array.from(this.accounts.values());
  }

  async createAccount(account: InsertGmailAccount): Promise<GmailAccount> {
    const record: GmailAccount = { id: randomUUID(), source: "manual", ...account };
    this.accounts.set(record.id, record);
    return record;
  }

  async deleteAccount(id: string): Promise<void> {
    this.accounts.delete(id);
  }

  async getEntities(): Promise<Entity[]> {
    return Array.from(this.entities.values());
  }

  async createEntity(entity: InsertEntity): Promise<Entity> {
    const record: Entity = { id: randomUUID(), ...entity };
    this.entities.set(record.id, record);
    return record;
  }

  async deleteEntity(id: string): Promise<void> {
    this.entities.delete(id);
    for (const [mid, m] of Array.from(this.mappings.entries())) {
      if (m.entityId === id) this.mappings.delete(mid);
    }
  }

  async getMappings(entityId?: string): Promise<EmailMapping[]> {
    const all = Array.from(this.mappings.values());
    return entityId ? all.filter(m => m.entityId === entityId) : all;
  }

  async createMapping(mapping: InsertEmailMapping): Promise<EmailMapping> {
    const record: EmailMapping = { id: randomUUID(), ...mapping };
    this.mappings.set(record.id, record);
    return record;
  }

  async deleteMapping(id: string): Promise<void> {
    this.mappings.delete(id);
  }

  async deleteMappingsByEntity(entityId: string): Promise<void> {
    for (const [id, m] of Array.from(this.mappings.entries())) {
      if (m.entityId === entityId) this.mappings.delete(id);
    }
  }

  async bulkImportEntities(data: { name: string; patterns: string[] }[]): Promise<void> {
    for (const item of data) {
      const entity = await this.createEntity({ name: item.name });
      for (const pattern of item.patterns) {
        await this.createMapping({ entityId: entity.id, pattern });
      }
    }
  }
}

export const storage = new InMemoryStorage();
