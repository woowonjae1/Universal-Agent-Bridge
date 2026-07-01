# Protocol

Universal Agent Bridge uses a JSON-RPC style envelope with an explicit `runtime` field.

## Request

```json
{
  "jsonrpc": "2.0",
  "id": "req_001",
  "runtime": "mock",
  "method": "sessions.list",
  "params": {},
  "meta": {
    "traceId": "trace_001",
    "source": "dashboard"
  }
}
```

## Success Response

```json
{
  "jsonrpc": "2.0",
  "id": "req_001",
  "result": {
    "sessions": []
  }
}
```

## Error Response

```json
{
  "jsonrpc": "2.0",
  "id": "req_001",
  "error": {
    "code": -32001,
    "message": "Runtime 'openclaw' is not registered."
  }
}
```

## Error Codes

- `-32700`: parse error
- `-32600`: invalid request
- `-32601`: method not found
- `-32602`: invalid params
- `-32603`: internal error
- `-32001`: runtime not found
- `-32003`: permission denied
- `-32004`: adapter unavailable
- `-32005`: timeout

