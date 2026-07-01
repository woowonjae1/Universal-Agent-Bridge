import type {
  AgentRuntimeAdapter,
  BridgeLogger,
  Principal
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
import { AllowAllAccessPolicy, type AccessPolicy } from "./scope-policy.js";

export interface AgentBridgeOptions {
  adapters?: AgentRuntimeAdapter[];
  accessPolicy?: AccessPolicy;
  logger?: BridgeLogger;
}

export class AgentBridge {
  readonly registry = new AdapterRegistry();
  private readonly accessPolicy: AccessPolicy;
  private readonly logger?: BridgeLogger;

  constructor(options: AgentBridgeOptions = {}) {
    this.accessPolicy = options.accessPolicy ?? new AllowAllAccessPolicy();
    this.logger = options.logger;

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
    const adapter = this.registry.get(request.runtime);
    if (!adapter) {
      return createErrorResponse({
        id: request.id,
        code: BRIDGE_ERROR_CODES.runtimeNotFound,
        message: `Runtime '${request.runtime}' is not registered.`
      });
    }

    const access = await this.accessPolicy.authorize({
      request,
      adapter,
      principal
    });

    if (!access.allow) {
      return createErrorResponse({
        id: request.id,
        code: BRIDGE_ERROR_CODES.permissionDenied,
        message: access.reason ?? "Permission denied."
      });
    }

    const traceId = request.meta?.traceId ?? `trace_${Date.now().toString(36)}`;

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

      return createSuccessResponse(request, toJsonValue(result));
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

      return createErrorResponse({
        id: request.id,
        code: maybeError.code ?? BRIDGE_ERROR_CODES.internalError,
        message: maybeError.message ?? "Adapter call failed.",
        data: maybeError.data
      });
    }
  }

  async listRuntimes(): Promise<JsonValue> {
    const runtimes = await Promise.all(
      this.registry.list().map(async (adapter) => ({
        ...adapter.info,
        capabilities: await adapter.capabilities()
      }))
    );

    return toJsonValue({
      runtimes
    });
  }
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
