import type { JsonValue } from "@uab/protocol";
import type { AuditLogEntry } from "./audit-log.js";
import type { BridgeResource } from "./resources.js";

export interface RuntimeMetric {
  runtime: string;
  calls: number;
  errors: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export interface BridgeMetricsSnapshot {
  startedAt: string;
  uptimeMs: number;
  calls: number;
  errors: number;
  activeCalls: number;
  totalDurationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
  runtimeConcurrency: Record<string, { active: number; queued: number; max: number | null }>;
  runtimes: RuntimeMetric[];
}

export interface BridgeTraceSnapshot {
  traceId: string;
  audit: AuditLogEntry[];
  resources: BridgeResource[];
}

export interface BridgeSpan {
  name: string;
  traceId: string;
  spanId: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  status: "ok" | "error";
  attributes: Record<string, string | number | boolean>;
}

export interface BridgeSpanExporter {
  export(span: BridgeSpan): void | Promise<void>;
}

export class BridgeObservability {
  private readonly startedAtMs = Date.now();
  private readonly startedAt = new Date(this.startedAtMs).toISOString();
  private calls = 0;
  private errors = 0;
  private activeCalls = 0;
  private totalDurationMs = 0;
  private maxDurationMs = 0;
  private readonly runtimes = new Map<string, RuntimeMetric>();

  constructor(private readonly spanExporter?: BridgeSpanExporter) {}

  callStarted(): void {
    this.activeCalls += 1;
  }

  callSettled(): void {
    if (this.activeCalls > 0) this.activeCalls -= 1;
  }

  callFinished(entry: AuditLogEntry): void {
    this.calls += 1;
    if (entry.status === "error") this.errors += 1;
    this.totalDurationMs += entry.durationMs;
    this.maxDurationMs = Math.max(this.maxDurationMs, entry.durationMs);

    const metric = this.runtimes.get(entry.runtime) ?? {
      runtime: entry.runtime,
      calls: 0,
      errors: 0,
      totalDurationMs: 0,
      maxDurationMs: 0
    };
    metric.calls += 1;
    if (entry.status === "error") metric.errors += 1;
    metric.totalDurationMs += entry.durationMs;
    metric.maxDurationMs = Math.max(metric.maxDurationMs, entry.durationMs);
    this.runtimes.set(entry.runtime, metric);
    this.exportSpan(entry);
  }

  snapshot(runtimeConcurrency: Record<string, { active: number; queued: number; max: number | null }>): BridgeMetricsSnapshot {
    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAtMs,
      calls: this.calls,
      errors: this.errors,
      activeCalls: this.activeCalls,
      totalDurationMs: this.totalDurationMs,
      avgDurationMs: this.calls > 0 ? this.totalDurationMs / this.calls : 0,
      maxDurationMs: this.maxDurationMs,
      runtimeConcurrency,
      runtimes: [...this.runtimes.values()].sort((a, b) => a.runtime.localeCompare(b.runtime))
    };
  }

  toJson(runtimeConcurrency: Record<string, { active: number; queued: number; max: number | null }>): JsonValue {
    return JSON.parse(JSON.stringify(this.snapshot(runtimeConcurrency))) as JsonValue;
  }

  private exportSpan(entry: AuditLogEntry): void {
    if (!this.spanExporter) return;
    const endMs = Date.parse(entry.timestamp);
    const startMs = Number.isFinite(endMs) ? endMs - entry.durationMs : Date.now() - entry.durationMs;
    const span: BridgeSpan = {
      name: `uab.${entry.method}`,
      traceId: entry.traceId,
      spanId: entry.id,
      startTime: new Date(startMs).toISOString(),
      endTime: entry.timestamp,
      durationMs: entry.durationMs,
      status: entry.status === "success" ? "ok" : "error",
      attributes: {
        "uab.runtime": entry.runtime,
        "uab.method": entry.method,
        "uab.request_id": entry.requestId === null ? "" : String(entry.requestId),
        "uab.status": entry.status,
        ...(entry.code !== undefined ? { "uab.error_code": entry.code } : {}),
        ...(entry.principalId ? { "uab.principal_id": entry.principalId } : {}),
        ...(entry.source ? { "uab.source": entry.source } : {})
      }
    };
    void Promise.resolve(this.spanExporter.export(span)).catch(() => undefined);
  }
}
