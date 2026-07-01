# Universal Agent Bridge

Transport-agnostic control plane for managing multiple AI agent runtimes through a unified RPC protocol.

Universal Agent Bridge is designed around a small core and runtime adapters. OpenClaw, Hermes, and future agent systems plug into the same routing, transport, permission, and observability model instead of each transport speaking to each runtime directly.

## Why This Exists

Agent runtimes expose different APIs for sessions, models, memory, artifacts, skills, scheduled tasks, and system controls. This project provides a stable bridge layer so clients can manage those runtimes through one protocol while each runtime keeps its own implementation behind an adapter.

```text
Client / Dashboard / CLI
        |
HTTP / WebSocket / MQTT / stdio
        |
Universal Agent Bridge Core
        |
Adapter Registry
        |
OpenClaw Adapter | Hermes Adapter | Mock Adapter | Custom Adapter
```

## Current Status

This repository starts with a working v0.1 foundation:

- `@uab/protocol`: JSON-RPC style bridge envelope, responses, and error codes.
- `@uab/a2ui`: A2UI dynamic UI envelope validation and sanitization.
- `@uab/ag-ui`: AG-UI event mapping for frontend and app clients.
- `@uab/mcp`: MCP server registry and tool invocation layer.
- `@uab/a2a`: A2A remote agent registry and JSON-RPC client layer.
- `@uab/adapter-sdk`: runtime adapter contract and shared capability types.
- `@uab/core`: adapter registry, session-aware request router, scoped access policy, cancellation, timeouts, and concurrency limits.
- `@uab/adapter-mock`: in-memory adapter for demos and tests.
- `@uab/adapter-http-jsonrpc`: generic adapter for real agents that expose HTTP JSON-RPC.
- `@uab/adapter-hermes`: Hermes Agent API Server adapter.
- `@uab/adapter-openclaw`: OpenClaw Gateway adapter with CLI fallback.
- `@uab/transport-http`: Node.js HTTP transport with `/rpc`, `/agui/runs`, `/cancel`, `/sessions`, `/health`, and `/runtimes`.
- `@uab/cli`: local demo, HTTP server, and one-shot call commands.

## Quick Start

```bash
npm install
npm run build
npm test
```

Run the mock runtime demo:

```bash
npm run demo
```

Start the HTTP bridge:

```bash
npm run serve -- --port 8787
```

Start the dashboard UI in a second terminal:

```bash
npm run dashboard
```

Open `http://127.0.0.1:5173` and keep the API endpoint set to `http://127.0.0.1:8787`.

Connect an external HTTP agent:

```bash
npm run example:agent
$env:UAB_HTTP_RUNTIME_URL="http://127.0.0.1:9000"
$env:UAB_HTTP_RUNTIME_ID="example-agent"
npm run serve -- --port 8787
```

Connect Hermes:

```bash
$env:UAB_HERMES_URL="http://127.0.0.1:8642"
$env:UAB_HERMES_TOKEN="change-me-local-dev"
npm run serve -- --port 8787
```

Connect OpenClaw Gateway:

```bash
$env:UAB_OPENCLAW_GATEWAY_URL="ws://127.0.0.1:18789"
$env:UAB_OPENCLAW_TOKEN="your-gateway-token"
npm run serve -- --port 8787
```

If OpenClaw device pairing is already handled by the local CLI, use fallback mode:

```bash
$env:UAB_OPENCLAW_MODE="cli"
npm run serve -- --port 8787
```

Call the mock runtime:

```bash
curl -X POST http://127.0.0.1:8787/rpc ^
  -H "content-type: application/json" ^
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"req_1\",\"runtime\":\"mock\",\"method\":\"sessions.list\",\"params\":{}}"
```

Stream the same call through AG-UI SSE:

```bash
curl -N -X POST http://127.0.0.1:8787/agui/runs ^
  -H "content-type: application/json" ^
  -H "accept: text/event-stream" ^
  -d "{\"threadId\":\"thread_mock\",\"runId\":\"run_demo\",\"state\":{},\"messages\":[],\"tools\":[],\"context\":[],\"forwardedProps\":{\"uab\":{\"runtime\":\"mock\",\"method\":\"sessions.list\",\"params\":{}}}}"
```

Render a dynamic A2UI surface through AG-UI:

```bash
curl -N -X POST http://127.0.0.1:8787/agui/runs ^
  -H "content-type: application/json" ^
  -H "accept: text/event-stream" ^
  -d "{\"threadId\":\"thread_mock\",\"runId\":\"run_a2ui\",\"state\":{},\"messages\":[],\"tools\":[],\"context\":[],\"forwardedProps\":{\"uab\":{\"runtime\":\"mock\",\"method\":\"ui.surface.demo\",\"params\":{\"title\":\"Agent handoff\",\"status\":\"ready\"}}}}"
```

Register an MCP stdio tool server:

```bash
$env:UAB_MCP_SERVER_ID="example"
$env:UAB_MCP_SERVER_COMMAND="node"
$env:UAB_MCP_SERVER_ARGS="examples/mcp-stdio-server/server.mjs"
npm run serve -- --port 8787
```

Call an MCP tool through the bridge:

```bash
curl -X POST http://127.0.0.1:8787/rpc ^
  -H "content-type: application/json" ^
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"mcp_call\",\"runtime\":\"mcp\",\"method\":\"mcp.tools.call\",\"params\":{\"serverId\":\"example\",\"name\":\"echo\",\"arguments\":{\"text\":\"hello\"}}}"
```

Register an A2A agent:

```bash
npm run example:a2a -- --port 9010
$env:UAB_A2A_AGENT_ID="example"
$env:UAB_A2A_AGENT_URL="http://127.0.0.1:9010"
npm run serve -- --port 8787
```

Send a message through A2A:

```bash
curl -X POST http://127.0.0.1:8787/rpc ^
  -H "content-type: application/json" ^
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"a2a_send\",\"runtime\":\"a2a\",\"method\":\"a2a.message.send\",\"params\":{\"agentId\":\"example\",\"text\":\"hello\"}}"
```

## Request Shape

```json
{
  "jsonrpc": "2.0",
  "id": "req_001",
  "runtime": "mock",
  "session": {
    "id": "project-main",
    "action": "create"
  },
  "method": "sessions.list",
  "params": {},
  "meta": {
    "timeoutMs": 30000
  }
}
```

The first request for a session binds it to the selected runtime. Later requests can provide only the same `session.id`; the bridge resolves the runtime from its sticky session table.

Cancel an active call:

```bash
curl -X POST http://127.0.0.1:8787/cancel ^
  -H "content-type: application/json" ^
  -d "{\"requestId\":\"req_001\"}"
```

## Repository Layout

```text
packages/
  protocol/
  a2ui/
  ag-ui/
  mcp/
  a2a/
  adapter-sdk/
  core/
  adapter-mock/
  adapter-hermes/
  adapter-openclaw/
  transport-http/
  cli/
docs/
  architecture.md
  adapter-guide.md
  protocol.md
  security.md
```

## Roadmap

- Add MQTT transport as the first remote-first transport.
- Expand OpenClaw and Hermes adapters with more native method coverage and conformance tests.
- Expand MCP support with resources, prompts, roots, and sampling.
- Expose UAB itself as an A2A server with an Agent Card.
- Expand A2UI dynamic UI with form submission, richer layouts, and chart primitives.
- Add adapter conformance tests for more real-agent method families.
- Add token-based auth, pairing flows, and persistent audit logs.
