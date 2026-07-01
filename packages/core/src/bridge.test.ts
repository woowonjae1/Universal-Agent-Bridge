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

