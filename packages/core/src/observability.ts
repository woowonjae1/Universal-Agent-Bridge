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

export class BridgeObservability {
  private readonly startedAtMs = Date.now();
  private readonly startedAt = new Date(this.startedAtMs).toISOString();
  private calls = 0;
  private errors = 0;
  private activeCalls = 0;
  private totalDurationMs = 0;
  private maxDurationMs = 0;
  private readonly runtimes = new Map<string, RuntimeMetric>();

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
}
