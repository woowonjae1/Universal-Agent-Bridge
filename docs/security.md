# Security Model

The bridge is designed to support local development and remote control scenarios. Remote deployments should not use the default allow-all policy.

## Scopes

The core package includes a scoped access policy. It maps bridge methods to scopes:

- `sessions.list` -> `sessions:read`
- `sessions.create` -> `sessions:write`
- `models.set` -> `models:write`
- `system.restart` -> `system:admin`

Wildcard scopes are supported:

- `*`
- `sessions:*`
- `models:*`

## Principal

A principal represents a caller:

```json
{
  "id": "user_1",
  "scopes": ["sessions:read", "models:write"],
  "runtimeAllowlist": ["mock", "openclaw"]
}
```

## Planned Hardening

- Pairing flow for local-to-remote trust setup.
- Token-based authentication for HTTP and MQTT transports.
- Per-runtime allowlists.
- Audit log with trace id, principal id, runtime, method, status, and duration.
- Dangerous-operation confirmation for admin methods.

