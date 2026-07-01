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
- `@uab/adapter-sdk`: runtime adapter contract and shared capability types.
- `@uab/core`: adapter registry, request router, and scoped access policy.
- `@uab/adapter-mock`: in-memory adapter for demos and tests.
- `@uab/transport-http`: Node.js HTTP transport with `/rpc`, `/health`, and `/runtimes`.
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

Call the mock runtime:

```bash
curl -X POST http://127.0.0.1:8787/rpc ^
  -H "content-type: application/json" ^
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"req_1\",\"runtime\":\"mock\",\"method\":\"sessions.list\",\"params\":{}}"
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
  adapter-sdk/
  core/
  adapter-mock/
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
- Add an OpenClaw adapter based on public SDK boundaries.
- Add an experimental Hermes adapter.
- Add a browser dashboard for runtime discovery, calls, logs, and capability inspection.
- Add token-based auth, pairing flows, and persistent audit logs.

