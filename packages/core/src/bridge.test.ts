import assert from "node:assert/strict";
import test from "node:test";
import { AgentBridge, ScopeAccessPolicy } from "./index.js";
import type { AgentRuntimeAdapter } from "@uab/adapter-sdk";

const adapter: AgentRuntimeAdapter = {
  info: {
    id: "test",
    name: "Test Runtime"
  },
  capabilities() {
    return {
      system: { read: true }
    };
  },
  call(request) {
    if (request.method === "system.ping") {
      return { pong: true };
    }
    return { method: request.method };
  }
};

test("routes bridge requests to registered adapters", async () => {
  const bridge = new AgentBridge();
  bridge.register(adapter);

  const response = await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "req_1",
    runtime: "test",
    method: "system.ping",
    params: {}
  });

  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.id, "req_1");
  assert.deepEqual("result" in response ? response.result : undefined, {
    pong: true
  });
});

test("returns runtimeNotFound when no adapter is registered", async () => {
  const bridge = new AgentBridge();

  const response = await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "req_2",
    runtime: "missing",
    method: "system.ping"
  });

  assert.equal("error" in response, true);
  assert.equal("error" in response ? response.error.code : undefined, -32001);
});

test("scope policy denies calls without matching scope", async () => {
  const bridge = new AgentBridge({
    accessPolicy: new ScopeAccessPolicy()
  });
  bridge.register(adapter);

  const response = await bridge.handleRequest(
    {
      jsonrpc: "2.0",
      id: "req_3",
      runtime: "test",
      method: "system.ping"
    },
    { id: "user_1", scopes: ["sessions:read"] }
  );

  assert.equal("error" in response, true);
  assert.equal("error" in response ? response.error.code : undefined, -32003);
});

test("records audit entries for routed calls", async () => {
  const bridge = new AgentBridge();
  bridge.register(adapter);

  await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "req_4",
    runtime: "test",
    method: "system.ping",
    meta: {
      traceId: "trace_req_4",
      source: "test"
    }
  });

  const audit = bridge.listAudit(1) as {
    entries: Array<{ runtime: string; method: string; status: string; traceId: string }>;
  };

  assert.equal(audit.entries.length, 1);
  assert.equal(audit.entries[0].runtime, "test");
  assert.equal(audit.entries[0].method, "system.ping");
  assert.equal(audit.entries[0].status, "success");
  assert.equal(audit.entries[0].traceId, "trace_req_4");
});

test("lists runtime method catalog", async () => {
  const bridge = new AgentBridge();
  bridge.register({
    ...adapter,
    methods() {
      return [
        {
          name: "system.ping",
          capability: "system",
          risk: "read",
          paramsExample: {}
        }
      ];
    }
  });

  const catalog = await bridge.listMethods("test") as {
    runtimes: Array<{ runtime: string; methods: Array<{ name: string }> }>;
  };

  assert.equal(catalog.runtimes.length, 1);
  assert.equal(catalog.runtimes[0].runtime, "test");
  assert.equal(catalog.runtimes[0].methods[0].name, "system.ping");
});
