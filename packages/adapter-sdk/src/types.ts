import type { BridgeRequest, BridgeRequestId, BridgeRequestMeta, JsonValue } from "@uab/protocol";

export type CapabilityMode = boolean | "read" | "write" | "admin";

export interface CapabilityDescriptor {
  read?: boolean;
  write?: boolean;
  admin?: boolean;
  methods?: string[];
  description?: string;
}

export type RuntimeCapabilities = Record<string, CapabilityMode | CapabilityDescriptor>;

export interface RuntimeMethodDefinition {
  name: string;
  title?: string;
  description?: string;
  capability?: string;
  risk?: "read" | "write" | "admin";
  paramsExample?: JsonValue;
}

export interface RuntimeInfo {
  id: string;
  name: string;
  version?: string;
  description?: string;
}

export interface Principal {
  id: string;
  scopes: string[];
  runtimeAllowlist?: string[];
}

export interface BridgeLogger {
  debug(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export interface AdapterCallRequest {
  method: string;
  params?: JsonValue;
  meta?: BridgeRequestMeta;
  raw: BridgeRequest;
}

export interface AdapterCallContext {
  requestId: BridgeRequestId;
  traceId: string;
  principal?: Principal;
  signal?: AbortSignal;
  logger?: BridgeLogger;
}

export type AdapterStreamEvent =
  | {
      type: "start";
      name?: string;
      data?: JsonValue;
    }
  | {
      type: "state";
      data: JsonValue;
    }
  | {
      type: "step";
      name: string;
      status: "started" | "finished";
      data?: JsonValue;
    }
  | {
      type: "text";
      delta: string;
      messageId?: string;
    }
  | {
      type: "tool_call";
      name: string;
      data?: JsonValue;
    }
  | {
      type: "artifact";
      data: JsonValue;
    }
  | {
      type: "a2ui";
      data: JsonValue;
    }
  | {
      type: "custom";
      name: string;
      data?: JsonValue;
    }
  | {
      type: "result";
      data: JsonValue;
    }
  | {
      type: "error";
      message: string;
      code?: string | number;
      data?: JsonValue;
    };

export interface AdapterHealth {
  status: "ok" | "degraded" | "down";
  details?: JsonValue;
}

export interface AgentRuntimeAdapter {
  info: RuntimeInfo;
  capabilities(): RuntimeCapabilities | Promise<RuntimeCapabilities>;
  methods?(): RuntimeMethodDefinition[] | Promise<RuntimeMethodDefinition[]>;
  call(request: AdapterCallRequest, context: AdapterCallContext): unknown | Promise<unknown>;
  stream?(
    request: AdapterCallRequest,
    context: AdapterCallContext
  ): AsyncIterable<AdapterStreamEvent>;
  health?(): AdapterHealth | Promise<AdapterHealth>;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}
