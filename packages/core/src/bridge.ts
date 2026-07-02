import type {
  AdapterCallContext,
  AdapterCallRequest,
  AdapterStreamEvent,
  AgentRuntimeAdapter,
  BridgeLogger,
  Principal,
  RuntimeCapabilities,
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
import { AuditLog, type AuditLogEntry } from "./audit-log.js";
import { BridgeObservability, type BridgeSpanExporter, type BridgeTraceSnapshot } from "./observability.js";
import { JsonBridgeStore, type StoredBridgeSession } from "./persistent-store.js";
import {
  BridgeResourceIndex,
  extractBridgeResources,
  type BridgeResource,
  type BridgeResourceFilter,
  type BridgeResourcePatch,
  type BridgeResourceWrite
} from "./resources.js";
import { AllowAllAccessPolicy, type AccessPolicy } from "./scope-policy.js";

export interface AgentBridgeOptions {
  adapters?: AgentRuntimeAdapter[];
  accessPolicy?: AccessPolicy;
  logger?: BridgeLogger;
  auditLimit?: number;
  defaultTimeoutMs?: number;
  maxConcurrentCalls?: number;
  runtimeConcurrency?: Record<string, number>;
  persistencePath?: string;
  resourceLimit?: number;
  maxAttempts?: number;
  retryBackoffMs?: number;
  circuitBreaker?: CircuitBreakerOptions;
  persistenceFlushMs?: number;
  spanExporter?: BridgeSpanExporter;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
}

export interface BridgePlanStep {
  id?: string;
  runtime?: string;
  capability?: string;
  method: string;
  params?: JsonValue;
  session?: BridgeRequest["session"];
  meta?: BridgeRequest["meta"];
  handoff?: boolean | { fromStep?: string };
}

export interface BridgePlan {
  id?: string;
  traceId?: string;
  stopOnError?: boolean;
  steps: BridgePlanStep[];
}

export interface BridgePlanStepResult {
  stepId: string;
  runtime?: string;
  response: BridgeResponse;
  traceId: string;
}

export class AgentBridge {
  readonly registry = new AdapterRegistry();
  readonly audit: AuditLog;
  readonly resources: BridgeResourceIndex;
  readonly observability: BridgeObservability;
  private readonly accessPolicy: AccessPolicy;
  private readonly logger?: BridgeLogger;
  private readonly sessionBindings = new Map<string, BridgeSessionBinding>();
  private readonly activeCalls = new Map<string, ActiveBridgeCall>();
  private readonly globalLimiter: ConcurrencyLimiter;
  private readonly runtimeLimiters = new Map<string, ConcurrencyLimiter>();
  private readonly defaultTimeoutMs?: number;
  private readonly runtimeConcurrency: Record<string, number>;
  private readonly store?: JsonBridgeStore;
  private readonly health: RuntimeHealthTracker;
  private readonly maxAttempts: number;
  private readonly retryBackoffMs: number;
  private readonly capabilityCache = new Map<string, RuntimeCapabilities>();
  private readonly roundRobin = new Map<string, number>();

  constructor(options: AgentBridgeOptions = {}) {
    this.store = options.persistencePath
      ? new JsonBridgeStore(options.persistencePath, normalizePositiveNumber(options.persistenceFlushMs) ?? 50)
      : undefined;
    const snapshot = this.store?.load();
    for (const session of snapshot?.sessions ?? []) {
      this.sessionBindings.set(session.id, session);
    }
    this.accessPolicy = options.accessPolicy ?? new AllowAllAccessPolicy();
    this.logger = options.logger;
    this.audit = new AuditLog(options.auditLimit, snapshot?.audit);
    this.resources = new BridgeResourceIndex(snapshot?.resources, options.resourceLimit);
    this.observability = new BridgeObservability(options.spanExporter);
    this.defaultTimeoutMs = normalizePositiveNumber(options.defaultTimeoutMs);
    this.runtimeConcurrency = options.runtimeConcurrency ?? {};
    this.globalLimiter = new ConcurrencyLimiter(options.maxConcurrentCalls);
    this.health = new RuntimeHealthTracker(options.circuitBreaker);
    this.maxAttempts = Math.max(1, Math.trunc(normalizePositiveNumber(options.maxAttempts) ?? 1));
    this.retryBackoffMs = normalizePositiveNumber(options.retryBackoffMs) ?? 100;

    for (const adapter of options.adapters ?? []) {
      this.register(adapter);
    }
  }

  register(adapter: AgentRuntimeAdapter): void {
    this.registry.register(adapter);
    this.capabilityCache.delete(adapter.info.id);
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
    this.observability.callStarted();
    try {
      const plan = await this.planTargets(request);
      if ("error" in plan) {
        const response = createErrorResponse({
          id: request.id,
          code: plan.error.code,
          message: plan.error.message,
          data: plan.error.data
        });
        this.recordAudit(request, plan.runtime ?? "unresolved", traceId, startedAt, response, principal);
        return response;
      }

      let lastResponse: BridgeResponse | undefined;
      for (const runtime of plan.candidates) {
        const routedRequest: BridgeRequest = { ...plan.request, runtime };
        const adapter = this.registry.get(runtime);
        if (!adapter) {
          lastResponse = createErrorResponse({
            id: routedRequest.id,
            code: BRIDGE_ERROR_CODES.runtimeNotFound,
            message: `Runtime '${runtime}' is not registered.`
          });
          this.recordAudit(routedRequest, runtime, traceId, startedAt, lastResponse, principal);
          continue;
        }

        if (!this.health.isAvailable(runtime)) {
          lastResponse = createErrorResponse({
            id: routedRequest.id,
            code: BRIDGE_ERROR_CODES.adapterUnavailable,
            message: `Runtime '${runtime}' is temporarily unavailable (circuit open).`,
            data: { runtime, circuit: this.health.snapshot(runtime) as unknown as JsonValue }
          });
          this.recordAudit(routedRequest, runtime, traceId, startedAt, lastResponse, principal);
          continue;
        }

        const access = await this.accessPolicy.authorize({
          request: routedRequest,
          adapter,
          principal
        });
        if (!access.allow) {
          lastResponse = createErrorResponse({
            id: routedRequest.id,
            code: BRIDGE_ERROR_CODES.permissionDenied,
            message: access.reason ?? "Permission denied."
          });
          this.recordAudit(routedRequest, runtime, traceId, startedAt, lastResponse, principal);
          continue;
        }

        const attempt = await this.attemptCall(adapter, runtime, routedRequest, traceId, startedAt, principal);
        if (attempt.done) return attempt.response;
        lastResponse = attempt.response;
      }

      return lastResponse ?? createErrorResponse({
        id: request.id,
        code: BRIDGE_ERROR_CODES.internalError,
        message: "No runtime handled the request."
      });
    } finally {
      this.observability.callSettled();
    }
  }

  async *streamCall(
    request: BridgeRequest,
    principal?: Principal
  ): AsyncIterable<AdapterStreamEvent> {
    const startedAt = Date.now();
    const traceId = request.meta?.traceId ?? `trace_${Date.now().toString(36)}`;
    this.observability.callStarted();
    try {
      const plan = await this.planTargets(request);
      if ("error" in plan) {
        const response = createErrorResponse({
          id: request.id,
          code: plan.error.code,
          message: plan.error.message,
          data: plan.error.data
        });
        this.recordAudit(request, plan.runtime ?? "unresolved", traceId, startedAt, response, principal);
        yield {
          type: "error",
          message: plan.error.message,
          code: plan.error.code,
          data: plan.error.data
        };
        return;
      }

      const runtime = plan.candidates[0];
      const routedRequest: BridgeRequest = { ...plan.request, runtime };
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

      if (!this.health.isAvailable(runtime)) {
        const message = `Runtime '${runtime}' is temporarily unavailable (circuit open).`;
        const response = createErrorResponse({
          id: routedRequest.id,
          code: BRIDGE_ERROR_CODES.adapterUnavailable,
          message
        });
        this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);
        yield { type: "error", message, code: BRIDGE_ERROR_CODES.adapterUnavailable };
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
              this.indexResourcesFromStreamEvent(event, routedRequest, runtime, traceId);
              yield event;
            }
          } catch (error) {
            void iterator.return?.().catch(() => undefined);
            throw error;
          }

          const response = createSuccessResponse(routedRequest, finalResult ?? null);
          this.health.recordSuccess(runtime);
          this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);
          return;
        }

        const result = await raceWithSignal(
          Promise.resolve(adapter.call(callRequest, context)),
          active.signal
        );
        const resultJson = toJsonValue(result);
        const response = createSuccessResponse(routedRequest, resultJson);
        this.indexResourcesFromValue(resultJson, routedRequest, runtime, traceId);
        this.health.recordSuccess(runtime);
        this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);
        yield {
          type: "result",
          data: resultJson
        };
      } catch (error) {
        const response = this.errorResponseFromAdapterError(routedRequest, error, "Adapter stream failed.");
        const maybeError = response.error;
        if (!active.signal.aborted && isServerFailure(maybeError.code)) {
          this.health.recordFailure(runtime);
        }
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
    } finally {
      this.observability.callSettled();
    }
  }

  /**
   * Fan-out orchestration: dispatch the same request to every runtime that
   * advertises `capability` and collect each response. Unlike capability
   * routing (which picks one healthy runtime), broadcast targets all matches.
   */
  async broadcast(
    capability: string,
    request: Omit<BridgeRequest, "runtime" | "capability">,
    principal?: Principal
  ): Promise<JsonValue> {
    const cap = normalizeNonEmptyString(capability);
    if (!cap) {
      return toJsonValue({ capability, results: [] });
    }
    const candidates = await this.candidatesForCapability(cap);
    const results = await Promise.all(
      candidates.map(async (runtime) => ({
        runtime,
        response: (await this.call({ ...request, runtime } as BridgeRequest, principal)) as unknown as JsonValue
      }))
    );
    return toJsonValue({ capability: cap, results });
  }

  async runPlan(plan: BridgePlan, principal?: Principal): Promise<JsonValue> {
    const planId = normalizeNonEmptyString(plan.id) ?? `plan_${Date.now().toString(36)}`;
    const baseTraceId = normalizeNonEmptyString(plan.traceId) ?? `trace_${planId}`;
    const stepRuntimes = new Map<string, string>();
    const results: BridgePlanStepResult[] = [];
    let previousStepId: string | undefined;
    let status: "success" | "error" = "success";

    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index];
      const stepId = normalizeNonEmptyString(step.id) ?? `step_${index + 1}`;
      const handoffFrom = typeof step.handoff === "object"
        ? normalizeNonEmptyString(step.handoff.fromStep)
        : step.handoff === true
          ? previousStepId
          : undefined;
      const handoffRuntime = handoffFrom ? stepRuntimes.get(handoffFrom) : undefined;
      const traceId = `${baseTraceId}.${stepId}`;
      const request: BridgeRequest = {
        jsonrpc: "2.0",
        id: `${planId}_${stepId}`,
        runtime: step.runtime ?? handoffRuntime,
        capability: step.runtime ?? handoffRuntime ? undefined : step.capability,
        session: step.session,
        method: step.method,
        params: step.params,
        meta: {
          ...step.meta,
          traceId
        }
      };

      if (step.handoff && !request.runtime) {
        const response = createErrorResponse({
          id: request.id,
          code: BRIDGE_ERROR_CODES.invalidRequest,
          message: `Plan step '${stepId}' requested handoff but no source runtime was available.`
        });
        results.push({ stepId, response, traceId });
        status = "error";
        if (plan.stopOnError !== false) break;
        previousStepId = stepId;
        continue;
      }

      const response = await this.call(request, principal);
      const runtime = this.latestRuntimeForRequest(request.id, traceId);
      if (runtime) stepRuntimes.set(stepId, runtime);
      results.push({ stepId, runtime, response, traceId });
      previousStepId = stepId;
      if ("error" in response) {
        status = "error";
        if (plan.stopOnError !== false) break;
      }
    }

    return toJsonValue({
      id: planId,
      status,
      steps: results,
      final: results.at(-1)?.response ?? null
    });
  }

  async listRuntimes(): Promise<JsonValue> {
    const runtimes = await Promise.all(
      this.registry.list().map(async (adapter) => ({
        ...adapter.info,
        capabilities: await adapter.capabilities(),
        methodCount: (await this.getAdapterMethods(adapter)).length,
        health: await this.probeHealth(adapter)
      }))
    );

    return toJsonValue({
      runtimes
    });
  }

  async listHealth(runtimeId?: string): Promise<JsonValue> {
    const adapters = runtimeId
      ? this.registry.get(runtimeId)
        ? [this.registry.get(runtimeId)!]
        : []
      : this.registry.list();

    const runtimes = await Promise.all(
      adapters.map(async (adapter) => ({
        runtime: adapter.info.id,
        ...(await this.probeHealth(adapter))
      }))
    );

    return toJsonValue({ runtimes });
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

  listResources(filter: BridgeResourceFilter = {}): JsonValue {
    return this.resources.toJson(filter);
  }

  getResource(id: string): JsonValue {
    return toJsonValue({ resource: this.resources.get(id) ?? null });
  }

  createResource(input: BridgeResourceWrite): JsonValue {
    const resource = this.resources.create(input);
    this.persistState();
    return toJsonValue({ resource });
  }

  updateResource(id: string, patch: BridgeResourcePatch): JsonValue {
    const resource = this.resources.update(id, patch);
    if (resource) this.persistState();
    return toJsonValue({ resource: resource ?? null });
  }

  deleteResource(id: string): boolean {
    const deleted = this.resources.delete(id);
    if (deleted) this.persistState();
    return deleted;
  }

  metrics(): JsonValue {
    return this.observability.toJson(this.concurrencySnapshot());
  }

  getTrace(traceId: string): JsonValue {
    const trace: BridgeTraceSnapshot = {
      traceId,
      audit: this.audit.snapshot().filter((entry) => entry.traceId === traceId),
      resources: this.resources.snapshot().filter((resource) => resource.traceId === traceId)
    };
    return toJsonValue(trace);
  }

  cancel(requestId: string): boolean {
    const call = this.activeCalls.get(requestId);
    if (!call) return false;
    call.controller.abort(new Error(`Bridge request '${requestId}' was cancelled.`));
    return true;
  }

  async flushPersistence(): Promise<void> {
    await this.store?.flush();
  }

  private async attemptCall(
    adapter: AgentRuntimeAdapter,
    runtime: string,
    routedRequest: BridgeRequest,
    traceId: string,
    startedAt: number,
    principal?: Principal
  ): Promise<{ done: boolean; response: BridgeResponse }> {
    let response: BridgeResponse = createErrorResponse({
      id: routedRequest.id,
      code: BRIDGE_ERROR_CODES.internalError,
      message: "Adapter call failed."
    });

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      const active = this.createCallController(routedRequest, traceId);
      const callRequest = createAdapterCallRequest(routedRequest);
      const context = this.createAdapterContext(routedRequest, runtime, traceId, principal, active.signal);
      const limiter = this.runtimeLimiter(runtime);

      try {
        const result = await this.runLimited(active.signal, limiter, () => adapter.call(callRequest, context));
        response = createSuccessResponse(routedRequest, toJsonValue(result));
        if ("result" in response) {
          this.indexResourcesFromValue(response.result, routedRequest, runtime, traceId);
        }
        this.health.recordSuccess(runtime);
        this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);
        return { done: true, response };
      } catch (error) {
        const aborted = active.signal.aborted;
        response = this.errorResponseFromAdapterError(routedRequest, error, "Adapter call failed.");
        this.logger?.error("Adapter call failed.", {
          runtime,
          method: routedRequest.method,
          attempt,
          error
        });
        this.recordAudit(routedRequest, runtime, traceId, startedAt, response, principal);

        // Aborts are user cancellations or bridge timeouts: never retry or fail over.
        if (aborted) return { done: true, response };

        const code = "error" in response ? response.error.code : undefined;
        if (isServerFailure(code)) this.health.recordFailure(runtime);
        if (isRetryable(code) && attempt < this.maxAttempts) {
          await delay(this.retryBackoffMs * attempt);
          continue;
        }
        // Exhausted retries on this runtime; allow the caller to fail over.
        return { done: false, response };
      } finally {
        active.dispose();
      }
    }

    return { done: false, response };
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
    const entry: AuditLogEntry = {
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
    };
    this.audit.record(entry);
    this.observability.callFinished(entry);
    this.persistState();
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

  /**
   * Resolve a request to an ordered list of candidate runtimes.
   * - capability-only requests fan out to all matching runtimes, health-first;
   * - runtime/session requests resolve to a single sticky candidate.
   */
  private async planTargets(request: BridgeRequest): Promise<RuntimePlan> {
    const capability = normalizeNonEmptyString(request.capability);
    const explicitRuntime = normalizeNonEmptyString(request.runtime);
    const sessionId = normalizeNonEmptyString(request.session?.id);

    if (capability && !explicitRuntime && !sessionId) {
      const candidates = await this.candidatesForCapability(capability);
      if (candidates.length === 0) {
        return {
          error: {
            code: BRIDGE_ERROR_CODES.runtimeNotFound,
            message: `No runtime provides capability '${capability}'.`,
            data: { capability }
          }
        };
      }
      return { candidates, request: { ...request } };
    }

    const resolved = this.resolveRuntimeRequest(request);
    if ("error" in resolved) return resolved;
    return { candidates: [resolved.runtime], request: resolved.request };
  }

  private async candidatesForCapability(capability: string): Promise<string[]> {
    const matches: string[] = [];
    for (const adapter of this.registry.list()) {
      const caps = await this.getCapabilities(adapter);
      if (capabilityMatches(caps, capability)) matches.push(adapter.info.id);
    }
    return this.orderByHealth(capability, matches);
  }

  private async getCapabilities(adapter: AgentRuntimeAdapter): Promise<RuntimeCapabilities> {
    const cached = this.capabilityCache.get(adapter.info.id);
    if (cached) return cached;
    const caps = await adapter.capabilities();
    this.capabilityCache.set(adapter.info.id, caps);
    return caps;
  }

  private orderByHealth(key: string, runtimes: string[]): string[] {
    const available = runtimes.filter((runtime) => this.health.isAvailable(runtime));
    const unavailable = runtimes.filter((runtime) => !this.health.isAvailable(runtime));
    return [...this.rotate(key, available), ...unavailable];
  }

  private rotate(key: string, list: string[]): string[] {
    if (list.length <= 1) return list;
    const offset = (this.roundRobin.get(key) ?? 0) % list.length;
    this.roundRobin.set(key, offset + 1);
    return [...list.slice(offset), ...list.slice(0, offset)];
  }

  private async probeHealth(adapter: AgentRuntimeAdapter): Promise<{ circuit: JsonValue; reported: JsonValue }> {
    const circuit = this.health.snapshot(adapter.info.id) as unknown as JsonValue;
    let reported: JsonValue = null;
    if (adapter.health) {
      try {
        reported = toJsonValue(await adapter.health());
      } catch (error) {
        reported = {
          status: "down",
          details: { error: error instanceof Error ? error.message : String(error) }
        };
      }
    }
    return { circuit, reported };
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
    this.persistState();

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

  private indexResourcesFromValue(
    value: JsonValue,
    request: BridgeRequest,
    runtime: string,
    traceId: string
  ): void {
    const resources = extractBridgeResources(value, {
      runtime,
      method: request.method,
      requestId: request.id ?? null,
      traceId,
      sessionId: request.session?.id,
      timestamp: new Date().toISOString()
    });
    if (resources.length === 0) return;
    for (const resource of resources) {
      this.resources.upsert(resource);
    }
  }

  private indexResourcesFromStreamEvent(
    event: AdapterStreamEvent,
    request: BridgeRequest,
    runtime: string,
    traceId: string
  ): void {
    if (event.type !== "artifact" && event.type !== "custom") return;
    const data = event.type === "artifact" ? event.data : event.data;
    if (data === undefined) return;
    this.indexResourcesFromValue(toJsonValue(data), request, runtime, traceId);
  }

  private concurrencySnapshot(): Record<string, { active: number; queued: number; max: number | null }> {
    const snapshot: Record<string, { active: number; queued: number; max: number | null }> = {};
    snapshot.global = this.globalLimiter.snapshot();
    for (const [runtime, limiter] of this.runtimeLimiters.entries()) {
      snapshot[runtime] = limiter.snapshot();
    }
    return snapshot;
  }

  private latestRuntimeForRequest(requestId: BridgeRequest["id"], traceId: string): string | undefined {
    const id = requestId ?? null;
    const matches = this.audit.snapshot()
      .filter((entry) => entry.traceId === traceId && entry.requestId === id);
    return (matches.find((entry) => entry.status === "success") ?? matches[0])?.runtime;
  }

  private persistState(): void {
    if (!this.store) return;
    try {
      this.store.scheduleSave({
        version: 1,
        sessions: [...this.sessionBindings.values()].map(toStoredSession),
        audit: this.audit.snapshot(),
        resources: this.resources.snapshot(),
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      this.logger?.warn("Failed to persist bridge state.", {
        error
      });
    }
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

type RuntimePlan =
  | { candidates: string[]; request: BridgeRequest }
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

  snapshot(): { active: number; queued: number; max: number | null } {
    return {
      active: this.active,
      queued: this.queue.length,
      max: Number.isFinite(this.max) ? this.max : null
    };
  }
}

interface LimiterWaiter {
  release(): void;
}

/**
 * Per-runtime circuit breaker. Consecutive failures open the circuit; after a
 * cooldown the breaker allows a single half-open trial. Success closes it.
 */
class RuntimeHealthTracker {
  private readonly states = new Map<string, { failures: number; openedAt?: number }>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = normalizePositiveNumber(options.failureThreshold) ?? 5;
    this.cooldownMs = normalizePositiveNumber(options.cooldownMs) ?? 30_000;
  }

  isAvailable(runtime: string): boolean {
    const state = this.states.get(runtime);
    if (!state || state.openedAt === undefined) return true;
    return Date.now() - state.openedAt >= this.cooldownMs;
  }

  recordSuccess(runtime: string): void {
    this.states.set(runtime, { failures: 0 });
  }

  recordFailure(runtime: string): void {
    const state = this.states.get(runtime) ?? { failures: 0 };
    state.failures += 1;
    if (state.failures >= this.failureThreshold) {
      state.openedAt = Date.now();
    }
    this.states.set(runtime, state);
  }

  snapshot(runtime: string): { state: "closed" | "open" | "half_open"; failures: number } {
    const state = this.states.get(runtime);
    if (!state || state.openedAt === undefined) {
      return { state: "closed", failures: state?.failures ?? 0 };
    }
    if (Date.now() - state.openedAt >= this.cooldownMs) {
      return { state: "half_open", failures: state.failures };
    }
    return { state: "open", failures: state.failures };
  }
}

function capabilityMatches(caps: RuntimeCapabilities, capability: string): boolean {
  const entry = caps[capability];
  if (entry !== undefined) {
    return entry !== false;
  }
  // Fall back to matching a specific method name declared inside a descriptor.
  return Object.values(caps).some(
    (value) =>
      typeof value === "object" &&
      value !== null &&
      Array.isArray(value.methods) &&
      value.methods.includes(capability)
  );
}

function isRetryable(code?: number): boolean {
  return code === BRIDGE_ERROR_CODES.adapterUnavailable || code === BRIDGE_ERROR_CODES.internalError;
}

function isServerFailure(code?: number): boolean {
  return (
    code === BRIDGE_ERROR_CODES.adapterUnavailable ||
    code === BRIDGE_ERROR_CODES.internalError ||
    code === BRIDGE_ERROR_CODES.timeout
  );
}

function delay(ms: number): Promise<void> {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
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

function toStoredSession(session: BridgeSessionBinding): StoredBridgeSession {
  return {
    id: session.id,
    runtime: session.runtime,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    metadata: session.metadata
  };
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
