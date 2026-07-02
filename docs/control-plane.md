# Control Plane Semantics

Universal Agent Bridge is moving from a thin runtime proxy toward an agent control plane. The current core now owns a few cross-runtime concerns instead of leaving every adapter to reinvent them.

## Implemented

- Session binding: `request.session.id` is a first-class protocol field. The first request with `runtime` binds that session to the runtime; later requests can omit `runtime` and keep sticky routing.
- Cancellation: every adapter receives `AdapterCallContext.signal`. Core creates the `AbortController`, `/cancel` aborts by request id, and HTTP disconnects cancel active calls.
- Timeouts: `request.meta.timeoutMs` and `AgentBridge({ defaultTimeoutMs })` abort calls through the same signal path.
- Concurrency gates: `AgentBridge({ maxConcurrentCalls, runtimeConcurrency })` limits global and per-runtime work.
- HTTP backpressure: AG-UI SSE writes wait for `drain` when the client is slow.
- Health-aware scheduling: a per-runtime circuit breaker (`AgentBridge({ circuitBreaker })`) opens after repeated failures and fast-fails while open; `maxAttempts`/`retryBackoffMs` retry transient failures; `listRuntimes`/`listHealth` surface circuit state alongside each adapter's `health()`.
- Capability routing: `request.capability` (instead of `runtime`) dispatches to a healthy runtime advertising the capability, round-robin across candidates, failing over to the next candidate when one is open/unavailable.
- Fan-out orchestration: `bridge.broadcast(capability, request)` dispatches to every runtime advertising the capability and collects each response.
- Plan orchestration: `bridge.runPlan(plan)` still supports wait-for-completion calls, while `bridge.startPlanRun(plan)` creates a durable plan run with `runId`, per-step status, query, cancellation, and resume. Each step can target a runtime, route by capability, hand off to the previous/named step's runtime, reference previous step outputs in `params` with `${steps.stepId.result.field}`, skip itself with a declarative `when`, or run as part of a DAG with `dependsOn`.
- Shared memory/artifact model: adapter responses and stream artifact events are normalized into bridge-owned resources. Core supports `get/create/update/delete`, and HTTP exposes `POST /resources`, `GET /resources/{id}`, `PATCH /resources/{id}`, and `DELETE /resources/{id}`.
- Persistence: `AgentBridge({ persistencePath })` stores session bindings, audit entries, normalized resources, and plan-run state in a JSON state file. Writes are batched with `persistenceFlushMs`, then flushed through an atomic temp-file rename.
- Observability: `/metrics` exposes call counts, errors, durations, active calls, and limiter queue depth; `/traces/{traceId}` returns audit and resources for one trace. `AgentBridge({ spanExporter })` emits dependency-free span objects that can be bridged into OTel or another telemetry sink.
- HTTP control endpoints: `/health/runtimes`, `/broadcast`, `/plans`, `/plans/run`, `/plans/{runId}`, `/plans/{runId}/cancel`, `/plans/{runId}/resume`, and resource CRUD endpoints expose the scheduling/orchestration/resource layer to clients.

## Protocol Example

```json
{
  "jsonrpc": "2.0",
  "id": "run_1",
  "runtime": "openclaw",
  "session": {
    "id": "project-main",
    "action": "create",
    "metadata": {
      "workspace": "D:/code/Universal-Agent-Bridge"
    }
  },
  "method": "chat.stream",
  "params": {
    "text": "Summarize this project"
  },
  "meta": {
    "timeoutMs": 120000
  }
}
```

Resume the same session without specifying a runtime:

```json
{
  "jsonrpc": "2.0",
  "id": "run_2",
  "session": {
    "id": "project-main",
    "action": "resume"
  },
  "method": "chat.stream",
  "params": {
    "text": "Continue"
  }
}
```

## Plan Example

```json
{
  "id": "review_pipeline",
  "mode": "dag",
  "timeoutMs": 120000,
  "steps": [
    {
      "id": "extract",
      "runtime": "openclaw",
      "method": "chat.send",
      "params": {
        "text": "Extract the actionable items from this workspace"
      }
    },
    {
      "id": "score",
      "dependsOn": "extract",
      "capability": "chat",
      "method": "chat.send",
      "params": {
        "text": "Score these items: ${steps.extract.result.items}"
      }
    },
    {
      "id": "summarize",
      "dependsOn": "extract",
      "capability": "chat",
      "method": "chat.send",
      "params": {
        "text": "Summarize these items: ${steps.extract.result.items}"
      }
    },
    {
      "id": "handoff",
      "dependsOn": [
        "score",
        "summarize"
      ],
      "handoff": {
        "fromStep": "summarize"
      },
      "method": "chat.send",
      "when": {
        "ref": "steps.score.result.approved",
        "equals": true
      },
      "params": {
        "text": "Continue with the approved summary: ${steps.summarize.result.text}"
      }
    }
  ]
}
```

Template references that fill a whole string preserve the referenced JSON type. For example, `"${steps.extract.result.items}"` passes an array/object through as JSON; embedded references such as `"items=${steps.extract.result.count}"` render as strings. If a reference cannot be resolved, the step fails with an invalid-request error instead of silently passing `null`.

Use `POST /plans` for asynchronous execution:

```json
{
  "run": {
    "id": "review_pipeline",
    "status": "pending",
    "steps": [
      {
        "stepId": "extract",
        "status": "pending"
      }
    ]
  }
}
```

Clients can poll `GET /plans/{runId}`, list recent runs with `GET /plans?limit=50`, cancel an active run with `POST /plans/{runId}/cancel`, and resume a failed or cancelled run with `POST /plans/{runId}/resume`. `POST /plans/run` remains available for callers that want a synchronous compatibility response.

`dependsOn` is the primary concurrency model. In `mode: "dag"`, steps with no dependencies become ready immediately and run concurrently; dependent steps wait until all listed upstream steps reach a terminal status. Without `mode: "dag"` or explicit `dependsOn`, the bridge preserves the older sequence behavior, including adjacent `parallelGroup` compatibility.

## Remaining Gaps

- Workflow depth: plan runs now cover dataflow, conditional skips, DAG scheduling, cancellation, timeout, persistence, and resume. Loops, compensation/rollback, and policy-driven planner selection are still future work.
- Production observability export: spans can be exported through the no-dependency hook, but packaged OTel/Prometheus exporters are not included yet.
- Persistence durability: the JSON store is batched and atomic enough for local/single-node use. A real database or append log is still needed for production-scale multi-node deployments.
