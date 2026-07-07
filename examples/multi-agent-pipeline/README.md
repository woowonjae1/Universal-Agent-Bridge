# Multi-Agent Pipeline (zero-setup demo)

The fastest way to see what Universal Agent Bridge does. **No API keys, no OpenClaw, no ports** — three in-process mock runtimes are coordinated in one DAG.

```bash
npm install
npm run demo
```

You will see a streaming `writer` runtime produce text token-by-token, a `reviewer` runtime consume that streamed text and score it, and a `formatter` runtime combine both results — all through one `AgentBridge`.

## What it demonstrates

- **Heterogeneous runtimes behind one protocol.** `writer`, `reviewer`, and `formatter` are three independent adapters. Each could be an OpenClaw gateway, an MCP tool server, an A2A agent, or any HTTP JSON-RPC agent — the plan does not change.
- **Streaming step handoff.** The `write` step runs with `stream: true`; the bridge accumulates its tokens and exposes them to later steps as `${steps.write.stream.text}`.
- **Cross-step dataflow.** `rate` reads the streamed text; `render` reads both the text and `${steps.rate.result.score}`. Missing references fail the step explicitly.
- **DAG orchestration.** `dependsOn` sequences the steps; independent steps would run concurrently.

## The plan

```jsonc
{
  "id": "multi_agent_pipeline",
  "mode": "dag",
  "steps": [
    { "id": "write",  "runtime": "writer",    "method": "chat.stream", "stream": true,
      "params": { "message": "In one sentence, what is a multi-agent bridge?" } },
    { "id": "rate",   "runtime": "reviewer",  "dependsOn": ["write"], "method": "review.rate",
      "params": { "text": "${steps.write.stream.text}" } },
    { "id": "render", "runtime": "formatter", "dependsOn": ["rate"],  "method": "format.render",
      "params": { "text": "${steps.write.stream.text}", "score": "${steps.rate.result.score}" } }
  ]
}
```

## From mock to real

The mock adapters in [`demo.mjs`](demo.mjs) implement the same `AgentRuntimeAdapter` contract as the shipped adapters — `info`, `capabilities()`, `call()`, and (for streaming) `stream()`. To run this against real systems, register a real adapter instead of a mock and keep the plan as-is. See [../../docs/adapter-guide.md](../../docs/adapter-guide.md).
