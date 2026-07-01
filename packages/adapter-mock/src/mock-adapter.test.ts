import assert from "node:assert/strict";
import test from "node:test";
import { createMockAdapter } from "./index.js";

test("mock adapter lists demo sessions", async () => {
  const adapter = createMockAdapter();

  const result = await adapter.call(
    {
      method: "sessions.list",
      raw: {
        jsonrpc: "2.0",
        id: "req_1",
        runtime: "mock",
        method: "sessions.list"
      }
    },
    {
      requestId: "req_1",
      traceId: "trace_test"
    }
  );

  assert.equal(typeof result, "object");
  assert.equal(Array.isArray((result as { sessions?: unknown }).sessions), true);
});

