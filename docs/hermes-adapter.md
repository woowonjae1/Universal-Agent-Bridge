# Hermes Adapter

`@uab/adapter-hermes` connects Universal Agent Bridge to the Hermes Agent API Server.

The adapter uses the public API Server surface documented by Hermes:

- `GET /health`
- `GET /health/detailed`
- `GET /v1/capabilities`
- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/responses/{id}`
- `POST /v1/runs`
- `GET /v1/runs/{run_id}`
- `GET /v1/runs/{run_id}/events`
- `POST /v1/runs/{run_id}/stop`
- `POST /v1/runs/{run_id}/approval`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/{id}`
- `GET /api/sessions/{id}/messages`
- `POST /api/sessions/{id}/chat`
- `POST /api/sessions/{id}/chat/stream`
- `GET /api/artifacts`
- `GET /api/artifacts/{artifact_id}`
- `GET /api/tool-calls`
- `GET /api/tool-calls/{tool_call_id}`
- `GET /v1/skills`
- `GET /v1/toolsets`
- `GET /api/jobs`

## Start Hermes

In `~/.hermes/.env`:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=change-me-local-dev
```

Then start Hermes:

```bash
hermes gateway
```

Hermes normally listens on `http://127.0.0.1:8642`.

## Register with UAB

```powershell
$env:UAB_HERMES_URL="http://127.0.0.1:8642"
$env:UAB_HERMES_TOKEN="change-me-local-dev"
$env:UAB_HERMES_RUNTIME_ID="hermes"
npm run serve -- --port 8787
```

The dashboard and CLI can then call:

```bash
uab call hermes system.health "{}"
uab call hermes models.list "{}"
uab call hermes sessions.list "{\"limit\":10}"
uab call hermes chat.completions.create "{\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}"
```

Stream a real Hermes session turn through AG-UI:

```powershell
curl.exe -N -X POST http://127.0.0.1:8787/agui/runs `
  -H "content-type: application/json" `
  -H "accept: text/event-stream" `
  -d "{\"threadId\":\"thread_hermes\",\"runId\":\"run_hermes_stream\",\"state\":{},\"messages\":[],\"tools\":[],\"context\":[],\"forwardedProps\":{\"uab\":{\"runtime\":\"hermes\",\"method\":\"sessions.chat.stream\",\"params\":{\"id\":\"session_id\",\"input\":\"What changed?\"}}}}"
```

## Method Mapping

| UAB method | Hermes endpoint |
| --- | --- |
| `system.health` | `GET /health` or `GET /health/detailed` |
| `runtime.capabilities` | `GET /v1/capabilities` |
| `models.list` | `GET /v1/models` |
| `chat.completions.create` | `POST /v1/chat/completions` |
| `responses.create` | `POST /v1/responses` |
| `runs.create` | `POST /v1/runs` |
| `runs.events` | `GET /v1/runs/{run_id}/events` |
| `sessions.list` | `GET /api/sessions` |
| `sessions.chat` | `POST /api/sessions/{id}/chat` |
| `sessions.chat.stream` | `POST /api/sessions/{id}/chat/stream` |
| `artifacts.list` | `GET /api/artifacts` |
| `artifacts.get` | `GET /api/artifacts/{artifact_id}` |
| `toolcalls.list` | `GET /api/tool-calls` |
| `toolcalls.get` | `GET /api/tool-calls/{tool_call_id}` |
| `skills.listInstalled` | `GET /v1/skills` |
| `toolsets.list` | `GET /v1/toolsets` |
| `jobs.list` | `GET /api/jobs` |

Bearer auth is sent as `Authorization: Bearer <UAB_HERMES_TOKEN>`.

## Authentication Notes

Hermes API Server does not use the OpenClaw Gateway device-pairing handshake. There is no `openclaw devices approve` equivalent for Hermes in UAB. If Hermes returns `401` or `403`, fix the API Server key or URL:

```bash
API_SERVER_ENABLED=true
API_SERVER_KEY=change-me-local-dev
```

```powershell
$env:UAB_HERMES_URL="http://127.0.0.1:8642"
$env:UAB_HERMES_TOKEN="change-me-local-dev"
```

## Streaming

Hermes SSE messages are normalized into UAB stream events:

- text deltas become AG-UI `TEXT_MESSAGE_CONTENT`
- tool events become AG-UI `CUSTOM` with `tool.call`
- artifact events become AG-UI `CUSTOM` with `artifact`
- A2UI payloads become AG-UI `CUSTOM` with `a2ui.envelope`
- final events close the AG-UI run with `RUN_FINISHED`
