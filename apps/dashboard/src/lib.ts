// Shared API helpers and control-plane types used across dashboard views.

export interface BridgeResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export type PlanRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled";

export type PlanStepStatus =
  | "pending"
  | "running"
  | "success"
  | "error"
  | "skipped"
  | "cancelled";

export interface PlanRunStep {
  stepId: string;
  index: number;
  status: PlanStepStatus;
  method: string;
  dependsOn: string[];
  traceId: string;
  requestId: string;
  runtime?: string;
  startedAt?: string;
  completedAt?: string;
  input?: unknown;
  response?: BridgeResponse;
}

export interface PlanRun {
  id: string;
  planId: string;
  traceId: string;
  status: PlanRunStatus;
  plan: unknown;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: unknown;
  steps: PlanRunStep[];
  final: BridgeResponse | null;
}

export interface PlanRunListResponse {
  runs: PlanRun[];
  limit: number;
  total: number;
}

export type CircuitState = "closed" | "open" | "half_open";

export interface HealthRuntime {
  runtime: string;
  circuit: { state: CircuitState; failures: number };
  reported: unknown;
}

export interface HealthResponse {
  runtimes: HealthRuntime[];
}

export interface RuntimeMetric {
  runtime: string;
  calls: number;
  errors: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export interface MetricsResponse {
  startedAt: string;
  uptimeMs: number;
  calls: number;
  errors: number;
  activeCalls: number;
  totalDurationMs: number;
  avgDurationMs: number;
  maxDurationMs: number;
  runtimeConcurrency: Record<
    string,
    { active: number; queued: number; max: number | null }
  >;
  runtimes: RuntimeMetric[];
}

export interface BridgeResource {
  id: string;
  kind: "memory" | "artifact";
  runtime: string;
  sourceMethod: string;
  requestId: string | number | null;
  traceId: string;
  sessionId?: string;
  uri?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  metadata?: Record<string, unknown>;
  data?: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface ResourceListResponse {
  resources: BridgeResource[];
  limit: number;
  total: number;
}

export interface BroadcastResponse {
  capability: string;
  results: Array<{ runtime: string; response: BridgeResponse }>;
}

export interface TraceAuditEntry {
  id: string;
  requestId: string | number | null;
  traceId: string;
  runtime: string;
  method: string;
  status: "success" | "error";
  code?: number;
  message?: string;
  durationMs: number;
  timestamp: string;
}

export interface TraceResponse {
  traceId: string;
  audit: TraceAuditEntry[];
  resources: BridgeResource[];
}

export interface RuntimeSummary {
  id: string;
  name: string;
  version?: string;
  capabilities: Record<string, unknown>;
}

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const text = await response.text();
  const data = text ? (JSON.parse(text) as T) : ({} as T);
  if (!response.ok) {
    const message =
      typeof data === "object" &&
      data &&
      "error" in data &&
      typeof (data as { error?: { message?: unknown } }).error?.message === "string"
        ? (data as { error: { message: string } }).error.message
        : `HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatTime(value: string | number | undefined): string {
  if (value === undefined) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleTimeString();
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
