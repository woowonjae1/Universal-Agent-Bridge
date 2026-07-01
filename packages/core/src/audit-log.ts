import type { BridgeRequestId, JsonValue } from "@uab/protocol";

export type AuditStatus = "success" | "error";

export interface AuditLogEntry {
  id: string;
  requestId: BridgeRequestId;
  traceId: string;
  runtime: string;
  method: string;
  status: AuditStatus;
  code?: number;
  message?: string;
  durationMs: number;
  principalId?: string;
  source?: string;
  timestamp: string;
}

export interface AuditLogSnapshot {
  entries: AuditLogEntry[];
  limit: number;
}

export class AuditLog {
  private readonly entries: AuditLogEntry[] = [];

  constructor(private readonly limit = 200) {}

  record(entry: AuditLogEntry): void {
    this.entries.unshift(entry);
    if (this.entries.length > this.limit) {
      this.entries.length = this.limit;
    }
  }

  list(limit = 50): AuditLogSnapshot {
    const normalizedLimit = Math.max(1, Math.min(limit, this.limit));
    return {
      entries: this.entries.slice(0, normalizedLimit),
      limit: normalizedLimit
    };
  }

  toJson(limit = 50): JsonValue {
    return JSON.parse(JSON.stringify(this.list(limit))) as JsonValue;
  }
}

