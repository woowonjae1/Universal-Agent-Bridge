import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { createHttpJsonRpcAdapter } from "./index.js";

test("HTTP JSON-RPC adapter aborts in-flight RPC requests from context signal", async () => {
  let requestSeen = false;
  let markRequestSeen: (() => void) | undefined;
  const requestReceived = new Promise<void>((resolve) => {
    markRequestSeen = resolve;
  });
  const server = createServer((request, response) => {
    requestSeen = true;
    markRequestSeen?.();
    response.setHeader("content-type", "application/json");
  });

  await listen(server);
  const port = readPort(server);
  const controller = new AbortController();

  try {
    const adapter = createHttpJsonRpcAdapter({
      id: "jsonrpc",
      baseUrl: `http://127.0.0.1:${port}`,
      timeoutMs: 10_000
    });
    const pending = Promise.resolve(adapter.call({
      method: "system.ping",
      params: {},
      raw: {
        jsonrpc: "2.0",
        id: "req_abort",
        runtime: "jsonrpc",
        method: "system.ping"
      }
    }, {
      requestId: "req_abort",
      traceId: "trace",
      signal: controller.signal
    }));

    await withTimeout(requestReceived, 500);
    controller.abort(new Error("stop jsonrpc request"));

    await assert.rejects(
      pending,
      (error: unknown) => {
        assert.equal(error instanceof Error ? error.name : "", "AbortError");
        assert.match(error instanceof Error ? error.message : "", /stop jsonrpc request/);
        return true;
      }
    );
    assert.equal(requestSeen, true);
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
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("Timed out waiting for request.")), timeoutMs);
    })
  ]);
}
