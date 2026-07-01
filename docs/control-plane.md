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
- Shared memory/artifact model: adapter responses and stream artifact events are normalized into bridge-owned resources and exposed through `/resources`.
- Persistence: `AgentBridge({ persistencePath })` stores session bindings, audit entries, and normalized resources in a JSON state file.
- Observability: `/metrics` exposes call counts, errors, durations, active calls, and limiter queue depth; `/traces/{traceId}` returns audit and resources for one trace.

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

- Multi-agent orchestration: `broadcast` fans out, but core does not yet do agent-to-agent handoff or multi-step plan execution.
- Production observability export: metrics and traces are queryable over HTTP, but OTel/Prometheus exporters are not wired yet.
- Persistence durability: state is written synchronously to a JSON file on every audit record. This is fine for single-node use but needs a real store (and write batching) for production throughput.
