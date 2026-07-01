# MCP Tool Layer

Universal Agent Bridge can register MCP servers as a runtime named `mcp` and expose their tools through the same bridge protocol, dashboard, audit log, and AG-UI stream outlet.

This is the third layer in the roadmap:

```text
Adapter real integrations -> AG-UI event outlet -> MCP tool layer -> A2A agent layer -> A2UI dynamic UI
```

## What It Does

`@uab/mcp` implements:

- MCP `initialize`
- MCP `notifications/initialized`
- MCP `tools/list`
- MCP `tools/call`
- stdio MCP transport
- basic Streamable HTTP-style JSON-RPC POST support

UAB exposes those as bridge methods:

- `mcp.servers.list`
- `mcp.tools.list`
- `mcp.tools.call`

## Stdio Example

The repository includes a small example MCP server:

```powershell
$env:UAB_MCP_SERVER_ID="example"
$env:UAB_MCP_SERVER_COMMAND="node"
$env:UAB_MCP_SERVER_ARGS="examples/mcp-stdio-server/server.mjs"
npm run serve -- --port 8787
```

List tools:

```powershell
curl.exe -X POST http://127.0.0.1:8787/rpc `
  -H "content-type: application/json" `
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"mcp_tools\",\"runtime\":\"mcp\",\"method\":\"mcp.tools.list\",\"params\":{\"serverId\":\"example\"}}"
```

Call a tool:

```powershell
curl.exe -X POST http://127.0.0.1:8787/rpc `
  -H "content-type: application/json" `
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"mcp_call\",\"runtime\":\"mcp\",\"method\":\"mcp.tools.call\",\"params\":{\"serverId\":\"example\",\"name\":\"echo\",\"arguments\":{\"text\":\"hello\"}}}"
```

## HTTP MCP Example

```powershell
$env:UAB_MCP_SERVER_ID="remote"
$env:UAB_MCP_SERVER_TRANSPORT="http"
$env:UAB_MCP_SERVER_URL="http://127.0.0.1:3000/mcp"
$env:UAB_MCP_SERVER_HEADERS_JSON="{\"authorization\":\"Bearer token\"}"
npm run serve -- --port 8787
```

## Multiple Servers

For multiple servers, set `UAB_MCP_SERVERS` to a JSON array:

```json
[
  {
    "id": "filesystem",
    "transport": "stdio",
    "command": "node",
    "args": ["server.mjs"]
  },
  {
    "id": "remote-tools",
    "transport": "http",
    "url": "http://127.0.0.1:3000/mcp"
  }
]
```

## Dashboard

Once configured, the dashboard shows a `mcp` runtime. Use the method catalog to select:

- `mcp.servers.list`
- `mcp.tools.list`
- `mcp.tools.call`

Calls are recorded in `/audit` and can also be wrapped through `/agui/runs`.
