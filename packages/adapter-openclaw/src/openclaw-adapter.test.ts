import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { createOpenClawAdapter } from "./index.js";

test("OpenClaw adapter performs Gateway connect then RPC call", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const methods: string[] = [];

  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(String(raw)) as { id: string; method: string };
      methods.push(frame.method);
      socket.send(JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: frame.method === "connect"
          ? { type: "hello-ok", protocol: 4 }
          : { status: "ok" }
      }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = readPort(server);

  try {
    const adapter = createOpenClawAdapter({
      gatewayUrl: `ws://127.0.0.1:${port}`
    });
    const result = await adapter.call({
      method: "status",
      params: {},
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "openclaw",
        method: "status"
      }
    }, {
      requestId: "req",
      traceId: "trace"
    });

    assert.deepEqual(result, { status: "ok" });
    assert.deepEqual(methods, ["connect", "status"]);
  } finally {
    wss.close();
    await closeServer(server);
  }
});

test("OpenClaw adapter streams Gateway event frames", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });

  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(String(raw)) as { id: string; method: string };
      if (frame.method === "connect") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { type: "hello-ok", protocol: 4 }
        }));
        return;
      }

      socket.send(JSON.stringify({
        type: "event",
        event: "message.delta",
        payload: { delta: "hello" },
        seq: 1
      }));
      socket.send(JSON.stringify({
        type: "event",
        event: "tool.call",
        payload: { name: "search", args: { q: "uab" } },
        seq: 2
      }));
      socket.send(JSON.stringify({
        type: "event",
        event: "artifact.created",
        payload: { artifactId: "art_1" },
        seq: 3
      }));
      socket.send(JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: { status: "done" }
      }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = readPort(server);

  try {
    const adapter = createOpenClawAdapter({
      gatewayUrl: `ws://127.0.0.1:${port}`
    });
    const events = [];
    for await (const event of adapter.stream!({
      method: "chat.stream",
      params: { sessionKey: "s1", text: "hi" },
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "openclaw",
        method: "chat.stream"
      }
    }, {
      requestId: "req",
      traceId: "trace"
    })) {
      events.push(event);
    }

    assert.deepEqual(events.map((event) => event.type), [
      "text",
      "tool_call",
      "artifact",
      "result"
    ]);
  } finally {
    wss.close();
    await closeServer(server);
  }
});

test("OpenClaw CLI fallback maps local session and model commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uab-openclaw-cli-"));
  const logPath = join(dir, "calls.jsonl");
  const cliPath = join(dir, "fake-openclaw.mjs");
  await writeFile(cliPath, `
    import { appendFileSync } from "node:fs";
    const logPath = process.env.OPENCLAW_FAKE_LOG;
    appendFileSync(logPath, JSON.stringify(process.argv.slice(2)) + "\\n");
    console.log(JSON.stringify({ ok: true, argv: process.argv.slice(2) }));
  `);

  const adapter = createOpenClawAdapter({
    mode: "cli",
    cliCommand: `node "${cliPath}"`,
    timeoutMs: 10_000
  });
  const context = {
    requestId: "req",
    traceId: "trace"
  };
  const previousLog = process.env.OPENCLAW_FAKE_LOG;
  process.env.OPENCLAW_FAKE_LOG = logPath;

  try {
    await adapter.call({
      method: "sessions.list",
      params: { limit: 3, all_agents: true },
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "openclaw",
        method: "sessions.list"
      }
    }, context);
    await adapter.call({
      method: "models.list",
      params: { provider: "openai" },
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "openclaw",
        method: "models.list"
      }
    }, context);

    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);

    assert.deepEqual(calls[0], ["sessions", "list", "--json", "--limit", "3", "--all-agents"]);
    assert.deepEqual(calls[1], ["models", "list", "--json", "--provider", "openai"]);
  } finally {
    if (previousLog === undefined) {
      delete process.env.OPENCLAW_FAKE_LOG;
    } else {
      process.env.OPENCLAW_FAKE_LOG = previousLog;
    }
  }
});

test("OpenClaw CLI fallback maps models.list to fast model status by default", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uab-openclaw-cli-"));
  const logPath = join(dir, "calls.jsonl");
  const cliPath = join(dir, "fake-openclaw.mjs");
  await writeFile(cliPath, `
    import { appendFileSync } from "node:fs";
    appendFileSync(process.env.OPENCLAW_FAKE_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
    console.log(JSON.stringify({ ok: true }));
  `);

  const adapter = createOpenClawAdapter({
    mode: "cli",
    cliCommand: `node "${cliPath}"`,
    timeoutMs: 10_000
  });
  const previousLog = process.env.OPENCLAW_FAKE_LOG;
  process.env.OPENCLAW_FAKE_LOG = logPath;

  try {
    await adapter.call({
      method: "models.list",
      params: {},
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "openclaw",
        method: "models.list"
      }
    }, {
      requestId: "req",
      traceId: "trace"
    });

    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);

    assert.deepEqual(calls[0], ["models", "status", "--json"]);
  } finally {
    if (previousLog === undefined) {
      delete process.env.OPENCLAW_FAKE_LOG;
    } else {
      process.env.OPENCLAW_FAKE_LOG = previousLog;
    }
  }
});

function readPort(server: ReturnType<typeof createServer>): number {
  const address = server.address();
  assert.equal(typeof address, "object");
  assert.notEqual(address, null);
  return (address as AddressInfo).port;
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
