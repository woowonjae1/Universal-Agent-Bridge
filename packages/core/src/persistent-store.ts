import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isJsonObject, type JsonObject } from "@uab/protocol";
import type { AuditLogEntry } from "./audit-log.js";
import type { BridgeResource } from "./resources.js";

export interface StoredBridgeSession {
  id: string;
  runtime: string;
  createdAt: string;
  updatedAt: string;
  metadata?: JsonObject;
}

export interface BridgePersistentSnapshot {
  version: 1;
  sessions: StoredBridgeSession[];
  audit: AuditLogEntry[];
  resources: BridgeResource[];
  updatedAt: string;
}

export class JsonBridgeStore {
  constructor(private readonly filePath: string) {}

  load(): BridgePersistentSnapshot | undefined {
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<BridgePersistentSnapshot>;
      if (parsed.version !== 1) return undefined;
      return {
        version: 1,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions.filter(isStoredSession).map(normalizeSession) : [],
        audit: Array.isArray(parsed.audit) ? parsed.audit.filter(isAuditEntry) : [],
        resources: Array.isArray(parsed.resources) ? parsed.resources.filter(isBridgeResource) : [],
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date(0).toISOString()
      };
    } catch {
      return undefined;
    }
  }

  save(snapshot: BridgePersistentSnapshot): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify({
      ...snapshot,
      updatedAt: new Date().toISOString()
    }, null, 2) + "\n", "utf8");
  }
}

function normalizeSession(session: StoredBridgeSession): StoredBridgeSession {
  return {
    ...session,
    metadata: isJsonObject(session.metadata) ? session.metadata as JsonObject : undefined
  };
}

function isStoredSession(value: unknown): value is StoredBridgeSession {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.runtime === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string";
}

function isAuditEntry(value: unknown): value is AuditLogEntry {
  return isRecord(value)
    && typeof value.id === "string"
    && typeof value.traceId === "string"
    && typeof value.runtime === "string"
    && typeof value.method === "string"
    && (value.status === "success" || value.status === "error")
    && typeof value.durationMs === "number"
    && typeof value.timestamp === "string";
}

function isBridgeResource(value: unknown): value is BridgeResource {
  return isRecord(value)
    && typeof value.id === "string"
    && (value.kind === "memory" || value.kind === "artifact")
    && typeof value.runtime === "string"
    && typeof value.sourceMethod === "string"
    && typeof value.traceId === "string"
    && typeof value.createdAt === "string"
    && typeof value.updatedAt === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
