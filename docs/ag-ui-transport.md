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
  "threadId": "thread_mock",
  "runId": "run_demo",
  "state": {},
  "messages": [],
  "tools": [],
  "context": [],
  "forwardedProps": {
    "uab": {
      "runtime": "mock",
      "method": "sessions.list",
      "params": {}
    }
  }
}
```

The stream emits newline-delimited SSE frames where each `data:` payload is an AG-UI-style event:

```text
data: {"type":"RUN_STARTED","threadId":"thread_mock","runId":"run_demo"}

data: {"type":"STATE_SNAPSHOT","snapshot":{"runtime":"mock","method":"sessions.list","status":"calling"}}

data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg_run_demo","delta":"..."}

data: {"type":"RUN_FINISHED","threadId":"thread_mock","runId":"run_demo"}
```

## Current Mapping

The first implementation wraps any bridge RPC call into a standard event sequence:

1. `RUN_STARTED`
2. `STATE_SNAPSHOT`
3. `CUSTOM` with `uab.request`
4. `STEP_STARTED`
5. `STEP_FINISHED`
6. `CUSTOM` with `uab.response`
7. `TEXT_MESSAGE_START`
8. `TEXT_MESSAGE_CONTENT`
9. `TEXT_MESSAGE_END`
10. `RUN_FINISHED`

Errors emit `RUN_ERROR`.

## Why This Layer Exists

Dashboard, desktop, mobile, and device clients can consume one event stream regardless of the underlying runtime:

- Hermes adapter may call HTTP API Server today and stream Hermes SSE later.
- OpenClaw adapter may call Gateway RPC today and forward Gateway events later.
- Custom runtimes can keep their own transport as long as the adapter maps output into this event stream.

## Smoke Test

```powershell
npm run serve -- --port 8787
```

```powershell
curl.exe -N -X POST http://127.0.0.1:8787/agui/runs `
  -H "content-type: application/json" `
  -H "accept: text/event-stream" `
  -d "{\"threadId\":\"thread_mock\",\"runId\":\"run_demo\",\"state\":{},\"messages\":[],\"tools\":[],\"context\":[],\"forwardedProps\":{\"uab\":{\"runtime\":\"mock\",\"method\":\"sessions.list\",\"params\":{}}}}"
```
