import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import {
  createOpenClawAdapter,
  type OpenClawDeviceIdentityOptions
} from "./index.js";
import { BRIDGE_ERROR_CODES } from "@uab/protocol";

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

test("OpenClaw adapter normalizes chat.send text params for Gateway schema", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let chatParams: Record<string, unknown> | undefined;

  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(String(raw)) as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      if (frame.method === "chat.send") chatParams = frame.params;
      socket.send(JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: frame.method === "connect"
          ? { type: "hello-ok", protocol: 4 }
          : { runId: "chat_req", status: "started" }
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
      method: "chat.send",
      params: { text: "hello" },
      raw: {
        jsonrpc: "2.0",
        id: "chat_req",
        runtime: "openclaw",
        session: { id: "project-main" },
        method: "chat.send"
      }
    }, {
      requestId: "chat_req",
      traceId: "trace"
    });

    assert.deepEqual(result, { runId: "chat_req", status: "started" });
    assert.deepEqual(chatParams, {
      sessionKey: "project-main",
      message: "hello",
      deliver: false,
      idempotencyKey: "chat_req"
    });
  } finally {
    wss.close();
    await closeServer(server);
  }
});

test("OpenClaw adapter streams Gateway event frames", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let chatParams: Record<string, unknown> | undefined;

  wss.on("connection", (socket: WebSocket) => {
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(String(raw)) as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      if (frame.method === "connect") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { type: "hello-ok", protocol: 4 }
        }));
        return;
      }

      if (frame.method === "chat.send") chatParams = frame.params;
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
    assert.deepEqual(chatParams, {
      sessionKey: "s1",
      message: "hi",
      deliver: false,
      idempotencyKey: "req"
    });
  } finally {
    wss.close();
    await closeServer(server);
  }
});

test("OpenClaw adapter signs Gateway connect with device challenge", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const identity = createTestDeviceIdentity();
  let connectParams: Record<string, unknown> | undefined;

  wss.on("connection", (socket: WebSocket) => {
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce_test" }
    }));
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(String(raw)) as {
        id: string;
        method: string;
        params?: Record<string, unknown>;
      };
      if (frame.method === "connect") {
        connectParams = frame.params;
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { type: "hello-ok", protocol: 4 }
        }));
        return;
      }

      socket.send(JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: { status: "ok" }
      }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = readPort(server);

  try {
    const adapter = createOpenClawAdapter({
      gatewayUrl: `ws://127.0.0.1:${port}`,
      deviceIdentity: identity,
      scopes: ["operator.read"]
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
    assert.ok(connectParams);
    assert.deepEqual(connectParams.scopes, ["operator.read"]);
    const device = connectParams.device as Record<string, unknown>;
    assert.equal(device.id, "device_test");
    assert.equal(device.nonce, "nonce_test");
    assert.equal(typeof device.publicKey, "string");
    assert.equal(typeof device.signature, "string");
    assert.equal(typeof device.signedAt, "number");
  } finally {
    wss.close();
    await closeServer(server);
  }
});

test("OpenClaw adapter persists Gateway device token from hello auth", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  const dir = await mkdtemp(join(tmpdir(), "uab-openclaw-auth-"));
  const storePath = join(dir, "device-auth.json");
  const identity = createTestDeviceIdentity();

  wss.on("connection", (socket: WebSocket) => {
    socket.send(JSON.stringify({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: "nonce_store" }
    }));
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(String(raw)) as { id: string; method: string };
      socket.send(JSON.stringify({
        type: "res",
        id: frame.id,
        ok: true,
        payload: frame.method === "connect"
          ? {
            type: "hello-ok",
            protocol: 4,
            auth: {
              role: "operator",
              deviceToken: "device-token-1",
              scopes: ["operator.read", "operator.write"]
            }
          }
          : { status: "ok" }
      }));
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = readPort(server);

  try {
    const adapter = createOpenClawAdapter({
      gatewayUrl: `ws://127.0.0.1:${port}`,
      deviceIdentity: identity,
      deviceAuthStorePath: storePath
    });
    await adapter.call({
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

    const stored = JSON.parse(await readFile(storePath, "utf8")) as {
      deviceId: string;
      tokens: { operator: { token: string; scopes: string[] } };
    };

    assert.equal(stored.deviceId, "device_test");
    assert.equal(stored.tokens.operator.token, "device-token-1");
    assert.deepEqual(stored.tokens.operator.scopes, ["operator.read", "operator.write"]);
  } finally {
    wss.close();
    await closeServer(server);
  }
});

test("OpenClaw Gateway adapter closes WebSocket when context signal aborts", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let socketClosed = false;

  wss.on("connection", (socket: WebSocket) => {
    socket.on("close", () => {
      socketClosed = true;
    });
    socket.on("message", (raw: Buffer) => {
      const frame = JSON.parse(String(raw)) as { id: string; method: string };
      if (frame.method === "connect") {
        socket.send(JSON.stringify({
          type: "res",
          id: frame.id,
          ok: true,
          payload: { type: "hello-ok", protocol: 4 }
        }));
      }
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = readPort(server);
  const controller = new AbortController();

  try {
    const adapter = createOpenClawAdapter({
      gatewayUrl: `ws://127.0.0.1:${port}`,
      timeoutMs: 10_000
    });
    const pending = Promise.resolve(adapter.call({
      method: "status",
      params: {},
      raw: {
        jsonrpc: "2.0",
        id: "req_abort",
        runtime: "openclaw",
        method: "status"
      }
    }, {
      requestId: "req_abort",
      traceId: "trace",
      signal: controller.signal
    }));

    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new Error("stop openclaw gateway"));

    await assert.rejects(
      pending,
      (error: unknown) => {
        assert.equal((error as { code?: number }).code, BRIDGE_ERROR_CODES.timeout);
        assert.match(error instanceof Error ? error.message : "", /aborted/);
        return true;
      }
    );
    await waitFor(() => socketClosed);
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

test("OpenClaw CLI fallback kills process when context signal aborts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uab-openclaw-cli-abort-"));
  const cliPath = join(dir, "fake-openclaw-hang.mjs");
  await writeFile(cliPath, `
    setTimeout(() => {
      console.log(JSON.stringify({ ok: true }));
    }, 10000);
  `);
  const controller = new AbortController();
  const adapter = createOpenClawAdapter({
    mode: "cli",
    cliCommand: `node "${cliPath}"`,
    timeoutMs: 10_000
  });

  const pending = Promise.resolve(adapter.call({
    method: "status",
    params: {},
    raw: {
      jsonrpc: "2.0",
      id: "req_abort",
      runtime: "openclaw",
      method: "status"
    }
  }, {
    requestId: "req_abort",
    traceId: "trace",
    signal: controller.signal
  }));

  await new Promise((resolve) => setTimeout(resolve, 20));
  controller.abort(new Error("stop openclaw cli"));

  await assert.rejects(
    pending,
    (error: unknown) => {
      assert.equal((error as { code?: number }).code, BRIDGE_ERROR_CODES.timeout);
      assert.match(error instanceof Error ? error.message : "", /aborted/);
      return true;
    }
  );
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

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createTestDeviceIdentity(): OpenClawDeviceIdentityOptions {
  const { privateKey } = generateKeyPairSync("ed25519");
  return {
    deviceId: "device_test",
    privateKeyPem: privateKey.export({
      type: "pkcs8",
      format: "pem"
    }).toString()
  };
}
