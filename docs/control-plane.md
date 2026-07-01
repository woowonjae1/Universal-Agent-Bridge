# Control Plane Semantics

Universal Agent Bridge is moving from a thin runtime proxy toward an agent control plane. The current core now owns a few cross-runtime concerns instead of leaving every adapter to reinvent them.

## Implemented

- Session binding: `request.session.id` is a first-class protocol field. The first request with `runtime` binds that session to the runtime; later requests can omit `runtime` and keep sticky routing.
- Cancellation: every adapter receives `AdapterCallContext.signal`. Core creates the `AbortController`, `/cancel` aborts by request id, and HTTP disconnects cancel active calls.
- Timeouts: `request.meta.timeoutMs` and `AgentBridge({ defaultTimeoutMs })` abort calls through the same signal path.
- Concurrency gates: `AgentBridge({ maxConcurrentCalls, runtimeConcurrency })` limits global and per-runtime work.
- HTTP backpressure: AG-UI SSE writes wait for `drain` when the client is slow.

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

- Health-aware scheduling: `health()` is still not used for routing, retry, failover, or circuit breaking.
- Capability routing: clients still choose a runtime by id unless they are resuming a bound session.
- Multi-agent orchestration: A2A exists as an adapter layer, but core does not yet do fan-out, handoff, or plan execution.
- Shared memory/artifact model: memory and artifacts are still runtime method families, not normalized bridge-owned resources.
- Persistence: session bindings and audit are still in-memory; production use needs a durable store and queryable audit trail.
- Observability: trace ids exist, but OTel spans, metrics, queue depth, and limiter telemetry are not wired.
