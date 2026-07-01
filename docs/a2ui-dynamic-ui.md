# A2UI Dynamic UI

Universal Agent Bridge treats A2UI as a declarative UI payload layer. Agent adapters return a JSON envelope, the bridge validates and sanitizes it, AG-UI carries it to clients, and the Dashboard renders it with a local component whitelist.

This is the fifth layer in the project roadmap:

```text
Adapter real integrations -> AG-UI event outlet -> MCP tool layer -> A2A agent layer -> A2UI dynamic UI
```

## Flow

```text
Agent adapter result
  -> result.a2ui or result.ui
  -> @uab/a2ui validation and sanitization
  -> AG-UI CUSTOM event: a2ui.envelope
  -> Dashboard dynamic UI renderer
```

The bridge does not execute agent-generated JavaScript, HTML, event handlers, or remote component code. Clients render known component types locally.

## Envelope

```json
{
  "version": "1.0",
  "type": "createSurface",
  "surfaceId": "agent-review",
  "dataModel": {
    "status": "ready"
  },
  "components": [
    {
      "type": "card",
      "title": "Agent review",
      "children": [
        {
          "type": "heading",
          "text": "Next action"
        },
        {
          "type": "text",
          "text": "Review the generated plan before continuing."
        },
        {
          "type": "button",
          "label": "Continue",
          "variant": "primary",
          "action": {
            "type": "callFunction",
            "name": "agent.continue"
          }
        }
      ]
    }
  ]
}
```

Supported envelope types:

- `createSurface`
- `updateComponents`
- `updateDataModel`
- `deleteSurface`
- `actionResponse`
- `callFunction`

Supported Dashboard components:

- `surface`
- `card`
- `heading`
- `text`
- `button`
- `input`
- `form`
- `list`
- `table`
- `stat`
- `row`
- `column`
- `divider`

## Try It

Start the bridge and dashboard:

```powershell
npm run serve -- --port 8787
npm run dashboard
```

In the Dashboard, choose:

- runtime: `mock`
- method: `ui.surface.demo`
- action: `AG-UI`

The AG-UI stream will include:

```json
{
  "type": "CUSTOM",
  "name": "a2ui.envelope",
  "value": {
    "version": "1.0",
    "type": "createSurface",
    "surfaceId": "mock-agent-surface"
  }
}
```

The Dynamic UI panel renders the returned surface.

## Adapter Contract

Any adapter can return A2UI by placing a valid envelope under `a2ui` or `ui`:

```ts
return {
  output: "Created review surface.",
  a2ui: {
    version: "1.0",
    type: "createSurface",
    surfaceId: "review",
    components: []
  }
};
```

This keeps OpenClaw, Hermes, A2A remote agents, and custom runtimes behind the same UI outlet.
