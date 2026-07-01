# OpenClaw Adapter

`@uab/adapter-openclaw` connects Universal Agent Bridge to OpenClaw.

For external tools, OpenClaw recommends the Gateway WebSocket protocol rather than importing Plugin SDK internals. This adapter follows that boundary and exposes Gateway RPC methods through the same UAB request envelope used by Hermes, mock runtimes, and custom agents.

## Gateway Mode

Start or discover an OpenClaw Gateway. The default local Control UI and Gateway port is commonly `18789`.

```powershell
$env:UAB_OPENCLAW_GATEWAY_URL="ws://127.0.0.1:18789"
$env:UAB_OPENCLAW_TOKEN="your-gateway-token"
$env:UAB_OPENCLAW_RUNTIME_ID="openclaw"
npm run serve -- --port 8787
```

### Device Pairing

OpenClaw Gateway may require a paired device identity in addition to the shared token/password. UAB Gateway mode now supports that flow:

- If `UAB_OPENCLAW_DEVICE_PRIVATE_KEY_PEM` or `UAB_OPENCLAW_DEVICE_PRIVATE_KEY_PATH` is set, UAB signs the Gateway `connect.challenge` with that Ed25519 device key.
- If neither is set, `uab serve` automatically tries to reuse the local OpenClaw CLI identity at `~/.openclaw/identity/device.json`.
- If `UAB_OPENCLAW_DEVICE_TOKEN` is not set, UAB also tries to reuse `~/.openclaw/identity/device-auth.json`.

First run against a new Gateway may return `PAIRING_REQUIRED`. Approve the pending request, then retry:

```powershell
openclaw devices approve --latest
# verify the printed request, then run the exact command it shows:
openclaw devices approve <requestId>
openclaw gateway restart
```

Useful overrides:

```powershell
$env:UAB_OPENCLAW_DEVICE_IDENTITY_PATH="$env:USERPROFILE\.openclaw\identity\device.json"
$env:UAB_OPENCLAW_DEVICE_AUTH_PATH="$env:USERPROFILE\.openclaw\identity\device-auth.json"
$env:UAB_OPENCLAW_DEVICE_TOKEN="device-token-from-rotation"
$env:UAB_OPENCLAW_SCOPES="operator.read,operator.write"
```

`UAB_OPENCLAW_DEVICE_PRIVATE_KEY_PATH` can point to a raw PEM private key file or to an OpenClaw `device.json` file containing `privateKeyPem`.

For a portable UAB deployment, prefer a dedicated persistent device key and approve that device once. Set `UAB_OPENCLAW_AUTO_DEVICE_IDENTITY=0` or `UAB_OPENCLAW_AUTO_DEVICE_AUTH=0` to stop reading the local OpenClaw state directory.

The adapter sends an initial Gateway `connect` request with operator scopes, then forwards UAB methods as Gateway RPC calls:

```bash
uab call openclaw health "{}"
uab call openclaw status "{}"
uab call openclaw models.list "{\"view\":\"configured\"}"
uab call openclaw tasks.list "{\"limit\":20}"
uab call openclaw gateway.call "{\"method\":\"tools.catalog\",\"params\":{}}"
```

Stream a real OpenClaw chat turn through AG-UI:

```powershell
curl.exe -N -X POST http://127.0.0.1:8787/agui/runs `
  -H "content-type: application/json" `
  -H "accept: text/event-stream" `
  -d "{\"threadId\":\"thread_openclaw\",\"runId\":\"run_openclaw_stream\",\"state\":{},\"messages\":[],\"tools\":[],\"context\":[],\"forwardedProps\":{\"uab\":{\"runtime\":\"openclaw\",\"method\":\"chat.stream\",\"params\":{\"sessionKey\":\"project-main\",\"text\":\"What changed?\"}}}}"
```

Set scopes explicitly when needed:

```powershell
$env:UAB_OPENCLAW_SCOPES="operator.read,operator.write,operator.approvals"
```

Admin methods such as `config.patch` need admin-capable OpenClaw credentials and scopes.

## CLI Fallback

Some OpenClaw environments require device pairing, signed device identity, or local credential state that the CLI already manages. For that case, use CLI mode:

```powershell
$env:UAB_OPENCLAW_MODE="cli"
npm run serve -- --port 8787
```

CLI mode shells out to:

```bash
openclaw gateway call <method> --params <json> --json
```

For local control-plane methods, CLI mode uses native OpenClaw commands before falling back to `gateway call`:

| UAB method | CLI command |
| --- | --- |
| `sessions.list` | `openclaw sessions list --json` |
| `models.list` | `openclaw models status --json` by default; `openclaw models list --json` when `catalog`, `all`, `provider`, or `local` is set |
| `tasks.list` | `openclaw tasks list --json` |
| `tasks.get` | `openclaw tasks show <lookup> --json` |
| `tasks.cancel` | `openclaw tasks cancel <lookup> --json` |
| `channels.status` | `openclaw channels status --json` |
| `skills.status` | `openclaw skills list --json` |
| `skills.search` | `openclaw skills search <query> --json` |
| `cron.list` | `openclaw cron list --json` |
| `config.get` | `openclaw config get <path> --json` |
| `exec.approval.list` | `openclaw approvals get --json` |
| `logs.tail` | `openclaw logs --json` |

This is slower than Gateway mode but often works earlier in a real local setup because it reuses the user's OpenClaw CLI configuration and paired device identity.

## Method Families

The adapter advertises common OpenClaw Gateway method families:

- `health`, `status`
- `models.list`
- `sessions.list`, `sessions.patch`, `sessions.usage`
- `agent`, `agent.wait`
- `agent.stream`
- `chat.history`, `chat.send`, `chat.stream`, `chat.abort`
- `tasks.list`, `tasks.get`, `tasks.cancel`
- `tools.catalog`, `tools.effective`, `tools.invoke`
- `artifacts.list`, `artifacts.get`, `artifacts.delete`
- `exec.approval.list`, `exec.approval.resolve`
- `skills.status`, `skills.search`
- `commands.list`
- `cron.list`
- `config.get`, `config.patch`
- `channels.status`
- `logs.tail`
- `gateway.call` for raw documented Gateway RPC calls

The raw `gateway.call` method lets the dashboard invoke newly documented OpenClaw RPC methods before UAB adds a first-class convenience entry.

## Streaming

OpenClaw Gateway `event` frames are normalized into UAB stream events:

- message deltas become AG-UI `TEXT_MESSAGE_CONTENT`
- tool events become AG-UI `CUSTOM` with `tool.call`
- artifact events become AG-UI `CUSTOM` with `artifact`
- approval events become AG-UI `CUSTOM` with `approval`
- A2UI payloads become AG-UI `CUSTOM` with `a2ui.envelope`

CLI fallback still supports one-shot calls, but live event streaming requires Gateway mode.
