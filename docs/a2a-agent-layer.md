# A2A Agent Layer

Universal Agent Bridge can register remote A2A agents as a runtime named `a2a`.

This is the fourth layer in the roadmap:

```text
Adapter real integrations -> AG-UI event outlet -> MCP tool layer -> A2A agent layer -> A2UI dynamic UI
```

## What It Does

`@uab/a2a` implements a client-side A2A registry:

- Fetches Agent Cards from `/.well-known/agent-card.json`
- Selects JSON-RPC endpoint from `supportedInterfaces[].url` or card `url`
- Calls A2A JSON-RPC methods
- Supports basic SSE JSON-RPC response parsing

UAB exposes these methods:

- `a2a.agents.list`
- `a2a.agent.card`
- `a2a.message.send`
- `a2a.task.get`
- `a2a.tasks.list`
- `a2a.task.cancel`
- `a2a.agent.extendedCard`
- `a2a.rpc.call`

## Example Agent

Start the included demo A2A agent:

```powershell
npm run example:a2a -- --port 9010
```

Start UAB with that agent registered:

```powershell
$env:UAB_A2A_AGENT_ID="example"
$env:UAB_A2A_AGENT_URL="http://127.0.0.1:9010"
npm run serve -- --port 8787
```

List agents:

```powershell
curl.exe -X POST http://127.0.0.1:8787/rpc `
  -H "content-type: application/json" `
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"agents\",\"runtime\":\"a2a\",\"method\":\"a2a.agents.list\",\"params\":{}}"
```

Send a message:

```powershell
curl.exe -X POST http://127.0.0.1:8787/rpc `
  -H "content-type: application/json" `
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"send\",\"runtime\":\"a2a\",\"method\":\"a2a.message.send\",\"params\":{\"agentId\":\"example\",\"text\":\"hello\"}}"
```

## Multiple Agents

Set `UAB_A2A_AGENTS` to a JSON array:

```json
[
  {
    "id": "support-agent",
    "baseUrl": "http://127.0.0.1:9010"
  },
  {
    "id": "billing-agent",
    "cardUrl": "https://example.com/.well-known/agent-card.json",
    "token": "secret"
  }
]
```

## Current Scope

This layer makes UAB an A2A client. Exposing UAB itself as an A2A server is a separate follow-up, where UAB can publish its own Agent Card and route incoming A2A tasks to Hermes, OpenClaw, MCP tools, or custom adapters.
