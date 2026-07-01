import type {
  AdapterCallContext,
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
import type {
  BridgeRequest,
  BridgeResponse,
  JsonObject,
  JsonValue
} from "@uab/protocol";
import { AdapterRegistry } from "./adapter-registry.js";
import { AuditLog } from "./audit-log.js";
import { AllowAllAccessPolicy, type AccessPolicy } from "./scope-policy.js";

export interface AgentBridgeOptions {
  adapters?: AgentRuntimeAdapter[];
  accessPolicy?: AccessPolicy;
  logger?: BridgeLogger;
  auditLimit?: number;
  defaultTimeoutMs?: number;
  maxConcurrentCalls?: number;
  runtimeConcurrency?: Record<string, number>;
}

export class AgentBridge {
  readonly registry = new AdapterRegistry();
  readonly audit: AuditLog;
  private readonly accessPolicy: AccessPolicy;
  private readonly logger?: BridgeLogger;
  private readonly sessionBindings = new Map<string, BridgeSessionBinding>();
  private readonly activeCalls = new Map<string, ActiveBridgeCall>();
  private readonly globalLimiter: ConcurrencyLimiter;
  private readonly runtimeLimiters = new Map<string, ConcurrencyLimiter>();
  private readonly defaultTimeoutMs?: number;
  private readonly runtimeConcurrency: Record<string, number>;

  constructor(options: AgentBridgeOptions = {}) {
    this.accessPolicy = options.accessPolicy ?? new AllowAllAccessPolicy();
    this.logger = options.logger;
    this.audit = new AuditLog(options.auditLimit);
    this.defaultTimeoutMs = normalizePositiveNumber(options.defaultTimeoutMs);
    this.runtimeConcurrency = options.runtimeConcurrency ?? {};
    this.globalLimiter = new ConcurrencyLimiter(options.maxConcurrentCalls);

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
    const resolved = this.resolveRuntimeRequest(request);
    if ("error" in resolved) {
      const response = createErrorResponse({
        id: request.id,
        code: resolved.error.code,
        message: resolved.error.message,
        data: resolved.error.data
      });
      this.recordAudit(request, resolved.runtime ?? "unresolved", traceId, startedAt, response, principal);
      return response;
    }

    const { runtime, request: routedRequest } = resolved;
    const adapter = this.registry.get(runtime);
    if (!adapter) {
      const response = createErrorResponse({
        id: routedRequest.id,
        code: BRIDGE_ERROR_CODES.runtimeNotFound,
        message: `Runtime '${runtime}' is not registered.`
      });
      this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);
      return response;
    }

    const access = await this.accessPolicy.authorize({
      request: routedRequest,
      adapter,
      principal
    });

    if (!access.allow) {
      const response = createErrorResponse({
        id: routedRequest.id,
        code: BRIDGE_ERROR_CODES.permissionDenied,
        message: access.reason ?? "Permission denied."
      });
      this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);
      return response;
    }

    const active = this.createCallController(routedRequest, traceId);
    const callRequest = createAdapterCallRequest(routedRequest);
    const context = this.createAdapterContext(routedRequest, runtime, traceId, principal, active.signal);
    const limiter = this.runtimeLimiter(runtime);

    try {
      const result = await this.runLimited(active.signal, limiter, () => adapter.call(callRequest, context));
      const response = createSuccessResponse(routedRequest, toJsonValue(result));
      this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);
      return response;
    } catch (error) {
      const response = this.errorResponseFromAdapterError(routedRequest, error, "Adapter call failed.");
      this.logger?.error("Adapter call failed.", {
        runtime,
        method: routedRequest.method,
        error
      });
      this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);
      return response;
    } finally {
      active.dispose();
    }
  }

  async *streamCall(
    request: BridgeRequest,
    principal?: Principal
  ): AsyncIterable<AdapterStreamEvent> {
    const startedAt = Date.now();
    const traceId = request.meta?.traceId ?? `trace_${Date.now().toString(36)}`;
    const resolved = this.resolveRuntimeRequest(request);
    if ("error" in resolved) {
      const response = createErrorResponse({
        id: request.id,
        code: resolved.error.code,
        message: resolved.error.message,
        data: resolved.error.data
      });
      this.recordAudit(request, resolved.runtime ?? "unresolved", traceId, startedAt, response, principal);
      yield {
        type: "error",
        message: resolved.error.message,
        code: resolved.error.code,
        data: resolved.error.data
      };
      return;
    }

    const { runtime, request: routedRequest } = resolved;
    const adapter = this.registry.get(runtime);
    if (!adapter) {
      const errorEvent: AdapterStreamEvent = {
        type: "error",
        message: `Runtime '${runtime}' is not registered.`,
        code: BRIDGE_ERROR_CODES.runtimeNotFound
      };
      const response = createErrorResponse({
        id: routedRequest.id,
        code: Number(errorEvent.code),
        message: errorEvent.message
      });
      this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);
      yield errorEvent;
      return;
    }

    const access = await this.accessPolicy.authorize({
      request: routedRequest,
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
        id: routedRequest.id,
        code: Number(errorEvent.code),
        message: errorEvent.message
      });
      this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);
      yield errorEvent;
      return;
    }

    const active = this.createCallController(routedRequest, traceId);
    const callRequest = createAdapterCallRequest(routedRequest);
    const context = this.createAdapterContext(routedRequest, runtime, traceId, principal, active.signal);
    const limiter = this.runtimeLimiter(runtime);

    let globalAcquired = false;
    let runtimeAcquired = false;
    try {
      await this.globalLimiter.acquire(active.signal);
      globalAcquired = true;
      await limiter.acquire(active.signal);
      runtimeAcquired = true;

      if (adapter.stream) {
        let finalResult: JsonValue | undefined;
        const iterator = adapter.stream(callRequest, context)[Symbol.asyncIterator]();
        try {
          while (true) {
            const next = await raceWithSignal(iterator.next(), active.signal);
            if (next.done) break;
            const event = next.value;
            if (event.type === "result") {
              finalResult = event.data;
            }
            yield event;
          }
        } catch (error) {
          void iterator.return?.().catch(() => undefined);
          throw error;
        }

        const response = createSuccessResponse(routedRequest, finalResult ?? null);
        this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);
        return;
      }

      const result = await raceWithSignal(
        Promise.resolve(adapter.call(callRequest, context)),
        active.signal
      );
      const resultJson = toJsonValue(result);
      const response = createSuccessResponse(routedRequest, resultJson);
      this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);
      yield {
        type: "result",
        data: resultJson
      };
    } catch (error) {
      const response = this.errorResponseFromAdapterError(routedRequest, error, "Adapter stream failed.");
      const maybeError = response.error;
      this.logger?.error("Adapter stream failed.", {
        runtime,
        method: routedRequest.method,
        error
      });
      this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);
      yield {
        type: "error",
        message: maybeError.message,
        code: maybeError.code,
        data: maybeError.data
      };
    } finally {
      if (runtimeAcquired) limiter.release();
      if (globalAcquired) this.globalLimiter.release();
      active.dispose();
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

  listSessions(): JsonValue {
    return toJsonValue({
      sessions: [...this.sessionBindings.values()]
    });
  }

  cancel(requestId: string): boolean {
    const call = this.activeCalls.get(requestId);
    if (!call) return false;
    call.controller.abort(new Error(`Bridge request '${requestId}' was cancelled.`));
    return true;
  }

  private recordAudit(
    request: BridgeRequest,
    runtime: string,
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
      runtime,
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

  private resolveRuntimeRequest(request: BridgeRequest): RuntimeResolution {
    const explicitRuntime = normalizeNonEmptyString(request.runtime);
    const sessionId = normalizeNonEmptyString(request.session?.id);

    if (!sessionId) {
      if (!explicitRuntime) {
        return {
          error: {
            code: BRIDGE_ERROR_CODES.invalidRequest,
            message: "Request runtime is required when no session is provided."
          }
        };
      }
      return {
        runtime: explicitRuntime,
        request: {
          ...request,
          runtime: explicitRuntime
        }
      };
    }

    const existing = this.sessionBindings.get(sessionId);
    const runtime = explicitRuntime ?? existing?.runtime;
    if (!runtime) {
      return {
        error: {
          code: BRIDGE_ERROR_CODES.invalidRequest,
          message: `Session '${sessionId}' has no runtime binding yet. Provide runtime on first use.`,
          data: { sessionId }
        }
      };
    }

    if (existing && explicitRuntime && existing.runtime !== explicitRuntime) {
      return {
        runtime,
        error: {
          code: BRIDGE_ERROR_CODES.invalidRequest,
          message: `Session '${sessionId}' is already bound to runtime '${existing.runtime}'.`,
          data: {
            sessionId,
            boundRuntime: existing.runtime,
            requestedRuntime: explicitRuntime
          }
        }
      };
    }

    const now = new Date().toISOString();
    const binding: BridgeSessionBinding = {
      id: sessionId,
      runtime,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      metadata: request.session?.metadata ?? existing?.metadata
    };
    this.sessionBindings.set(sessionId, binding);

    return {
      runtime,
      request: {
        ...request,
        runtime,
        session: {
          ...request.session,
          id: sessionId
        }
      }
    };
  }

  private createCallController(request: BridgeRequest, traceId: string): ActiveBridgeCall {
    const controller = new AbortController();
    const id = String(request.id ?? traceId);
    const timeoutMs = normalizePositiveNumber(request.meta?.timeoutMs) ?? this.defaultTimeoutMs;
    let timeout: NodeJS.Timeout | undefined;

    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        controller.abort(new Error(`Bridge request timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    }

    const active: ActiveBridgeCall = {
      id,
      controller,
      signal: controller.signal,
      dispose: () => {
        if (timeout) clearTimeout(timeout);
        this.activeCalls.delete(id);
      }
    };
    this.activeCalls.set(id, active);
    return active;
  }

  private createAdapterContext(
    request: BridgeRequest,
    runtime: string,
    traceId: string,
    principal: Principal | undefined,
    signal: AbortSignal
  ): AdapterCallContext {
    return {
      requestId: request.id ?? null,
      traceId,
      principal,
      session: request.session ? {
        id: request.session.id,
        action: request.session.action,
        runtime,
        metadata: request.session.metadata
      } : undefined,
      signal,
      logger: this.logger
    };
  }

  private runtimeLimiter(runtime: string): ConcurrencyLimiter {
    const existing = this.runtimeLimiters.get(runtime);
    if (existing) return existing;
    const limiter = new ConcurrencyLimiter(this.runtimeConcurrency[runtime]);
    this.runtimeLimiters.set(runtime, limiter);
    return limiter;
  }

  private async runLimited<T>(
    signal: AbortSignal,
    runtimeLimiter: ConcurrencyLimiter,
    fn: () => Promise<T> | T
  ): Promise<T> {
    await this.globalLimiter.acquire(signal);
    try {
      await runtimeLimiter.acquire(signal);
      try {
        return await raceWithSignal(Promise.resolve(fn()), signal);
      } finally {
        runtimeLimiter.release();
      }
    } finally {
      this.globalLimiter.release();
    }
  }

  private errorResponseFromAdapterError(
    request: BridgeRequest,
    error: unknown,
    fallbackMessage: string
  ): BridgeResponse & { error: { code: number; message: string; data?: JsonValue } } {
    const maybeError = error as {
      code?: number;
      message?: string;
      data?: JsonValue;
    };

    const aborted = error instanceof Error && error.name === "AbortError";
    return createErrorResponse({
      id: request.id,
      code: maybeError.code ?? (aborted ? BRIDGE_ERROR_CODES.timeout : BRIDGE_ERROR_CODES.internalError),
      message: maybeError.message ?? fallbackMessage,
      data: maybeError.data
    }) as BridgeResponse & { error: { code: number; message: string; data?: JsonValue } };
  }
}

interface BridgeSessionBinding {
  id: string;
  runtime: string;
  createdAt: string;
  updatedAt: string;
  metadata?: JsonObject;
}

type RuntimeResolution =
  | { runtime: string; request: BridgeRequest & { runtime: string } }
  | { runtime?: string; error: { code: number; message: string; data?: JsonValue } };

interface ActiveBridgeCall {
  id: string;
  controller: AbortController;
  signal: AbortSignal;
  dispose(): void;
}

class ConcurrencyLimiter {
  private active = 0;
  private readonly queue: Array<LimiterWaiter> = [];
  private readonly max: number;

  constructor(max: number | undefined) {
    this.max = normalizePositiveNumber(max) ?? Number.POSITIVE_INFINITY;
  }

  async run<T>(fn: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(abortErrorFromSignal(signal));

    if (!Number.isFinite(this.max) || this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const waiter: LimiterWaiter = {
        release: () => {
          signal?.removeEventListener("abort", onAbort);
          this.active += 1;
          resolve();
        }
      };
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortErrorFromSignal(signal));
      };

      if (signal) {
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  release(): void {
    if (this.active > 0) this.active -= 1;
    const next = this.queue.shift();
    if (next) next.release();
  }
}

interface LimiterWaiter {
  release(): void;
}

function createAdapterCallRequest(request: BridgeRequest): AdapterCallRequest {
  return {
    method: request.method,
    params: request.params,
    meta: request.meta,
    raw: request
  };
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function raceWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortErrorFromSignal(signal));

  return new Promise((resolve, reject) => {
    let abortTimer: NodeJS.Timeout | undefined;
    const onAbort = () => {
      abortTimer = setTimeout(() => reject(abortErrorFromSignal(signal)), 0);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      if (abortTimer) clearTimeout(abortTimer);
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function abortErrorFromSignal(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string"
      ? reason
      : "Bridge request was aborted.";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
