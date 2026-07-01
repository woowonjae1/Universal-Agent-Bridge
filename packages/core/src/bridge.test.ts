import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

test("indexes memory and artifact resources from adapter responses", async () => {
  const bridge = new AgentBridge();
  bridge.register({
    ...adapter,
    call(request) {
      if (request.method === "memory.listFiles") {
        return {
          files: [
            { id: "mem_1", kind: "memory", path: "memory/project.md", sizeBytes: 128 }
          ]
        };
      }
      return {
        artifacts: [
          { artifact_id: "art_1", title: "Plan", mimeType: "text/markdown" }
        ]
      };
    }
  });

  await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "resource_memory",
    runtime: "test",
    method: "memory.listFiles",
    session: { id: "resource_session" },
    meta: { traceId: "trace_resources" }
  });
  await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "resource_artifact",
    runtime: "test",
    method: "artifacts.list",
    session: { id: "resource_session" },
    meta: { traceId: "trace_resources" }
  });

  const resources = bridge.listResources({ sessionId: "resource_session" }) as {
    resources: Array<{ kind: string; runtime: string; traceId: string; name?: string }>;
  };
  assert.deepEqual(resources.resources.map((resource) => resource.kind).sort(), ["artifact", "memory"]);
  assert.equal(resources.resources[0].runtime, "test");

  const trace = bridge.getTrace("trace_resources") as {
    audit: unknown[];
    resources: Array<{ kind: string }>;
  };
  assert.equal(trace.audit.length, 2);
  assert.equal(trace.resources.length, 2);
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

test("persists sessions audit and resources to a JSON store", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uab-state-"));
  const statePath = join(dir, "state.json");
  const first = new AgentBridge({ persistencePath: statePath });
  first.register({
    ...adapter,
    call() {
      return {
        artifacts: [
          { id: "artifact_persisted", kind: "artifact", name: "Persisted artifact" }
        ]
      };
    }
  });

  await first.handleRequest({
    jsonrpc: "2.0",
    id: "persist_req",
    runtime: "test",
    session: { id: "persist_session" },
    method: "artifacts.list",
    meta: { traceId: "trace_persist" }
  });

  const persisted = JSON.parse(await readFile(statePath, "utf8")) as {
    sessions: unknown[];
    audit: unknown[];
    resources: unknown[];
  };
  assert.equal(persisted.sessions.length, 1);
  assert.equal(persisted.audit.length, 1);
  assert.equal(persisted.resources.length, 1);

  const second = new AgentBridge({ persistencePath: statePath });
  const sessions = second.listSessions() as { sessions: Array<{ id: string; runtime: string }> };
  const resources = second.listResources({ kind: "artifact" }) as { resources: Array<{ id: string }> };
  const trace = second.getTrace("trace_persist") as { audit: unknown[]; resources: unknown[] };

  assert.deepEqual(sessions.sessions.map((session) => session.id), ["persist_session"]);
  assert.equal(resources.resources[0].id, "artifact:test:persist_session:artifact_persisted");
  assert.equal(trace.audit.length, 1);
  assert.equal(trace.resources.length, 1);
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

test("times out calls even when adapters ignore abort signals", async () => {
  const bridge = new AgentBridge({
    defaultTimeoutMs: 25
  });
  bridge.register({
    ...adapter,
    call() {
      return new Promise(() => undefined);
    }
  });

  const startedAt = Date.now();
  const response = await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "non_cooperative_timeout",
    runtime: "test",
    method: "system.hang"
  });

  assert.equal("error" in response, true);
  assert.equal("error" in response ? response.error.code : undefined, -32005);
  assert.match("error" in response ? response.error.message : "", /timed out/);
  assert.ok(Date.now() - startedAt < 250);
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

test("can cancel non-cooperative adapter calls by request id", async () => {
  const bridge = new AgentBridge();
  bridge.register({
    ...adapter,
    call() {
      return new Promise(() => undefined);
    }
  });

  const pending = bridge.handleRequest({
    jsonrpc: "2.0",
    id: "non_cooperative_cancel",
    runtime: "test",
    method: "system.hang"
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(bridge.cancel("non_cooperative_cancel"), true);
  const response = await pending;
  assert.equal("error" in response, true);
  assert.equal("error" in response ? response.error.code : undefined, -32005);
  assert.match("error" in response ? response.error.message : "", /cancelled/);
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
  const metrics = bridge.metrics() as {
    calls: number;
    errors: number;
    runtimes: Array<{ runtime: string; calls: number }>;
  };
  assert.equal(metrics.calls, 2);
  assert.equal(metrics.errors, 0);
  assert.equal(metrics.runtimes[0].runtime, "test");
});

test("times out queued calls without consuming concurrency slots", async () => {
  const bridge = new AgentBridge({
    maxConcurrentCalls: 1
  });
  let started = 0;
  bridge.register({
    ...adapter,
    async call(request) {
      started += 1;
      if (request.method === "system.block") {
        await new Promise(() => undefined);
      }
      return { ok: true };
    }
  });

  const blocking = bridge.handleRequest({
    jsonrpc: "2.0",
    id: "queue_blocking",
    runtime: "test",
    method: "system.block"
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  const queued = await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "queue_timeout",
    runtime: "test",
    method: "system.ping",
    meta: { timeoutMs: 25 }
  });

  assert.equal("error" in queued, true);
  assert.equal("error" in queued ? queued.error.code : undefined, -32005);
  assert.equal(started, 1);
  assert.equal(bridge.cancel("queue_blocking"), true);
  await blocking;
});
