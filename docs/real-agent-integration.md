# Real Agent Integration

Universal Agent Bridge reaches real agents through adapters. The dashboard, protocol, audit log, method catalog, and transports do not need to know whether the runtime is Mock, OpenClaw, Hermes, or another system.

## Option 1: HTTP JSON-RPC Adapter

Use `@uab/adapter-http-jsonrpc` when an agent can expose a small HTTP surface:

- `GET /health`
- `GET /capabilities`
- `GET /methods`
- `POST /rpc`

Start an example agent:

```bash
npm run example:agent
```

Start the bridge with that external runtime registered:

```bash
$env:UAB_HTTP_RUNTIME_URL="http://127.0.0.1:9000"
$env:UAB_HTTP_RUNTIME_ID="example-agent"
$env:UAB_HTTP_RUNTIME_NAME="Example Agent"
npm run serve -- --port 8787
```

The dashboard will then show both `mock` and `example-agent`.

## Runtime RPC Shape

The bridge sends this to the external agent:

```json
{
  "jsonrpc": "2.0",
  "id": "ui_123",
  "method": "sessions.list",
  "params": {},
  "meta": {
    "traceId": "trace_ui_123",
    "source": "dashboard"
  }
}
```

The agent responds with a JSON-RPC style result:

```json
{
  "jsonrpc": "2.0",
  "id": "ui_123",
  "result": {
    "sessions": []
  }
}
```

## Option 2: Native Adapter

Use a native adapter when the runtime has a local SDK, plugin API, CLI, or process API. Native adapters implement the same `AgentRuntimeAdapter` interface:

```ts
export const adapter = {
  info: { id: "openclaw", name: "OpenClaw" },
  capabilities() {
    return { sessions: { read: true, write: true } };
  },
  methods() {
    return [
      {
        name: "sessions.list",
        capability: "sessions",
        risk: "read",
        paramsExample: {}
      }
    ];
  },
  async call(request, context) {
    return openclaw.sessions.list(request.params);
  }
};
```

OpenClaw and Hermes now have dedicated native adapters:

- `@uab/adapter-hermes` uses Hermes API Server over HTTP.
- `@uab/adapter-openclaw` uses OpenClaw Gateway WebSocket RPC, with an OpenClaw CLI fallback mode.

See:

- [Hermes adapter](./hermes-adapter.md)
- [OpenClaw adapter](./openclaw-adapter.md)
