# Universal Agent Bridge

Transport-agnostic control plane for managing multiple AI agent runtimes through one unified RPC protocol.

Different agent runtimes (OpenClaw, Hermes, A2A agents, MCP tool servers, any HTTP JSON-RPC agent) expose different APIs for sessions, models, memory, artifacts, and system controls. Universal Agent Bridge puts a small, stable core in front of them: clients speak one protocol, and each runtime keeps its own implementation behind an adapter. Instead of every client wiring to every runtime (N x M), everyone meets at the bridge (N+M).

## Positioning

This is multi-agent **infrastructure**: the routing and orchestration layer that connects and coordinates agent runtimes. It is deliberately *not* a multi-agent system (MAS) in itself: the agents live behind adapters; the bridge unifies and governs them. As Kubernetes is not a microservice but the platform that runs many, this is not an agent but the control plane that orchestrates many.

```text
        Client / Dashboard / CLI
                   |
             HTTP transport
                   |
        +----------------------+
        | Universal Agent      |  sessions | routing | health | limits
        | Bridge Core          |  audit | resources | persistence | metrics
        +----------------------+
                   |
             Adapter Registry
                   |
        OpenClaw | Hermes | A2A agents | MCP | HTTP JSON-RPC
```

## How It Works

- **Runtimes & adapters.** Every backend is an adapter implementing one contract (`capabilities`, `call`, optional `stream`, `health`, lifecycle). Registering an adapter is all it takes to expose a runtime; the core never changes.
- **Protocol.** One JSON-RPC-style envelope (`runtime`/`capability`, `method`, `params`, `session`, `meta`) with a shared response and error-code shape. Requests arrive over a transport (HTTP today) and are validated before routing.
- **Routing & sessions.** A request targets a runtime by id, by `capability`, or by a sticky `session`: the first call binds a session to a runtime, later calls reuse it without re-specifying the runtime.
- **Orchestration.** On top of single calls the bridge can select a runtime by capability, fan out to all runtimes with a capability (`broadcast`), and run persistent multi-step plan runs with DAG `dependsOn`, handoff, conditional skips, dataflow between steps, plan-level cancellation, timeout, and resume.
- **Governance.** Per-runtime circuit breaking with retries and failover, global and per-runtime concurrency limits, cancellation and timeouts, an audit log, a normalized memory/artifact resource index, batched atomic persistence, and metrics/tracing with a dependency-free span-exporter hook apply to every call and orchestration step.

## Packages

| Package | Responsibility |
| --- | --- |
| `@uab/protocol` | Bridge envelope, responses, error codes, validation |
| `@uab/core` | Adapter registry, router, sessions, health scheduling, orchestration, resources, persistence, observability |
| `@uab/adapter-sdk` | Runtime adapter contract and shared capability types |
| `@uab/transport-http` | Node.js HTTP transport and endpoints |
| `@uab/adapter-openclaw` | OpenClaw Gateway adapter with CLI fallback |
| `@uab/adapter-hermes` | Hermes Agent API Server adapter |
| `@uab/adapter-http-jsonrpc` | Generic adapter for HTTP JSON-RPC agents |
| `@uab/a2a` | A2A remote-agent registry and JSON-RPC client |
| `@uab/mcp` | MCP server registry and tool invocation |
| `@uab/ag-ui` | AG-UI event mapping for frontend/app clients |
| `@uab/a2ui` | A2UI dynamic-UI envelope validation and sanitization |
| `@uab/cli` | HTTP server and one-shot call commands |

## Quick Start

```bash
npm install
npm run build
npm test
```

Start the HTTP bridge with at least one runtime configured, then optionally the dashboard:

```bash
npm run serve -- --port 8787
npm run dashboard   # http://127.0.0.1:5173, API set to http://127.0.0.1:8787
```

Configure runtimes with environment variables before `npm run serve`:

| Runtime | Environment variables |
| --- | --- |
| HTTP JSON-RPC agent | `UAB_HTTP_RUNTIME_URL`, `UAB_HTTP_RUNTIME_ID` |
| Hermes | `UAB_HERMES_URL`, `UAB_HERMES_TOKEN` |
| OpenClaw Gateway | `UAB_OPENCLAW_GATEWAY_URL`, `UAB_OPENCLAW_TOKEN` or `UAB_OPENCLAW_MODE=cli` |
| MCP tool server | `UAB_MCP_SERVER_ID`, `UAB_MCP_SERVER_COMMAND`, `UAB_MCP_SERVER_ARGS` |
| A2A agent | `UAB_A2A_AGENT_ID`, `UAB_A2A_AGENT_URL` |

Make a call through the bridge:

```bash
curl -X POST http://127.0.0.1:8787/rpc \
  -H "content-type: application/json" \
  -d '{"jsonrpc":"2.0","id":"req_1","runtime":"openclaw","method":"status","params":{}}'
```

The same call can be streamed as AG-UI SSE via `/agui/runs`. Per-runtime connection and method details live in [docs/](docs/).

## Request Shape

```json
{
  "jsonrpc": "2.0",
  "id": "req_001",
  "runtime": "openclaw",
  "session": { "id": "project-main", "action": "create" },
  "method": "sessions.list",
  "params": {},
  "meta": { "timeoutMs": 30000 }
}
```

The first request for a session binds it to the chosen runtime; later requests can send only the same `session.id`. Replace `runtime` with `capability` to let the bridge pick a healthy runtime. Cancel an in-flight call with `POST /cancel` `{ "requestId": "req_001" }`.

## Orchestration

Start a durable multi-step plan run with `POST /plans`, or use `POST /plans/run` when the caller wants to wait for completion. Each step targets a `runtime`, routes by `capability`, or hands off to a previous step's runtime. `dependsOn` builds a DAG: independent steps run concurrently, downstream steps wait for dependencies, `when` can skip a step, and `params`/`method`/`session`/`meta` can template earlier step results. Missing template references fail the step explicitly.

```json
{
  "id": "research_pipeline",
  "mode": "dag",
  "timeoutMs": 120000,
  "stopOnError": true,
  "steps": [
    {
      "id": "extract",
      "capability": "chat",
      "method": "chat.send",
      "params": {
        "sessionKey": "default",
        "message": "Extract the key facts"
      }
    },
    {
      "id": "review",
      "dependsOn": "extract",
      "handoff": {
        "fromStep": "extract"
      },
      "method": "chat.send",
      "params": {
        "sessionKey": "default",
        "message": "Double-check the extraction: ${steps.extract.result}"
      }
    }
  ]
}
```

Query plan runs with `GET /plans` and `GET /plans/{runId}`. Stop or resume them with `POST /plans/{runId}/cancel` and `POST /plans/{runId}/resume`. `POST /broadcast` fans one request out to every runtime advertising a capability. The plan schema, template reference syntax, and condition grammar are in [docs/control-plane.md](docs/control-plane.md).

## HTTP Endpoints

`/rpc` | `/agui/runs` | `/cancel` | `/sessions` | `/runtimes` | `/methods` | `/health` | `/health/runtimes` | `/metrics` | `/traces/{traceId}` | `/resources` (+ `/resources/{id}` CRUD) | `/broadcast` | `/plans` | `/plans/run` | `/plans/{runId}` | `/plans/{runId}/cancel` | `/plans/{runId}/resume` | `/audit`

## Documentation

- [architecture.md](docs/architecture.md) - core design and data flow
- [control-plane.md](docs/control-plane.md) - sessions, health scheduling, orchestration, resources, persistence
- [protocol.md](docs/protocol.md) - envelope and error codes
- [adapter-guide.md](docs/adapter-guide.md) - writing a runtime adapter
- [security.md](docs/security.md) - access policy and scopes

## Roadmap

- Add MQTT and WebSocket transports.
- Deepen orchestration: step compensation/rollback (saga), guarded retries/loops, and a dynamic planner that chooses steps from prior results.
- Ship packaged OpenTelemetry/Prometheus exporters on top of the span-exporter hook.
- Expand adapter method coverage and conformance tests; add token-based auth and pairing flows.
