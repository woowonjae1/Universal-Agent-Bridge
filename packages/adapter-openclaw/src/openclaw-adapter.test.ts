import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
