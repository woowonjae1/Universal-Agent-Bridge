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

The adapter sends an initial Gateway `connect` request with operator scopes, then forwards UAB methods as Gateway RPC calls:

```bash
uab call openclaw health "{}"
uab call openclaw status "{}"
uab call openclaw models.list "{\"view\":\"configured\"}"
uab call openclaw tasks.list "{\"limit\":20}"
uab call openclaw gateway.call "{\"method\":\"tools.catalog\",\"params\":{}}"
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

This is slower than Gateway mode but often works earlier in a real local setup because it reuses the user's OpenClaw CLI configuration.

## Method Families

The adapter advertises common OpenClaw Gateway method families:

- `health`, `status`
- `models.list`
- `sessions.list`, `sessions.patch`, `sessions.usage`
- `agent`, `agent.wait`
- `chat.history`, `chat.send`, `chat.abort`
- `tasks.list`, `tasks.get`, `tasks.cancel`
- `tools.catalog`, `tools.effective`, `tools.invoke`
- `skills.status`, `skills.search`
- `commands.list`
- `cron.list`
- `config.get`, `config.patch`
- `channels.status`
- `logs.tail`
- `gateway.call` for raw documented Gateway RPC calls

The raw `gateway.call` method lets the dashboard invoke newly documented OpenClaw RPC methods before UAB adds a first-class convenience entry.
