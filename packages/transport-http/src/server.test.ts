import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { AgentBridge } from "@uab/core";
import type { AgentRuntimeAdapter } from "@uab/adapter-sdk";
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
