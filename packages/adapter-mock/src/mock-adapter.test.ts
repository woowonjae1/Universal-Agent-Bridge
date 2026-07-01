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

test("mock adapter returns an A2UI demo surface", async () => {
  const adapter = createMockAdapter();

  const result = await adapter.call(
    {
      method: "ui.surface.demo",
      params: {
        title: "Review",
        status: "ready"
      },
      raw: {
        jsonrpc: "2.0",
        id: "req_2",
        runtime: "mock",
        method: "ui.surface.demo"
      }
    },
    {
      requestId: "req_2",
      traceId: "trace_test"
    }
  );

  assert.equal((result as { a2ui?: { type?: string } }).a2ui?.type, "createSurface");
  assert.equal((result as { a2ui?: { surfaceId?: string } }).a2ui?.surfaceId, "mock-agent-surface");
});
