# AG-UI Transport

Universal Agent Bridge exposes an AG-UI-compatible Server-Sent Events endpoint for frontend, desktop, and app clients.

This is the second layer in the project roadmap:

```text
Adapter real integrations -> AG-UI event outlet -> MCP tool layer -> A2A agent layer -> A2UI dynamic UI
```

## Endpoint

```http
POST /agui/runs
Accept: text/event-stream
Content-Type: application/json
```

The endpoint accepts an AG-UI-style run input. UAB-specific routing lives under `forwardedProps.uab`:

```json
{
  "threadId": "thread_openclaw",
  "runId": "run_status",
  "state": {},
  "messages": [],
  "tools": [],
  "context": [],
  "forwardedProps": {
    "uab": {
      "runtime": "openclaw",
      "method": "status",
      "params": {}
    }
  }
}
```

The stream emits newline-delimited SSE frames where each `data:` payload is an AG-UI-style event:

```text
data: {"type":"RUN_STARTED","threadId":"thread_openclaw","runId":"run_status"}

data: {"type":"STATE_SNAPSHOT","snapshot":{"runtime":"openclaw","method":"status","status":"calling"}}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg_run_status","delta":"..."}

data: {"type":"RUN_FINISHED","threadId":"thread_openclaw","runId":"run_status"}
```

## Current Mapping

The first implementation wraps any bridge RPC call into a standard event sequence:

1. `RUN_STARTED`
2. `STATE_SNAPSHOT`
3. `CUSTOM` with `uab.request`
4. `STEP_STARTED`
5. `STEP_FINISHED`
6. `CUSTOM` with `uab.response`
7. optional `CUSTOM` with `a2ui.envelope` when the bridge result contains an A2UI envelope
8. `TEXT_MESSAGE_START`
9. `TEXT_MESSAGE_CONTENT`
10. `TEXT_MESSAGE_END`
11. `RUN_FINISHED`

Errors emit `RUN_ERROR`.

## A2UI Payloads

If an adapter result contains `a2ui` or `ui`, UAB validates the envelope through `@uab/a2ui` and emits it as:

```json
{
  "type": "CUSTOM",
  "name": "a2ui.envelope",
  "value": {
    "version": "1.0",
    "type": "createSurface",
    "surfaceId": "agent-review",
    "components": []
  }
}
```

Clients should render this as declarative data. They should not execute code, inline scripts, or arbitrary HTML from agent output.

## Why This Layer Exists

Dashboard, desktop, mobile, and device clients can consume one event stream regardless of the underlying runtime:

- Hermes adapter may call HTTP API Server today and stream Hermes SSE later.
- OpenClaw adapter may call Gateway RPC today and forward Gateway events later.
- Custom runtimes can keep their own transport as long as the adapter maps output into this event stream.

## Smoke Test

Configure a real runtime before sending the stream request. For example, for OpenClaw CLI fallback:

```powershell
$env:UAB_OPENCLAW_MODE="cli"
npm run serve -- --port 8787
```

```powershell
curl.exe -N -X POST http://127.0.0.1:8787/agui/runs `
  -H "content-type: application/json" `
  -H "accept: text/event-stream" `
  -d "{\"threadId\":\"thread_openclaw\",\"runId\":\"run_status\",\"state\":{},\"messages\":[],\"tools\":[],\"context\":[],\"forwardedProps\":{\"uab\":{\"runtime\":\"openclaw\",\"method\":\"status\",\"params\":{}}}}"
```
