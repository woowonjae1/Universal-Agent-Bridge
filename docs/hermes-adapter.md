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
- `POST /v1/runs/{run_id}/stop`
- `POST /v1/runs/{run_id}/approval`
- `GET /api/sessions`
- `POST /api/sessions`
- `GET /api/sessions/{id}`
- `GET /api/sessions/{id}/messages`
- `POST /api/sessions/{id}/chat`
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

## Method Mapping

| UAB method | Hermes endpoint |
| --- | --- |
| `system.health` | `GET /health` or `GET /health/detailed` |
| `runtime.capabilities` | `GET /v1/capabilities` |
| `models.list` | `GET /v1/models` |
| `chat.completions.create` | `POST /v1/chat/completions` |
| `responses.create` | `POST /v1/responses` |
| `runs.create` | `POST /v1/runs` |
| `sessions.list` | `GET /api/sessions` |
| `sessions.chat` | `POST /api/sessions/{id}/chat` |
| `skills.listInstalled` | `GET /v1/skills` |
| `toolsets.list` | `GET /v1/toolsets` |
| `jobs.list` | `GET /api/jobs` |

Bearer auth is sent as `Authorization: Bearer <UAB_HERMES_TOKEN>`.
