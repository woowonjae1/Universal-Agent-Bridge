# Adapter Guide

Adapters isolate runtime-specific behavior from the bridge core. A runtime adapter should translate Universal Agent Bridge method names into the native API calls of one agent runtime.

## Minimal Adapter

```ts
import type { AgentRuntimeAdapter } from "@uab/adapter-sdk";

export const adapter: AgentRuntimeAdapter = {
  info: {
    id: "example",
    name: "Example Runtime"
  },
  capabilities() {
    return {
      sessions: { read: true, write: true },
      models: { read: true }
    };
  },
  async call(request, context) {
    if (request.method === "sessions.list") {
      return { sessions: [] };
    }

    throw new Error(`Unsupported method: ${request.method}`);
  }
};
```

## Adapter Rules

- Keep runtime SDK objects inside the adapter.
- Return JSON-serializable values.
- Throw `AdapterError` with a bridge error code when the failure should be visible to clients.
- Use `capabilities()` to declare what the runtime can actually do.
- Treat dangerous operations such as `system.restart` and `system.stop` as admin-level methods.

## Suggested Method Names

- `system.ping`
- `system.health`
- `sessions.list`
- `sessions.get`
- `sessions.create`
- `models.list`
- `models.set`
- `skills.listInstalled`
- `memory.listFiles`
- `artifacts.list`
- `cron.list`

