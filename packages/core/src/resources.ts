import type { BridgeRequestId, JsonObject, JsonValue } from "@uab/protocol";
import { isJsonObject } from "@uab/protocol";

export type BridgeResourceKind = "memory" | "artifact";

export interface BridgeResource {
  id: string;
  kind: BridgeResourceKind;
  runtime: string;
  sourceMethod: string;
  requestId: BridgeRequestId;
  traceId: string;
  sessionId?: string;
  uri?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  metadata?: JsonObject;
  data?: JsonValue;
  createdAt: string;
  updatedAt: string;
}

export interface BridgeResourceSnapshot {
  resources: BridgeResource[];
  limit: number;
  total: number;
}

export interface BridgeResourceFilter {
  kind?: BridgeResourceKind;
  runtime?: string;
  sessionId?: string;
  limit?: number;
}

export class BridgeResourceIndex {
  private readonly resources = new Map<string, BridgeResource>();

  constructor(initialResources: BridgeResource[] = [], private readonly limit = 500) {
    for (const resource of initialResources) {
      this.resources.set(resource.id, resource);
    }
    this.enforceLimit();
  }

  upsert(resource: BridgeResource): void {
    const existing = this.resources.get(resource.id);
    this.resources.set(resource.id, {
      ...existing,
      ...resource,
      createdAt: existing?.createdAt ?? resource.createdAt,
      updatedAt: resource.updatedAt
    });
    this.enforceLimit();
  }

  list(filter: BridgeResourceFilter = {}): BridgeResourceSnapshot {
    const limit = normalizeLimit(filter.limit, this.limit);
    const entries = [...this.resources.values()]
      .filter((resource) => !filter.kind || resource.kind === filter.kind)
      .filter((resource) => !filter.runtime || resource.runtime === filter.runtime)
      .filter((resource) => !filter.sessionId || resource.sessionId === filter.sessionId)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return {
      resources: entries.slice(0, limit),
      limit,
      total: entries.length
    };
  }

  toJson(filter: BridgeResourceFilter = {}): JsonValue {
    return JSON.parse(JSON.stringify(this.list(filter))) as JsonValue;
  }

  snapshot(): BridgeResource[] {
    return [...this.resources.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private enforceLimit(): void {
    if (this.resources.size <= this.limit) return;
    const sorted = this.snapshot();
    for (const resource of sorted.slice(this.limit)) {
      this.resources.delete(resource.id);
    }
  }
}

export interface ResourceExtractionContext {
  runtime: string;
  method: string;
  requestId: BridgeRequestId;
  traceId: string;
  sessionId?: string;
  timestamp: string;
}

export function extractBridgeResources(
  value: JsonValue,
  context: ResourceExtractionContext
): BridgeResource[] {
  const resources: BridgeResource[] = [];
  collectResources(value, context, resources);
  return resources;
}

function collectResources(
  value: JsonValue,
  context: ResourceExtractionContext,
  output: BridgeResource[]
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectResources(entry as JsonValue, context, output);
    return;
  }

  if (!isJsonObject(value)) return;

  const direct = normalizeResource(value, context);
  if (direct) output.push(direct);

  for (const key of ["memory", "memories", "files", "artifacts", "items", "resources", "data"]) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      for (const entry of nested) collectResources(toJsonValue(entry), context, output);
    } else if (isJsonObject(nested)) {
      collectResources(toJsonValue(nested), context, output);
    }
  }
}

function normalizeResource(
  value: JsonObject,
  context: ResourceExtractionContext
): BridgeResource | undefined {
  const kind = readKind(value, context.method);
  if (!kind) return undefined;

  const uri = readString(value.uri)
    ?? readString(value.url)
    ?? readString(value.path)
    ?? readString(value.file)
    ?? readString(value.artifactUrl);
  const name = readString(value.name)
    ?? readString(value.title)
    ?? readString(value.path)
    ?? readString(value.id)
    ?? readString(value.artifact_id)
    ?? readString(value.artifactId);
  const sourceId = readString(value.id)
    ?? readString(value.artifact_id)
    ?? readString(value.artifactId)
    ?? readString(value.memory_id)
    ?? readString(value.memoryId)
    ?? uri
    ?? name;

  if (!sourceId && !uri && !name) return undefined;

  const id = stableResourceId(
    kind,
    context.runtime,
    context.sessionId,
    sourceId ?? `${context.traceId}:${outputSafeName(name)}`
  );

  return {
    id,
    kind,
    runtime: context.runtime,
    sourceMethod: context.method,
    requestId: context.requestId,
    traceId: context.traceId,
    sessionId: context.sessionId,
    uri,
    name,
    mimeType: readString(value.mimeType) ?? readString(value.mime_type) ?? readString(value.contentType),
    sizeBytes: readNumber(value.sizeBytes) ?? readNumber(value.size_bytes) ?? readNumber(value.size),
    metadata: readMetadata(value),
    data: shouldStoreData(value) ? toJsonValue(value) : undefined,
    createdAt: readString(value.createdAt) ?? readString(value.created_at) ?? context.timestamp,
    updatedAt: readString(value.updatedAt) ?? readString(value.updated_at) ?? context.timestamp
  };
}

function readKind(value: JsonObject, method: string): BridgeResourceKind | undefined {
  const explicit = readString(value.kind) ?? readString(value.type);
  if (explicit) {
    const normalized = explicit.toLowerCase();
    if (normalized.includes("artifact")) return "artifact";
    if (normalized.includes("memory") || normalized.includes("file")) return "memory";
  }

  if (hasAnyKey(value, ["artifact_id", "artifactId", "artifactUrl"])) return "artifact";
  if (hasAnyKey(value, ["memory_id", "memoryId", "path", "file"])) return "memory";
  if (method.startsWith("artifacts.")) return "artifact";
  if (method.startsWith("memory.")) return "memory";
  return undefined;
}

function readMetadata(value: JsonObject): JsonObject | undefined {
  if (isJsonObject(value.metadata)) return value.metadata as JsonObject;
  const metadata: JsonObject = {};
  for (const key of ["description", "status", "run_id", "runId", "session_id", "sessionId"]) {
    const entry = value[key];
    if (entry !== undefined && entry !== null) metadata[key] = toJsonValue(entry);
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function shouldStoreData(value: JsonObject): boolean {
  return !("content" in value) && !("bytes" in value);
}

function hasAnyKey(value: JsonObject, keys: string[]): boolean {
  return keys.some((key) => value[key] !== undefined);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), fallback)
    : Math.min(50, fallback);
}

function stableResourceId(
  kind: BridgeResourceKind,
  runtime: string,
  sessionId: string | undefined,
  sourceId: string
): string {
  return [
    kind,
    runtime,
    sessionId ?? "global",
    sourceId
  ].map((part) => encodeURIComponent(part)).join(":");
}

function outputSafeName(value: string | undefined): string {
  return value && value.trim() !== "" ? value.trim() : "resource";
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
