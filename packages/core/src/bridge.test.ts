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

test("binds sessions to runtimes and reuses sticky routing", async () => {
  const seen: Array<{ runtime: string | undefined; session: string | undefined }> = [];
  const bridge = new AgentBridge();
  bridge.register({
    ...adapter,
    call(request, context) {
      seen.push({
        runtime: request.raw.runtime,
        session: context.session?.id
      });
      return { runtime: request.raw.runtime, session: context.session?.id };
    }
  });

  await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "session_1_first",
    runtime: "test",
    session: { id: "session_1", action: "create" },
    method: "system.ping"
  });

  const second = await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "session_1_second",
    session: { id: "session_1", action: "resume" },
    method: "system.ping"
  });

  assert.deepEqual(seen, [
    { runtime: "test", session: "session_1" },
    { runtime: "test", session: "session_1" }
  ]);
  assert.deepEqual("result" in second ? second.result : undefined, {
    runtime: "test",
    session: "session_1"
  });
});

test("rejects switching an existing session to another runtime", async () => {
  const bridge = new AgentBridge();
  bridge.register(adapter);
  bridge.register({
    ...adapter,
    info: {
      id: "other",
      name: "Other Runtime"
    }
  });

  await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "session_switch_first",
    runtime: "test",
    session: { id: "session_switch" },
    method: "system.ping"
  });

  const response = await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "session_switch_second",
    runtime: "other",
    session: { id: "session_switch" },
    method: "system.ping"
  });

  assert.equal("error" in response, true);
  assert.match("error" in response ? response.error.message : "", /already bound/);
});

test("passes abort signals and times out long calls", async () => {
  const bridge = new AgentBridge({
    defaultTimeoutMs: 25
  });
  bridge.register({
    ...adapter,
    async call(_request, context) {
      await new Promise<void>((resolve, reject) => {
        context.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted by signal"), { code: -32005 }));
        }, { once: true });
        setTimeout(resolve, 500);
      });
      return { done: true };
    }
  });

  const response = await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "timeout_req",
    runtime: "test",
    method: "system.slow"
  });

  assert.equal("error" in response, true);
  assert.equal("error" in response ? response.error.code : undefined, -32005);
});

test("can cancel an active bridge call by request id", async () => {
  const bridge = new AgentBridge();
  bridge.register({
    ...adapter,
    async call(_request, context) {
      await new Promise<void>((resolve, reject) => {
        context.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("cancelled"), { code: -32005 }));
        }, { once: true });
        setTimeout(resolve, 500);
      });
      return { done: true };
    }
  });

  const pending = bridge.handleRequest({
    jsonrpc: "2.0",
    id: "cancel_req",
    runtime: "test",
    method: "system.slow"
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(bridge.cancel("cancel_req"), true);
  const response = await pending;
  assert.equal("error" in response, true);
  assert.equal("error" in response ? response.error.message : undefined, "cancelled");
});

test("limits concurrent calls globally", async () => {
  const bridge = new AgentBridge({
    maxConcurrentCalls: 1
  });
  let active = 0;
  let maxActive = 0;
  bridge.register({
    ...adapter,
    async call() {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return { ok: true };
    }
  });

  await Promise.all([
    bridge.handleRequest({ jsonrpc: "2.0", id: "c1", runtime: "test", method: "system.ping" }),
    bridge.handleRequest({ jsonrpc: "2.0", id: "c2", runtime: "test", method: "system.ping" })
  ]);

  assert.equal(maxActive, 1);
});
