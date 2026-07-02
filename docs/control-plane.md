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
- Multi-step handoff: `bridge.runPlan(plan)` executes ordered steps. Each step can target a runtime, route by capability, or hand off to the previous/named step's runtime.
- Shared memory/artifact model: adapter responses and stream artifact events are normalized into bridge-owned resources. Core supports `get/create/update/delete`, and HTTP exposes `POST /resources`, `GET /resources/{id}`, `PATCH /resources/{id}`, and `DELETE /resources/{id}`.
- Persistence: `AgentBridge({ persistencePath })` stores session bindings, audit entries, and normalized resources in a JSON state file. Writes are batched with `persistenceFlushMs`, then flushed through an atomic temp-file rename.
- Observability: `/metrics` exposes call counts, errors, durations, active calls, and limiter queue depth; `/traces/{traceId}` returns audit and resources for one trace. `AgentBridge({ spanExporter })` emits dependency-free span objects that can be bridged into OTel or another telemetry sink.
- HTTP control endpoints: `/health/runtimes`, `/broadcast`, `/plans/run`, and resource CRUD endpoints expose the scheduling/orchestration/resource layer to clients.

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

## Remaining Gaps

- Workflow depth: `runPlan` is sequential handoff orchestration. Branching, parallel sub-plans, compensation, and policy-driven planner selection are still future work.
- Production observability export: spans can be exported through the no-dependency hook, but packaged OTel/Prometheus exporters are not included yet.
- Persistence durability: the JSON store is batched and atomic enough for local/single-node use. A real database or append log is still needed for production-scale multi-node deployments.
