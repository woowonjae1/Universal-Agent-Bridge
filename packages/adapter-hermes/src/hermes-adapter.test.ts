import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createHermesAdapter } from "./index.js";

test("Hermes adapter maps sessions.list to /api/sessions", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    calls.push({ method: request.method ?? "", path: request.url ?? "" });
    response.setHeader("content-type", "application/json");

    if (request.url === "/api/sessions?limit=2" && request.method === "GET") {
      response.end(JSON.stringify({ sessions: [{ id: "s1" }] }));
      return;
    }

    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });

  await listen(server);
  const port = readPort(server);

  try {
    const adapter = createHermesAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "test-token"
    });
    const result = await adapter.call({
      method: "sessions.list",
      params: { limit: 2 },
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "hermes",
        method: "sessions.list"
      }
    }, {
      requestId: "req",
      traceId: "trace"
    });

    assert.deepEqual(result, { sessions: [{ id: "s1" }] });
    assert.deepEqual(calls, [{ method: "GET", path: "/api/sessions?limit=2" }]);
  } finally {
    await close(server);
  }
});

test("Hermes adapter applies default model to chat completions", async () => {
  let body = "";
  const server = createServer(async (request, response) => {
    for await (const chunk of request) {
      body += Buffer.from(chunk).toString("utf8");
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  await listen(server);
  const port = readPort(server);

  try {
    const adapter = createHermesAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      model: "project-hermes"
    });
    await adapter.call({
      method: "chat.completions.create",
      params: { messages: [{ role: "user", content: "hi" }] },
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "hermes",
        method: "chat.completions.create"
      }
    }, {
      requestId: "req",
      traceId: "trace"
    });

    assert.equal(JSON.parse(body).model, "project-hermes");
  } finally {
    await close(server);
  }
});

test("Hermes adapter does not inject model into runs.create", async () => {
  let body = "";
  const server = createServer(async (request, response) => {
    for await (const chunk of request) {
      body += Buffer.from(chunk).toString("utf8");
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ run_id: "run_1", status: "started" }));
  });

  await listen(server);
  const port = readPort(server);

  try {
    const adapter = createHermesAdapter({
      baseUrl: `http://127.0.0.1:${port}`,
      model: "project-hermes"
    });
    await adapter.call({
      method: "runs.create",
      params: { input: "Run tests", session_id: "project" },
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "hermes",
        method: "runs.create"
      }
    }, {
      requestId: "req",
      traceId: "trace"
    });

    const payload = JSON.parse(body) as Record<string, unknown>;
    assert.equal(payload.model, undefined);
    assert.equal(payload.session_id, "project");
  } finally {
    await close(server);
  }
});

test("Hermes adapter streams session chat SSE events", async () => {
  const server = createServer(async (request, response) => {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/api/sessions/session_1/chat/stream");
    response.writeHead(200, {
      "content-type": "text/event-stream"
    });
    response.write("event: message.delta\n");
    response.write("data: {\"delta\":\"hello\"}\n\n");
    response.write("event: tool.call\n");
    response.write("data: {\"name\":\"search\",\"arguments\":{\"q\":\"uab\"}}\n\n");
    response.write("event: artifact.created\n");
    response.write("data: {\"artifact_id\":\"art_1\",\"title\":\"Plan\"}\n\n");
    response.end("event: done\ndata: {\"done\":true}\n\n");
  });

  await listen(server);
  const port = readPort(server);

  try {
    const adapter = createHermesAdapter({
      baseUrl: `http://127.0.0.1:${port}`
    });
    const events = [];
    for await (const event of adapter.stream!({
      method: "sessions.chat.stream",
      params: { id: "session_1", input: "hi" },
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "hermes",
        method: "sessions.chat.stream"
      }
    }, {
      requestId: "req",
      traceId: "trace"
    })) {
      events.push(event);
    }

    assert.deepEqual(events.map((event) => event.type), [
      "step",
      "text",
      "tool_call",
      "artifact",
      "result",
      "step"
    ]);
  } finally {
    await close(server);
  }
});

test("Hermes adapter maps artifacts and tool calls to real API paths", async () => {
  const calls: Array<{ method: string; path: string }> = [];
  const server = createServer((request, response) => {
    calls.push({ method: request.method ?? "", path: request.url ?? "" });
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ ok: true }));
  });

  await listen(server);
  const port = readPort(server);

  try {
    const adapter = createHermesAdapter({
      baseUrl: `http://127.0.0.1:${port}`
    });
    const context = {
      requestId: "req",
      traceId: "trace"
    };

    await adapter.call({
      method: "artifacts.list",
      params: { session_id: "s1", limit: 10 },
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "hermes",
        method: "artifacts.list"
      }
    }, context);
    await adapter.call({
      method: "artifacts.get",
      params: { artifact_id: "art_1" },
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "hermes",
        method: "artifacts.get"
      }
    }, context);
    await adapter.call({
      method: "toolcalls.list",
      params: { run_id: "run_1" },
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "hermes",
        method: "toolcalls.list"
      }
    }, context);

    assert.deepEqual(calls, [
      { method: "GET", path: "/api/artifacts?session_id=s1&limit=10" },
      { method: "GET", path: "/api/artifacts/art_1" },
      { method: "GET", path: "/api/tool-calls?run_id=run_1" }
    ]);
  } finally {
    await close(server);
  }
});

function listen(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function readPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return (address as AddressInfo).port;
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
