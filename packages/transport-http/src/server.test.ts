import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { AgentBridge } from "@uab/core";
import type { AdapterStreamEvent, AgentRuntimeAdapter } from "@uab/adapter-sdk";
import test from "node:test";
import { createHttpBridgeServer } from "./server.js";

const adapter: AgentRuntimeAdapter = {
  info: {
    id: "test",
    name: "Test Runtime"
  },
  capabilities() {
    return {
      sessions: { read: true }
    };
  },
  call() {
    return {
      sessions: [
        {
          id: "session_demo",
          title: "Demo session"
        }
      ]
    };
  }
};

const a2uiAdapter: AgentRuntimeAdapter = {
  info: {
    id: "a2ui-test",
    name: "A2UI Test Runtime"
  },
  capabilities() {
    return {
      ui: { read: true, write: true }
    };
  },
  call() {
    return {
      output: "Created surface.",
      a2ui: {
        version: "1.0",
        type: "createSurface",
        surfaceId: "surface_test",
        components: [
          {
            type: "text",
            text: "hello"
          }
        ]
      }
    };
  }
};

const streamingAdapter: AgentRuntimeAdapter = {
  info: {
    id: "streaming-test",
    name: "Streaming Test Runtime"
  },
  capabilities() {
    return {
      chat: { write: true }
    };
  },
  call() {
    return {
      ok: true
    };
  },
  async *stream(): AsyncIterable<AdapterStreamEvent> {
    yield {
      type: "text",
      delta: "hello"
    };
    yield {
      type: "tool_call",
      name: "search",
      data: {
        q: "uab"
      }
    };
    yield {
      type: "artifact",
      data: {
        id: "art_1"
      }
    };
    yield {
      type: "result",
      data: {
        status: "done"
      }
    };
  }
};

test("HTTP transport streams bridge calls as AG-UI SSE events", async () => {
  const bridge = new AgentBridge({
    adapters: [adapter]
  });
  const server = createHttpBridgeServer({ bridge });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const port = readPort(server);

    const response = await fetch(`http://127.0.0.1:${port}/agui/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({
        threadId: "thread_test",
        runId: "run_test",
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {
          uab: {
            runtime: "test",
            method: "sessions.list",
            params: {}
          }
        }
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type")?.startsWith("text/event-stream"), true);

    const body = await response.text();
    const events = body
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, "")) as { type: string });

    assert.deepEqual(events.map((event) => event.type), [
      "RUN_STARTED",
      "STATE_SNAPSHOT",
      "CUSTOM",
      "STEP_STARTED",
      "STEP_FINISHED",
      "CUSTOM",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED"
    ]);
  } finally {
    await close(server);
  }
});

test("HTTP transport forwards adapter stream events as AG-UI events", async () => {
  const bridge = new AgentBridge({
    adapters: [streamingAdapter]
  });
  const server = createHttpBridgeServer({ bridge });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const port = readPort(server);

    const response = await fetch(`http://127.0.0.1:${port}/agui/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({
        threadId: "thread_stream",
        runId: "run_stream",
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {
          uab: {
            runtime: "streaming-test",
            method: "chat.stream",
            params: {}
          }
        }
      })
    });

    assert.equal(response.status, 200);
    const body = await response.text();
    const events = body
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, "")) as { type: string; name?: string; delta?: string });

    assert.equal(events.some((event) => event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "hello"), true);
    assert.equal(events.some((event) => event.type === "CUSTOM" && event.name === "tool.call"), true);
    assert.equal(events.some((event) => event.type === "CUSTOM" && event.name === "artifact"), true);
    assert.equal(events.at(-2)?.type, "RUN_FINISHED");
    assert.equal(events.at(-1)?.type, "TEXT_MESSAGE_END");
  } finally {
    await close(server);
  }
});

test("HTTP transport forwards A2UI envelopes through AG-UI custom events", async () => {
  const bridge = new AgentBridge({
    adapters: [a2uiAdapter]
  });
  const server = createHttpBridgeServer({ bridge });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const port = readPort(server);

    const response = await fetch(`http://127.0.0.1:${port}/agui/runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify({
        threadId: "thread_a2ui",
        runId: "run_a2ui",
        state: {},
        messages: [],
        tools: [],
        context: [],
        forwardedProps: {
          uab: {
            runtime: "a2ui-test",
            method: "ui.surface.demo",
            params: {}
          }
        }
      })
    });

    assert.equal(response.status, 200);

    const body = await response.text();
    const events = body
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, "")) as { type: string; name?: string; value?: unknown });

    const a2uiEvent = events.find((event) => event.type === "CUSTOM" && event.name === "a2ui.envelope");
    assert.equal(Boolean(a2uiEvent), true);
    assert.equal((a2uiEvent?.value as { surfaceId?: string }).surfaceId, "surface_test");
  } finally {
    await close(server);
  }
});

test("HTTP transport exposes bridge session bindings", async () => {
  const bridge = new AgentBridge({
    adapters: [adapter]
  });
  const server = createHttpBridgeServer({ bridge });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const port = readPort(server);

    await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "session_http",
        runtime: "test",
        session: { id: "http_session" },
        method: "sessions.list",
        params: {}
      })
    });

    const response = await fetch(`http://127.0.0.1:${port}/sessions`);
    const body = await response.json() as { sessions: Array<{ id: string; runtime: string }> };

    assert.equal(response.status, 200);
    assert.deepEqual(body.sessions.map((session) => ({
      id: session.id,
      runtime: session.runtime
    })), [
      {
        id: "http_session",
        runtime: "test"
      }
    ]);
  } finally {
    await close(server);
  }
});

test("HTTP transport exposes resources metrics and trace snapshots", async () => {
  const bridge = new AgentBridge({
    adapters: [{
      ...adapter,
      call() {
        return {
          artifacts: [
            { id: "art_http", kind: "artifact", name: "HTTP artifact" }
          ]
        };
      }
    }]
  });
  const server = createHttpBridgeServer({ bridge });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const port = readPort(server);
    await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "http_resource",
        runtime: "test",
        session: { id: "http_resource_session" },
        method: "artifacts.list",
        meta: { traceId: "trace_http_resource" },
        params: {}
      })
    });

    const resourcesResponse = await fetch(`http://127.0.0.1:${port}/resources?kind=artifact&sessionId=http_resource_session`);
    const resources = await resourcesResponse.json() as { resources: Array<{ id: string; kind: string }> };
    const metricsResponse = await fetch(`http://127.0.0.1:${port}/metrics`);
    const metrics = await metricsResponse.json() as { calls: number; runtimes: Array<{ runtime: string }> };
    const traceResponse = await fetch(`http://127.0.0.1:${port}/traces/trace_http_resource`);
    const trace = await traceResponse.json() as { audit: unknown[]; resources: unknown[] };

    assert.equal(resources.resources.length, 1);
    assert.equal(resources.resources[0].kind, "artifact");
    assert.equal(metrics.calls, 1);
    assert.equal(metrics.runtimes[0].runtime, "test");
    assert.equal(trace.audit.length, 1);
    assert.equal(trace.resources.length, 1);
  } finally {
    await close(server);
  }
});

test("HTTP transport cancels active RPC requests", async () => {
  const bridge = new AgentBridge({
    adapters: [{
      ...adapter,
      async call(_request, context) {
        await new Promise<void>((resolve, reject) => {
          context.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("cancelled"), { code: -32005 }));
          }, { once: true });
          setTimeout(resolve, 500);
        });
        return { ok: true };
      }
    }]
  });
  const server = createHttpBridgeServer({ bridge });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const port = readPort(server);
    const pending = fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "http_cancel",
        runtime: "test",
        method: "sessions.list",
        params: {}
      })
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const cancelResponse = await fetch(`http://127.0.0.1:${port}/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: "http_cancel" })
    });
    const cancelBody = await cancelResponse.json() as { cancelled: boolean };
    const rpcResponse = await pending;
    const rpcBody = await rpcResponse.json() as { error?: { message: string; code: number } };

    assert.equal(cancelBody.cancelled, true);
    assert.equal(rpcBody.error?.message, "cancelled");
    assert.equal(rpcBody.error?.code, -32005);
  } finally {
    await close(server);
  }
});

function readPort(server: ReturnType<typeof createHttpBridgeServer>): number {
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return (address as AddressInfo).port;
}

function close(server: ReturnType<typeof createHttpBridgeServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
