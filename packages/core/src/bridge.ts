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
import { JsonBridgeStore, type StoredBridgePlanRun, type StoredBridgeSession } from "./persistent-store.js";
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
  dependsOn?: string | string[];
  parallelGroup?: string;
  when?: BridgePlanCondition;
  stream?: boolean;
  streamFrom?: string | string[];
}

export interface BridgePlan {
  id?: string;
  traceId?: string;
  stopOnError?: boolean;
  timeoutMs?: number;
  mode?: "sequence" | "dag";
  steps: BridgePlanStep[];
}

export interface BridgePlanStepResult {
  stepId: string;
  runtime?: string;
  status: "success" | "error" | "skipped" | "cancelled";
  response: BridgeResponse;
  traceId: string;
  input?: JsonValue;
  streamText?: string;
}

export type BridgePlanRunStatus = "pending" | "running" | "succeeded" | "failed" | "cancelled";
export type BridgePlanRunStepStatus = "pending" | "running" | "success" | "error" | "skipped" | "cancelled";

export interface BridgePlanRunStep {
  stepId: string;
  index: number;
  status: BridgePlanRunStepStatus;
  method: string;
  dependsOn: string[];
  streamFrom?: string[];
  traceId: string;
  requestId: string;
  runtime?: string;
  startedAt?: string;
  completedAt?: string;
  input?: JsonValue;
  response?: BridgeResponse;
  streamText?: string;
}

export interface BridgePlanRunSnapshot {
  id: string;
  planId: string;
  traceId: string;
  status: BridgePlanRunStatus;
  plan: BridgePlan;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: JsonValue;
  steps: BridgePlanRunStep[];
  final: BridgeResponse | null;
}

export type BridgePlanCondition =
  | {
      ref: string;
      equals?: JsonValue;
      notEquals?: JsonValue;
      exists?: boolean;
    }
  | { all: BridgePlanCondition[] }
  | { any: BridgePlanCondition[] }
  | { not: BridgePlanCondition };

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
  private readonly planRuns = new Map<string, BridgePlanRunSnapshot>();
  private readonly activePlanRuns = new Map<string, ActivePlanRun>();

  constructor(options: AgentBridgeOptions = {}) {
    this.store = options.persistencePath
      ? new JsonBridgeStore(options.persistencePath, normalizePositiveNumber(options.persistenceFlushMs) ?? 50)
      : undefined;
    const snapshot = this.store?.load();
    for (const session of snapshot?.sessions ?? []) {
      this.sessionBindings.set(session.id, session);
    }
    for (const run of snapshot?.planRuns ?? []) {
      const normalized = fromStoredPlanRun(run);
      if (normalized) {
        this.planRuns.set(normalized.id, isTerminalPlanRunStatus(normalized.status)
          ? normalized
          : resetPlanRunForResume(normalized));
      }
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
    const run = this.createPlanRun(plan);
    const completed = await this.drivePlanRun(run.id, principal);
    return toJsonValue(toPlanRunResult(completed));
  }

  startPlanRun(plan: BridgePlan, principal?: Principal): JsonValue {
    const run = this.createPlanRun(plan);
    void this.drivePlanRun(run.id, principal);
    return toJsonValue({ run });
  }

  async resumePlanRun(runId: string, principal?: Principal): Promise<JsonValue> {
    const run = this.planRuns.get(runId);
    if (!run) return toJsonValue({ run: null });
    if (this.activePlanRuns.has(runId)) return toJsonValue({ run });

    const reset = resetPlanRunForResume(run);
    this.planRuns.set(runId, reset);
    this.persistState();
    const completed = await this.drivePlanRun(runId, principal);
    return toJsonValue({ run: completed });
  }

  getPlanRun(runId: string): JsonValue {
    return toJsonValue({ run: this.planRuns.get(runId) ?? null });
  }

  listPlanRuns(limit = 50): JsonValue {
    const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 50;
    const normalizedLimit = Math.max(1, Math.min(requestedLimit, 200));
    const runs = [...this.planRuns.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, normalizedLimit);
    return toJsonValue({ runs, limit: normalizedLimit, total: this.planRuns.size });
  }

  cancelPlanRun(runId: string): boolean {
    const active = this.activePlanRuns.get(runId);
    if (active) {
      active.controller.abort(new Error(`Plan run '${runId}' was cancelled.`));
      return true;
    }
    const run = this.planRuns.get(runId);
    if (!run || isTerminalPlanRunStatus(run.status)) return false;
    this.markPlanRunCancelled(run, new Error(`Plan run '${runId}' was cancelled.`));
    return true;
  }

  private createPlanRun(plan: BridgePlan): BridgePlanRunSnapshot {
    const planId = normalizeNonEmptyString(plan.id) ?? `plan_${Date.now().toString(36)}`;
    const runId = this.uniquePlanRunId(planId);
    const traceId = normalizeNonEmptyString(plan.traceId) ?? `trace_${runId}`;
    const now = new Date().toISOString();
    const steps = normalizePlanRunSteps(plan, runId, traceId);
    const run: BridgePlanRunSnapshot = {
      id: runId,
      planId,
      traceId,
      status: "pending",
      plan,
      createdAt: now,
      updatedAt: now,
      steps,
      final: null
    };
    this.planRuns.set(run.id, run);
    this.persistState();
    return run;
  }

  private uniquePlanRunId(base: string): string {
    if (!this.planRuns.has(base)) return base;
    let candidate = `${base}_${Date.now().toString(36)}`;
    while (this.planRuns.has(candidate)) {
      candidate = `${base}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    }
    return candidate;
  }

  private drivePlanRun(runId: string, principal?: Principal): Promise<BridgePlanRunSnapshot> {
    const active = this.activePlanRuns.get(runId);
    if (active) return active.done;

    const run = this.planRuns.get(runId);
    if (!run) return Promise.reject(new Error(`Plan run '${runId}' was not found.`));

    const controller = new AbortController();
    const timeoutMs = normalizePositiveNumber(run.plan.timeoutMs);
    let timeout: NodeJS.Timeout | undefined;
    if (timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        controller.abort(new Error(`Plan run '${runId}' timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      timeout.unref?.();
    }

    const done = this.executePlanRun(runId, controller.signal, principal)
      .finally(() => {
        if (timeout) clearTimeout(timeout);
        this.activePlanRuns.delete(runId);
      });
    this.activePlanRuns.set(runId, { controller, done });
    return done;
  }

  private async executePlanRun(
    runId: string,
    signal: AbortSignal,
    principal?: Principal
  ): Promise<BridgePlanRunSnapshot> {
    const run = this.planRuns.get(runId);
    if (!run) throw new Error(`Plan run '${runId}' was not found.`);

    const now = new Date().toISOString();
    run.status = "running";
    run.startedAt = run.startedAt ?? now;
    run.updatedAt = now;
    this.persistState();

    const state = this.createPlanExecutionState(run);
    const stepPromises = new Map<string, Promise<BridgePlanStepResult>>();

    const launchStep = (stepRun: BridgePlanRunStep): void => {
      stepRun.status = "running";
      stepRun.startedAt = new Date().toISOString();

      const defn = run.plan.steps[stepRun.index];
      if (defn.stream) {
        let notify!: () => void;
        const started = new Promise<void>((r) => { notify = r; });
        state.stepStreamNotifiers.set(stepRun.stepId, () => {
          if (!state.stepStreamStarted.has(stepRun.stepId)) {
            state.stepStreamStarted.add(stepRun.stepId);
            notify();
          }
        });
        state.stepStreamStartedPromises.set(stepRun.stepId, started);
      }

      const p = this.executePlanStep(
        defn,
        stepRun,
        defaultHandoffSource(stepRun, run.steps),
        state,
        signal,
        principal
      ).then((result) => {
        stepPromises.delete(stepRun.stepId);
        stepRun.status = result.status;
        stepRun.runtime = result.runtime;
        stepRun.completedAt = new Date().toISOString();
        stepRun.input = result.input;
        stepRun.response = result.response;
        if (result.streamText !== undefined) stepRun.streamText = result.streamText;
        state.stepResults.set(result.stepId, result);
        if (result.runtime) state.stepRuntimes.set(result.stepId, result.runtime);
        run.final = result.response;
        run.updatedAt = new Date().toISOString();
        this.persistState();
        // Ensure stream-start notifier fires even if the step completed without streaming
        state.stepStreamNotifiers.get(result.stepId)?.();
        return result;
      });
      stepPromises.set(stepRun.stepId, p);
    };

    while (true) {
      if (signal.aborted) {
        this.markPlanRunCancelled(run, abortErrorFromSignal(signal));
        return run;
      }

      const pending = run.steps.filter((step) => step.status === "pending");
      if (pending.length === 0 && stepPromises.size === 0) break;

      const ready = pending.filter((stepRun) => {
        // Normal dependsOn: all must be terminal
        if (!stepRun.dependsOn.every((dep) => {
          const up = run.steps.find((s) => s.stepId === dep);
          return up ? isTerminalPlanStepStatus(up.status) : false;
        })) return false;
        // streamFrom: source must be running-and-streaming-started, or terminal
        return (stepRun.streamFrom ?? []).every((dep) => {
          const up = run.steps.find((s) => s.stepId === dep);
          if (!up) return false;
          if (isTerminalPlanStepStatus(up.status)) return true;
          return up.status === "running" && state.stepStreamStarted.has(dep);
        });
      });

      for (const stepRun of ready) {
        launchStep(stepRun);
      }

      run.updatedAt = new Date().toISOString();
      this.persistState();

      if (stepPromises.size === 0) {
        this.markPlanRunFailed(run, createErrorResponse({
          code: BRIDGE_ERROR_CODES.invalidRequest,
          message: "Plan run cannot make progress. Check for missing or cyclic dependsOn/streamFrom references."
        }));
        return run;
      }

      // Collect wakeup signals: step completions + streaming starts for pending streamFrom deps
      const wakeups: Promise<unknown>[] = [...stepPromises.values()];
      for (const [stepId, startedPromise] of state.stepStreamStartedPromises) {
        const stepRun = run.steps.find((s) => s.stepId === stepId);
        if (stepRun?.status === "running" && !state.stepStreamStarted.has(stepId)) {
          wakeups.push(startedPromise);
        }
      }
      await Promise.race(wakeups).catch(() => undefined);

      const hasError = run.steps.some(
        (s) => (s.status === "error" || s.status === "cancelled") && !stepPromises.has(s.stepId)
      );
      if (hasError && run.plan.stopOnError !== false) {
        await Promise.allSettled([...stepPromises.values()]);
        if (signal.aborted || run.steps.some((s) => s.status === "cancelled")) {
          this.markPlanRunCancelled(run, abortErrorFromSignal(signal));
        } else {
          run.status = "failed";
          run.completedAt = new Date().toISOString();
          run.updatedAt = run.completedAt;
          this.cancelPendingPlanSteps(run, "Plan stopped after a step failed.");
          this.persistState();
        }
        return run;
      }
    }

    run.status = run.steps.some((step) => step.status === "error") ? "failed" : "succeeded";
    run.completedAt = new Date().toISOString();
    run.updatedAt = run.completedAt;
    this.persistState();
    return run;
  }

  private createPlanExecutionState(run: BridgePlanRunSnapshot): BridgePlanExecutionState {
    const state: BridgePlanExecutionState = {
      planId: run.id,
      baseTraceId: run.traceId,
      stepRuntimes: new Map(),
      stepResults: new Map(),
      stepStreamText: new Map(),
      stepStreamStarted: new Set(),
      stepStreamNotifiers: new Map(),
      stepStreamStartedPromises: new Map()
    };

    for (const step of run.steps) {
      if (!step.response || !isTerminalPlanStepStatus(step.status)) continue;
      const result: BridgePlanStepResult = {
        stepId: step.stepId,
        runtime: step.runtime,
        status: toPlanStepResultStatus(step.status),
        response: step.response,
        traceId: step.traceId,
        input: step.input,
        streamText: step.streamText
      };
      state.stepResults.set(step.stepId, result);
      if (step.runtime) state.stepRuntimes.set(step.stepId, step.runtime);
      if (step.streamText) state.stepStreamText.set(step.stepId, step.streamText);
    }

    return state;
  }

  private markPlanRunFailed(run: BridgePlanRunSnapshot, response: BridgeResponse): void {
    const now = new Date().toISOString();
    const pending = run.steps.find((step) => step.status === "pending");
    if (pending) {
      pending.status = "error";
      pending.completedAt = now;
      pending.response = response;
    }
    run.final = response;
    run.error = "error" in response ? toJsonValue(response.error) : undefined;
    run.status = "failed";
    run.completedAt = now;
    run.updatedAt = now;
    this.persistState();
  }

  private markPlanRunCancelled(run: BridgePlanRunSnapshot, error: Error): void {
    const now = new Date().toISOString();
    const response = createErrorResponse({
      code: BRIDGE_ERROR_CODES.timeout,
      message: error.message
    });
    for (const step of run.steps) {
      if (step.status === "pending" || step.status === "running") {
        step.status = "cancelled";
        step.completedAt = now;
        step.response = step.response ?? response;
      }
    }
    run.final = response;
    run.error = "error" in response ? toJsonValue(response.error) : undefined;
    run.status = "cancelled";
    run.completedAt = now;
    run.updatedAt = now;
    this.persistState();
  }

  private cancelPendingPlanSteps(run: BridgePlanRunSnapshot, message: string): void {
    const now = new Date().toISOString();
    for (const step of run.steps) {
      if (step.status !== "pending") continue;
      step.status = "cancelled";
      step.completedAt = now;
      step.response = createErrorResponse({
        id: step.requestId,
        code: BRIDGE_ERROR_CODES.invalidRequest,
        message
      });
    }
  }

  private async executePlanStep(
    step: BridgePlanStep,
    stepRun: BridgePlanRunStep,
    defaultHandoffStepId: string | undefined,
    state: BridgePlanExecutionState,
    signal: AbortSignal,
    principal?: Principal
  ): Promise<BridgePlanStepResult> {
    const stepId = stepRun.stepId;
    const traceId = stepRun.traceId;
    const requestId = stepRun.requestId;

    if (signal.aborted) {
      return {
        stepId,
        status: "cancelled",
        response: createErrorResponse({
          id: requestId,
          code: BRIDGE_ERROR_CODES.timeout,
          message: abortErrorFromSignal(signal).message
        }),
        traceId
      };
    }

    if (!evaluatePlanCondition(step.when, state)) {
      return {
        stepId,
        status: "skipped",
        response: createSuccessResponse({
          id: requestId
        }, { skipped: true }),
        traceId
      };
    }

    const handoffFrom = typeof step.handoff === "object"
      ? normalizeNonEmptyString(step.handoff.fromStep)
      : step.handoff === true
        ? defaultHandoffStepId
        : undefined;
    const handoffRuntime = handoffFrom ? state.stepRuntimes.get(handoffFrom) : undefined;
    let request: BridgeRequest;
    try {
      const runtime = resolveTemplateString(step.runtime, state) ?? handoffRuntime;
      const capability = runtime ? undefined : resolveTemplateString(step.capability, state);
      request = {
        jsonrpc: "2.0",
        id: requestId,
        runtime,
        capability,
        session: resolvePlanSession(step.session, state),
        method: resolveTemplateString(step.method, state) ?? step.method,
        params: step.params === undefined ? undefined : resolvePlanTemplates(step.params, state),
        meta: {
          ...(step.meta ? resolvePlanTemplates(step.meta as JsonValue, state) as BridgeRequest["meta"] : {}),
          traceId
        }
      };
    } catch (error) {
      const response = createErrorResponse({
        id: requestId,
        code: BRIDGE_ERROR_CODES.invalidRequest,
        message: error instanceof Error ? error.message : "Plan step template resolution failed."
      });
      return { stepId, status: "error", response, traceId };
    }

    if (step.handoff && !request.runtime) {
      const response = createErrorResponse({
        id: request.id,
        code: BRIDGE_ERROR_CODES.invalidRequest,
        message: `Plan step '${stepId}' requested handoff but no source runtime was available.`
      });
      return { stepId, status: "error", response, traceId };
    }

    if (step.stream === true) {
      return this.executeStreamingPlanStep(step, stepRun, request, state, signal, traceId, principal);
    }

    const onAbort = () => this.cancel(String(request.id ?? traceId));
    signal.addEventListener("abort", onAbort, { once: true });
    let response: BridgeResponse;
    try {
      response = await this.call(request, principal);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    const successfulRuntime = this.latestRuntimeForRequest(request.id, traceId);
    return {
      stepId,
      runtime: successfulRuntime,
      status: signal.aborted ? "cancelled" : "error" in response ? "error" : "success",
      response,
      traceId,
      input: request.params
    };
  }

  private async executeStreamingPlanStep(
    step: BridgePlanStep,
    stepRun: BridgePlanRunStep,
    request: BridgeRequest,
    state: BridgePlanExecutionState,
    signal: AbortSignal,
    traceId: string,
    principal?: Principal
  ): Promise<BridgePlanStepResult> {
    const stepId = stepRun.stepId;
    const notifyStreamStart = state.stepStreamNotifiers.get(stepId);
    let streamText = "";
    let finalResponse: BridgeResponse | undefined;

    const onAbort = () => this.cancel(String(request.id ?? traceId));
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      let started = false;
      for await (const event of this.streamCall(request, principal)) {
        if (!started) {
          started = true;
          notifyStreamStart?.();
        }
        if (event.type === "text") {
          streamText += event.delta;
          state.stepStreamText.set(stepId, streamText);
          stepRun.streamText = streamText;
        } else if (event.type === "result") {
          finalResponse = createSuccessResponse(request, event.data as JsonValue ?? null);
        } else if (event.type === "error") {
          finalResponse = createErrorResponse({
            id: request.id,
            code: typeof event.code === "number" ? event.code : BRIDGE_ERROR_CODES.adapterUnavailable,
            message: event.message
          });
        }
      }
      notifyStreamStart?.();
    } catch (err) {
      notifyStreamStart?.();
      signal.removeEventListener("abort", onAbort);
      const errMsg = err instanceof Error ? err.message : "Adapter stream failed.";
      const response = createErrorResponse({
        id: request.id,
        code: BRIDGE_ERROR_CODES.adapterUnavailable,
        message: errMsg
      });
      return { stepId, status: "error", response, traceId, input: request.params, streamText: streamText || undefined };
    }
    signal.removeEventListener("abort", onAbort);

    const response = finalResponse ?? createSuccessResponse(request, streamText ? { text: streamText } : null);
    const successfulRuntime = this.latestRuntimeForRequest(request.id, traceId);
    return {
      stepId,
      runtime: successfulRuntime,
      status: signal.aborted ? "cancelled" : "error" in response ? "error" : "success",
      response,
      traceId,
      input: request.params,
      streamText: streamText || undefined
    };
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
        planRuns: this.planRunsSnapshot(),
        updatedAt: new Date().toISOString()
      });
    } catch (error) {
      this.logger?.warn("Failed to persist bridge state.", {
        error
      });
    }
  }

  private planRunsSnapshot(): StoredBridgePlanRun[] {
    return [...this.planRuns.values()]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map(toStoredPlanRun);
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

interface BridgePlanExecutionState {
  planId: string;
  baseTraceId: string;
  stepRuntimes: Map<string, string>;
  stepResults: Map<string, BridgePlanStepResult>;
  stepStreamText: Map<string, string>;
  stepStreamStarted: Set<string>;
  stepStreamNotifiers: Map<string, () => void>;
  stepStreamStartedPromises: Map<string, Promise<void>>;
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

interface ActivePlanRun {
  controller: AbortController;
  done: Promise<BridgePlanRunSnapshot>;
}

function normalizePlanRunSteps(plan: BridgePlan, runId: string, traceId: string): BridgePlanRunStep[] {
  const stepIds = plan.steps.map((step, index) => normalizeNonEmptyString(step.id) ?? `step_${index + 1}`);
  const dagMode = plan.mode === "dag" || plan.steps.some((step) => step.dependsOn !== undefined);
  const dependencies = dagMode
    ? normalizeDagDependencies(plan.steps)
    : normalizeSequenceDependencies(plan.steps, stepIds);

  return plan.steps.map((step, index) => {
    const streamFrom = normalizeDependsOn(step.streamFrom);
    const entry: BridgePlanRunStep = {
      stepId: stepIds[index],
      index,
      status: "pending",
      method: step.method,
      dependsOn: dependencies[index],
      traceId: `${traceId}.${stepIds[index]}`,
      requestId: `${runId}_${stepIds[index]}`
    };
    if (streamFrom.length > 0) entry.streamFrom = streamFrom;
    return entry;
  });
}

function normalizeDagDependencies(steps: BridgePlanStep[]): string[][] {
  return steps.map((step) => normalizeDependsOn(step.dependsOn));
}

function normalizeSequenceDependencies(steps: BridgePlanStep[], stepIds: string[]): string[][] {
  const dependencies = steps.map(() => [] as string[]);
  let index = 0;
  let barrier: string[] = [];

  while (index < steps.length) {
    const group = normalizeNonEmptyString(steps[index].parallelGroup);
    if (!group) {
      dependencies[index] = [...barrier];
      barrier = [stepIds[index]];
      index += 1;
      continue;
    }

    const groupStart = index;
    while (index < steps.length && normalizeNonEmptyString(steps[index].parallelGroup) === group) {
      dependencies[index] = [...barrier];
      index += 1;
    }
    barrier = stepIds.slice(groupStart, index);
  }

  return dependencies;
}

function normalizeDependsOn(value: BridgePlanStep["dependsOn"]): string[] {
  if (Array.isArray(value)) return value.map(normalizeNonEmptyString).filter((entry): entry is string => Boolean(entry));
  const single = normalizeNonEmptyString(value);
  return single ? [single] : [];
}

function defaultHandoffSource(step: BridgePlanRunStep, steps: BridgePlanRunStep[]): string | undefined {
  if (step.dependsOn.length > 0) return step.dependsOn.at(-1);
  const previous = steps
    .filter((entry) => entry.index < step.index && isTerminalPlanStepStatus(entry.status))
    .sort((a, b) => b.index - a.index)[0];
  return previous?.stepId;
}

function isTerminalPlanRunStatus(status: BridgePlanRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function isTerminalPlanStepStatus(status: BridgePlanRunStepStatus): boolean {
  return status === "success" || status === "error" || status === "skipped" || status === "cancelled";
}

function toPlanStepResultStatus(status: BridgePlanRunStepStatus): BridgePlanStepResult["status"] {
  if (status === "success" || status === "error" || status === "skipped" || status === "cancelled") return status;
  return "cancelled";
}

function toPlanRunResult(run: BridgePlanRunSnapshot): unknown {
  return {
    id: run.id,
    runId: run.id,
    status: run.status === "succeeded"
      ? "success"
      : run.status === "cancelled"
        ? "cancelled"
        : "error",
    runStatus: run.status,
    steps: run.steps.map((step) => ({
      stepId: step.stepId,
      runtime: step.runtime,
      status: toPlanStepResultStatus(step.status),
      response: step.response ?? createErrorResponse({
        id: step.requestId,
        code: BRIDGE_ERROR_CODES.invalidRequest,
        message: `Plan step '${step.stepId}' did not complete.`
      }),
      traceId: step.traceId,
      input: step.input,
      ...(step.streamText !== undefined ? { streamText: step.streamText } : {})
    })),
    final: run.final
  };
}

function resetPlanRunForResume(run: BridgePlanRunSnapshot): BridgePlanRunSnapshot {
  const now = new Date().toISOString();
  const steps = run.steps.map((step) => {
    if (step.status === "success" || step.status === "skipped") return step;
    return {
      ...step,
      status: "pending" as BridgePlanRunStepStatus,
      runtime: undefined,
      startedAt: undefined,
      completedAt: undefined,
      input: undefined,
      response: undefined,
      streamText: undefined
    };
  });
  return {
    ...run,
    status: "pending",
    updatedAt: now,
    completedAt: undefined,
    error: undefined,
    steps,
    final: steps.find((step) => step.response)?.response ?? null
  };
}

function toStoredPlanRun(run: BridgePlanRunSnapshot): StoredBridgePlanRun {
  return {
    id: run.id,
    planId: run.planId,
    traceId: run.traceId,
    status: run.status,
    plan: toJsonValue(run.plan),
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.error,
    steps: run.steps.map((step) => toJsonValue(step)),
    final: run.final ? toJsonValue(run.final) : null
  };
}

function fromStoredPlanRun(run: StoredBridgePlanRun): BridgePlanRunSnapshot | undefined {
  if (!isJsonRecord(run.plan) || !Array.isArray(run.plan.steps)) return undefined;
  const steps = run.steps.filter(isJsonRecord).map((step) => step as unknown as BridgePlanRunStep);
  if (steps.length === 0) return undefined;
  return {
    id: run.id,
    planId: run.planId,
    traceId: run.traceId,
    status: isPlanRunStatus(run.status) ? run.status : "failed",
    plan: run.plan as unknown as BridgePlan,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    error: run.error,
    steps,
    final: isBridgeResponseJson(run.final) ? run.final as unknown as BridgeResponse : null
  };
}

function isPlanRunStatus(value: string): value is BridgePlanRunStatus {
  return value === "pending" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled";
}

function isBridgeResponseJson(value: JsonValue): boolean {
  return isJsonRecord(value) && value.jsonrpc === "2.0" && ("result" in value || "error" in value);
}

function collectPlanBatch(steps: BridgePlanStep[], index: number): { steps: BridgePlanStep[]; parallel: boolean } {
  const first = steps[index];
  const group = normalizeNonEmptyString(first.parallelGroup);
  if (!group) return { steps: [first], parallel: false };

  let end = index + 1;
  while (end < steps.length && normalizeNonEmptyString(steps[end].parallelGroup) === group) {
    end += 1;
  }
  const batch = steps.slice(index, end);
  return { steps: batch, parallel: batch.length > 1 };
}

function evaluatePlanCondition(condition: BridgePlanCondition | undefined, state: BridgePlanExecutionState): boolean {
  if (!condition) return true;

  if ("all" in condition) {
    return condition.all.every((entry) => evaluatePlanCondition(entry, state));
  }
  if ("any" in condition) {
    return condition.any.some((entry) => evaluatePlanCondition(entry, state));
  }
  if ("not" in condition) {
    return !evaluatePlanCondition(condition.not, state);
  }

  const value = resolvePlanRef(condition.ref, state);
  if (condition.exists !== undefined) {
    const exists = value !== undefined;
    if (exists !== condition.exists) return false;
  }
  if (condition.equals !== undefined) {
    return jsonEquals(toJsonValue(value), resolvePlanTemplates(condition.equals, state));
  }
  if (condition.notEquals !== undefined) {
    return !jsonEquals(toJsonValue(value), resolvePlanTemplates(condition.notEquals, state));
  }
  return Boolean(value);
}

function resolvePlanSession(
  session: BridgeRequest["session"] | undefined,
  state: BridgePlanExecutionState
): BridgeRequest["session"] | undefined {
  if (!session) return undefined;
  const resolved = resolvePlanTemplates(session as unknown as JsonValue, state);
  if (!isJsonRecord(resolved) || typeof resolved.id !== "string") return session;
  return resolved as unknown as BridgeRequest["session"];
}

function resolveTemplateString(value: string | undefined, state: BridgePlanExecutionState): string | undefined {
  if (value === undefined) return undefined;
  const resolved = resolvePlanTemplates(value, state);
  return typeof resolved === "string" && resolved.trim() !== "" ? resolved : undefined;
}

function resolvePlanTemplates(value: JsonValue, state: BridgePlanExecutionState): JsonValue {
  if (typeof value === "string") return resolveTemplateText(value, state);
  if (Array.isArray(value)) return value.map((entry) => resolvePlanTemplates(entry, state));
  if (isJsonRecord(value)) {
    const output: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) output[key] = resolvePlanTemplates(entry as JsonValue, state);
    }
    return output;
  }
  return value;
}

function resolveTemplateText(value: string, state: BridgePlanExecutionState): JsonValue {
  const exact = value.match(/^\$\{\s*([^}]+)\s*\}$/);
  if (exact) {
    const resolved = resolvePlanRef(exact[1], state);
    if (resolved === undefined) throw new MissingPlanReferenceError(exact[1]);
    return toJsonValue(resolved);
  }

  return value.replace(/\$\{\s*([^}]+)\s*\}/g, (_match, ref: string) => {
    const resolved = resolvePlanRef(ref, state);
    if (resolved === undefined) throw new MissingPlanReferenceError(ref);
    if (resolved === null) return "";
    if (typeof resolved === "string") return resolved;
    if (typeof resolved === "number" || typeof resolved === "boolean") return String(resolved);
    return JSON.stringify(resolved);
  });
}

function resolvePlanRef(ref: string, state: BridgePlanExecutionState): unknown {
  const path = unwrapTemplateRef(ref);
  return readPath(planContext(state), parsePath(path));
}

function unwrapTemplateRef(ref: string): string {
  const trimmed = ref.trim();
  const exact = trimmed.match(/^\$\{\s*([^}]+)\s*\}$/);
  const path = exact ? exact[1].trim() : trimmed;
  return path.startsWith("$.") ? path.slice(2) : path;
}

function planContext(state: BridgePlanExecutionState): JsonObject {
  const steps: JsonObject = {};
  for (const [stepId, result] of state.stepResults.entries()) {
    const step: JsonObject = {
      stepId,
      status: result.status,
      traceId: result.traceId,
      response: toJsonValue(result.response)
    };
    if (result.runtime) step.runtime = result.runtime;
    if ("result" in result.response) step.result = result.response.result;
    if ("error" in result.response) step.error = toJsonValue(result.response.error);
    const streamText = result.streamText ?? state.stepStreamText.get(stepId);
    if (streamText) step.stream = { text: streamText };
    steps[stepId] = step;
  }
  // Also expose stream text for steps that are running (not yet in stepResults)
  for (const [stepId, text] of state.stepStreamText.entries()) {
    if (!steps[stepId]) {
      steps[stepId] = { stepId, status: "running", stream: { text } };
    }
  }
  return {
    plan: {
      id: state.planId,
      traceId: state.baseTraceId
    },
    steps
  };
}

function parsePath(path: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let index = 0; index < path.length; index += 1) {
    const char = path[index];
    if (char === ".") {
      if (current) parts.push(current);
      current = "";
      continue;
    }
    if (char === "[") {
      if (current) {
        parts.push(current);
        current = "";
      }
      const end = path.indexOf("]", index);
      if (end === -1) break;
      const raw = path.slice(index + 1, end).trim();
      parts.push(raw.replace(/^["']|["']$/g, ""));
      index = end;
      continue;
    }
    current += char;
  }
  if (current) parts.push(current);
  return parts.filter(Boolean);
}

function readPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (Array.isArray(current)) {
      const index = Number(part);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isJsonRecord(current) || !(part in current)) return undefined;
    current = current[part];
  }
  return current;
}

function jsonEquals(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((entry, index) => jsonEquals(entry, right[index]));
  }
  if (isJsonRecord(left) || isJsonRecord(right)) {
    if (!isJsonRecord(left) || !isJsonRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key, index) => key === rightKeys[index] && jsonEquals(left[key], right[key]));
  }
  return false;
}

function isJsonRecord(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

class MissingPlanReferenceError extends Error {
  constructor(ref: string) {
    super(`Plan template reference '${unwrapTemplateRef(ref)}' was not found.`);
    this.name = "MissingPlanReferenceError";
  }
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
