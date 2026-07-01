import type {
  AdapterCallRequest,
  AdapterStreamEvent,
  AgentRuntimeAdapter,
  BridgeLogger,
  Principal,
  RuntimeMethodDefinition
} from "@uab/adapter-sdk";
import {
  BRIDGE_ERROR_CODES,
  createErrorResponse,
  createSuccessResponse,
  extractRequestId,
  isBridgeRequest
} from "@uab/protocol";
import type { BridgeRequest, BridgeResponse, JsonValue } from "@uab/protocol";
import { AdapterRegistry } from "./adapter-registry.js";
import { AuditLog } from "./audit-log.js";
import { AllowAllAccessPolicy, type AccessPolicy } from "./scope-policy.js";

export interface AgentBridgeOptions {
  adapters?: AgentRuntimeAdapter[];
  accessPolicy?: AccessPolicy;
  logger?: BridgeLogger;
  auditLimit?: number;
}

export class AgentBridge {
  readonly registry = new AdapterRegistry();
  readonly audit: AuditLog;
  private readonly accessPolicy: AccessPolicy;
  private readonly logger?: BridgeLogger;

  constructor(options: AgentBridgeOptions = {}) {
    this.accessPolicy = options.accessPolicy ?? new AllowAllAccessPolicy();
    this.logger = options.logger;
    this.audit = new AuditLog(options.auditLimit);

    for (const adapter of options.adapters ?? []) {
      this.register(adapter);
    }
  }

  register(adapter: AgentRuntimeAdapter): void {
    this.registry.register(adapter);
  }

  async handleRequest(
    input: unknown,
    principal?: Principal
  ): Promise<BridgeResponse> {
    if (!isBridgeRequest(input)) {
      return createErrorResponse({
        id: extractRequestId(input),
        code: BRIDGE_ERROR_CODES.invalidRequest,
        message: "Invalid bridge request."
      });
    }

    return this.call(input, principal);
  }

  async call(request: BridgeRequest, principal?: Principal): Promise<BridgeResponse> {
    const startedAt = Date.now();
    const traceId = request.meta?.traceId ?? `trace_${Date.now().toString(36)}`;
    const adapter = this.registry.get(request.runtime);
    if (!adapter) {
      const response = createErrorResponse({
        id: request.id,
        code: BRIDGE_ERROR_CODES.runtimeNotFound,
        message: `Runtime '${request.runtime}' is not registered.`
      });
      this.recordAudit(request, traceId, startedAt, response, principal);
      return response;
    }

    const access = await this.accessPolicy.authorize({
      request,
      adapter,
      principal
    });

    if (!access.allow) {
      const response = createErrorResponse({
        id: request.id,
        code: BRIDGE_ERROR_CODES.permissionDenied,
        message: access.reason ?? "Permission denied."
      });
      this.recordAudit(request, traceId, startedAt, response, principal);
      return response;
    }

    try {
      const result = await adapter.call(
        {
          method: request.method,
          params: request.params,
          meta: request.meta,
          raw: request
        },
        {
          requestId: request.id ?? null,
          traceId,
          principal,
          logger: this.logger
        }
      );

      const response = createSuccessResponse(request, toJsonValue(result));
      this.recordAudit(request, traceId, startedAt, response, principal);
      return response;
    } catch (error) {
      const maybeError = error as {
        code?: number;
        message?: string;
        data?: JsonValue;
      };

      this.logger?.error("Adapter call failed.", {
        runtime: request.runtime,
        method: request.method,
        error
      });

      const response = createErrorResponse({
        id: request.id,
        code: maybeError.code ?? BRIDGE_ERROR_CODES.internalError,
        message: maybeError.message ?? "Adapter call failed.",
        data: maybeError.data
      });
      this.recordAudit(request, traceId, startedAt, response, principal);
      return response;
    }
  }

  async *streamCall(
    request: BridgeRequest,
    principal?: Principal
  ): AsyncIterable<AdapterStreamEvent> {
    const startedAt = Date.now();
    const traceId = request.meta?.traceId ?? `trace_${Date.now().toString(36)}`;
    const adapter = this.registry.get(request.runtime);
    if (!adapter) {
      const errorEvent: AdapterStreamEvent = {
        type: "error",
        message: `Runtime '${request.runtime}' is not registered.`,
        code: BRIDGE_ERROR_CODES.runtimeNotFound
      };
      const response = createErrorResponse({
        id: request.id,
        code: Number(errorEvent.code),
        message: errorEvent.message
      });
      this.recordAudit(request, traceId, startedAt, response, principal);
      yield errorEvent;
      return;
    }

    const access = await this.accessPolicy.authorize({
      request,
      adapter,
      principal
    });

    if (!access.allow) {
      const errorEvent: AdapterStreamEvent = {
        type: "error",
        message: access.reason ?? "Permission denied.",
        code: BRIDGE_ERROR_CODES.permissionDenied
      };
      const response = createErrorResponse({
        id: request.id,
        code: Number(errorEvent.code),
        message: errorEvent.message
      });
      this.recordAudit(request, traceId, startedAt, response, principal);
      yield errorEvent;
      return;
    }

    const callRequest: AdapterCallRequest = {
      method: request.method,
      params: request.params,
      meta: request.meta,
      raw: request
    };
    const context = {
      requestId: request.id ?? null,
      traceId,
      principal,
      logger: this.logger
    };

    try {
      if (adapter.stream) {
        let finalResult: JsonValue | undefined;
        for await (const event of adapter.stream(callRequest, context)) {
          if (event.type === "result") {
            finalResult = event.data;
          }
          yield event;
        }

        const response = createSuccessResponse(request, finalResult ?? null);
        this.recordAudit(request, traceId, startedAt, response, principal);
        return;
      }

      const result = await adapter.call(callRequest, context);
      const resultJson = toJsonValue(result);
      const response = createSuccessResponse(request, resultJson);
      this.recordAudit(request, traceId, startedAt, response, principal);
      yield {
        type: "result",
        data: resultJson
      };
    } catch (error) {
      const maybeError = error as {
        code?: number;
        message?: string;
        data?: JsonValue;
      };

      this.logger?.error("Adapter stream failed.", {
        runtime: request.runtime,
        method: request.method,
        error
      });

      const response = createErrorResponse({
        id: request.id,
        code: maybeError.code ?? BRIDGE_ERROR_CODES.internalError,
        message: maybeError.message ?? "Adapter stream failed.",
        data: maybeError.data
      });
      this.recordAudit(request, traceId, startedAt, response, principal);
      yield {
        type: "error",
        message: maybeError.message ?? "Adapter stream failed.",
        code: maybeError.code ?? BRIDGE_ERROR_CODES.internalError,
        data: maybeError.data
      };
    }
  }

  async listRuntimes(): Promise<JsonValue> {
    const runtimes = await Promise.all(
      this.registry.list().map(async (adapter) => ({
        ...adapter.info,
        capabilities: await adapter.capabilities(),
        methodCount: (await this.getAdapterMethods(adapter)).length
      }))
    );

    return toJsonValue({
      runtimes
    });
  }

  async listMethods(runtimeId?: string): Promise<JsonValue> {
    const adapters = runtimeId
      ? this.registry.get(runtimeId)
        ? [this.registry.get(runtimeId)!]
        : []
      : this.registry.list();

    const runtimes = await Promise.all(
      adapters.map(async (adapter) => ({
        runtime: adapter.info.id,
        methods: await this.getAdapterMethods(adapter)
      }))
    );

    return toJsonValue({
      runtimes
    });
  }

  listAudit(limit = 50): JsonValue {
    return this.audit.toJson(limit);
  }

  private recordAudit(
    request: BridgeRequest,
    traceId: string,
    startedAt: number,
    response: BridgeResponse,
    principal?: Principal
  ): void {
    const error = "error" in response ? response.error : undefined;
    this.audit.record({
      id: `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      requestId: request.id ?? null,
      traceId,
      runtime: request.runtime,
      method: request.method,
      status: error ? "error" : "success",
      code: error?.code,
      message: error?.message,
      durationMs: Date.now() - startedAt,
      principalId: principal?.id,
      source: typeof request.meta?.source === "string" ? request.meta.source : undefined,
      timestamp: new Date().toISOString()
    });
  }

  private async getAdapterMethods(
    adapter: AgentRuntimeAdapter
  ): Promise<RuntimeMethodDefinition[]> {
    if (adapter.methods) {
      return adapter.methods();
    }

    const capabilities = await adapter.capabilities();
    return Object.entries(capabilities).flatMap(([capability, descriptor]) => {
      if (
        typeof descriptor === "object" &&
        descriptor.methods &&
        descriptor.methods.length > 0
      ) {
        return descriptor.methods.map((name) => ({
          name,
          capability,
          risk: descriptor.admin ? "admin" : descriptor.write ? "write" : "read"
        }));
      }

      return [];
    });
  }
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
