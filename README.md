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
- `@uab/ag-ui`: AG-UI event mapping for frontend and app clients.
- `@uab/adapter-sdk`: runtime adapter contract and shared capability types.
- `@uab/core`: adapter registry, request router, and scoped access policy.
- `@uab/adapter-mock`: in-memory adapter for demos and tests.
- `@uab/adapter-http-jsonrpc`: generic adapter for real agents that expose HTTP JSON-RPC.
- `@uab/adapter-hermes`: Hermes Agent API Server adapter.
- `@uab/adapter-openclaw`: OpenClaw Gateway adapter with CLI fallback.
- `@uab/transport-http`: Node.js HTTP transport with `/rpc`, `/agui/runs`, `/health`, and `/runtimes`.
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

## Request Shape

```json
{
  "jsonrpc": "2.0",
  "id": "req_001",
  "runtime": "mock",
  "method": "sessions.list",
  "params": {}
}
```

## Repository Layout

```text
packages/
  protocol/
  ag-ui/
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
- Expand OpenClaw and Hermes adapters with native streaming event support.
- Add MCP tool registry and tool-call routing.
- Add A2A agent discovery and task routing.
- Add A2UI-style dynamic UI payload rendering.
- Add adapter conformance tests for more real-agent method families.
- Add token-based auth, pairing flows, and persistent audit logs.
