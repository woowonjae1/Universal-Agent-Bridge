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
  await first.flushPersistence();

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

test("resources support bridge-owned CRUD operations", () => {
  const bridge = new AgentBridge();
  const created = bridge.createResource({
    kind: "memory",
    runtime: "manual",
    name: "Operator note",
    data: { text: "remember this" }
  }) as { resource: { id: string; name: string } };

  const fetched = bridge.getResource(created.resource.id) as { resource: { id: string; name: string } | null };
  const updated = bridge.updateResource(created.resource.id, {
    name: "Updated note"
  }) as { resource: { id: string; name: string } | null };
  const deleted = bridge.deleteResource(created.resource.id);
  const missing = bridge.getResource(created.resource.id) as { resource: unknown };

  assert.equal(fetched.resource?.name, "Operator note");
  assert.equal(updated.resource?.name, "Updated note");
  assert.equal(deleted, true);
  assert.equal(missing.resource, null);
});

test("persistence writes are batched until flush", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uab-state-batch-"));
  const statePath = join(dir, "state.json");
  const bridge = new AgentBridge({
    persistencePath: statePath,
    persistenceFlushMs: 60_000
  });
  bridge.register(adapter);

  await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "batch_req",
    runtime: "test",
    method: "system.ping"
  });

  await assert.rejects(readFile(statePath, "utf8"));
  await bridge.flushPersistence();
  const persisted = JSON.parse(await readFile(statePath, "utf8")) as { audit: unknown[] };
  assert.equal(persisted.audit.length, 1);
});

test("exports dependency-free spans for audit entries", async () => {
  const spans: Array<{ name: string; traceId: string; status: string; attributes: Record<string, unknown> }> = [];
  const bridge = new AgentBridge({
    spanExporter: {
      export(span) {
        spans.push(span);
      }
    }
  });
  bridge.register(adapter);

  await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "span_req",
    runtime: "test",
    method: "system.ping",
    meta: { traceId: "trace_span" }
  });

  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, "uab.system.ping");
  assert.equal(spans[0].traceId, "trace_span");
  assert.equal(spans[0].status, "ok");
  assert.equal(spans[0].attributes["uab.runtime"], "test");
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

function chatAdapter(id: string, handler: (method: string) => unknown): AgentRuntimeAdapter {
  return {
    info: { id, name: id },
    capabilities() {
      return { chat: { write: true, methods: ["chat.send"] } };
    },
    call(request) {
      return handler(request.method);
    }
  };
}

test("capability routing dispatches to a runtime advertising the capability", async () => {
  const bridge = new AgentBridge();
  bridge.register(chatAdapter("alpha", () => ({ from: "alpha" })));

  const response = await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "cap_1",
    capability: "chat",
    method: "chat.send",
    params: { text: "hi" }
  });

  assert.deepEqual("result" in response ? response.result : undefined, { from: "alpha" });
});

test("capability routing fails over from an unavailable runtime to a healthy one", async () => {
  const bridge = new AgentBridge();
  // First registered → first in the initial round-robin order, and it fails.
  bridge.register(chatAdapter("broken", () => {
    throw { code: -32004, message: "runtime down" };
  }));
  bridge.register(chatAdapter("healthy", () => ({ from: "healthy" })));

  const response = await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "cap_failover",
    capability: "chat",
    method: "chat.send"
  });

  assert.deepEqual("result" in response ? response.result : undefined, { from: "healthy" });
});

test("capability routing returns runtimeNotFound when no runtime matches", async () => {
  const bridge = new AgentBridge();
  bridge.register(chatAdapter("alpha", () => ({})));

  const response = await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "cap_missing",
    capability: "video",
    method: "video.render"
  });

  assert.equal("error" in response ? response.error.code : undefined, -32001);
});

test("circuit breaker opens after repeated failures and fast-fails", async () => {
  let calls = 0;
  const bridge = new AgentBridge({ circuitBreaker: { failureThreshold: 2, cooldownMs: 60_000 } });
  bridge.register({
    info: { id: "flaky", name: "flaky" },
    capabilities() {
      return { system: { read: true } };
    },
    call() {
      calls += 1;
      throw { code: -32004, message: "down" };
    }
  });

  const request = { jsonrpc: "2.0" as const, runtime: "flaky", method: "system.ping" };
  await bridge.handleRequest({ ...request, id: "cb_1" });
  await bridge.handleRequest({ ...request, id: "cb_2" });
  const third = await bridge.handleRequest({ ...request, id: "cb_3" });

  assert.equal(calls, 2, "adapter should not be invoked once the circuit is open");
  assert.equal("error" in third ? third.error.code : undefined, -32004);
  assert.match("error" in third ? third.error.message : "", /circuit open/);
});

test("retry recovers a transient failure within the same runtime", async () => {
  let calls = 0;
  const bridge = new AgentBridge({ maxAttempts: 2, retryBackoffMs: 1 });
  bridge.register({
    info: { id: "transient", name: "transient" },
    capabilities() {
      return { system: { read: true } };
    },
    call() {
      calls += 1;
      if (calls === 1) throw { code: -32004, message: "warming up" };
      return { ok: true };
    }
  });

  const response = await bridge.handleRequest({
    jsonrpc: "2.0",
    id: "retry_1",
    runtime: "transient",
    method: "system.ping"
  });

  assert.equal(calls, 2);
  assert.deepEqual("result" in response ? response.result : undefined, { ok: true });
});

test("broadcast fans out to every runtime advertising the capability", async () => {
  const bridge = new AgentBridge();
  bridge.register(chatAdapter("alpha", () => ({ from: "alpha" })));
  bridge.register(chatAdapter("beta", () => ({ from: "beta" })));

  const result = await bridge.broadcast("chat", {
    jsonrpc: "2.0",
    id: "bc_1",
    method: "chat.send"
  }) as { capability: string; results: Array<{ runtime: string }> };

  assert.equal(result.capability, "chat");
  assert.equal(result.results.length, 2);
  assert.deepEqual(result.results.map((entry) => entry.runtime).sort(), ["alpha", "beta"]);
});

test("plan execution supports runtime handoff between steps", async () => {
  const calls: string[] = [];
  const bridge = new AgentBridge();
  bridge.register(chatAdapter("alpha", (method) => {
    calls.push(`alpha:${method}`);
    return { runtime: "alpha", method };
  }));

  const result = await bridge.runPlan({
    id: "handoff_plan",
    steps: [
      {
        id: "first",
        capability: "chat",
        method: "chat.send",
        params: { text: "draft" }
      },
      {
        id: "second",
        handoff: true,
        method: "chat.followup",
        params: { text: "continue" }
      }
    ]
  }) as {
    status: string;
    steps: Array<{ runtime?: string; response: { result?: { method?: string } } }>;
  };

  assert.equal(result.status, "success");
  assert.deepEqual(calls, ["alpha:chat.send", "alpha:chat.followup"]);
  assert.deepEqual(result.steps.map((step) => step.runtime), ["alpha", "alpha"]);
  assert.equal(result.steps[1].response.result?.method, "chat.followup");
});

test("plan handoff follows the successful failover runtime", async () => {
  const calls: string[] = [];
  const bridge = new AgentBridge();
  bridge.register(chatAdapter("broken", (method) => {
    calls.push(`broken:${method}`);
    throw { code: -32004, message: "runtime down" };
  }));
  bridge.register(chatAdapter("healthy", (method) => {
    calls.push(`healthy:${method}`);
    return { runtime: "healthy", method };
  }));

  const result = await bridge.runPlan({
    id: "handoff_failover_plan",
    steps: [
      {
        id: "first",
        capability: "chat",
        method: "chat.send"
      },
      {
        id: "second",
        handoff: true,
        method: "chat.followup"
      }
    ]
  }) as {
    status: string;
    steps: Array<{ runtime?: string; response: { result?: { runtime?: string; method?: string } } }>;
  };

  assert.equal(result.status, "success");
  assert.deepEqual(calls, ["broken:chat.send", "healthy:chat.send", "healthy:chat.followup"]);
  assert.deepEqual(result.steps.map((step) => step.runtime), ["healthy", "healthy"]);
  assert.equal(result.steps[1].response.result?.runtime, "healthy");
});

test("plan execution passes prior step output into later params", async () => {
  const received: unknown[] = [];
  const bridge = new AgentBridge();
  bridge.register({
    info: { id: "pipeline", name: "Pipeline Runtime" },
    capabilities() {
      return { pipeline: { write: true, methods: ["extract", "process"] } };
    },
    call(request) {
      received.push(request.params);
      if (request.method === "extract") {
        return { value: "alpha", items: [1, 2], nested: { ok: true } };
      }
      return { received: request.params };
    }
  });

  const result = await bridge.runPlan({
    id: "dataflow_plan",
    steps: [
      {
        id: "extract",
        runtime: "pipeline",
        method: "extract",
        params: { source: "input" }
      },
      {
        id: "process",
        runtime: "pipeline",
        method: "process",
        params: {
          value: "${steps.extract.result.value}",
          items: "${steps.extract.result.items}",
          nested: "${steps.extract.result.nested}",
          text: "selected=${steps.extract.result.value}"
        }
      }
    ]
  }) as {
    status: string;
    steps: Array<{ response: { result?: { received?: unknown } } }>;
  };

  assert.equal(result.status, "success");
  assert.deepEqual(received[1], {
    value: "alpha",
    items: [1, 2],
    nested: { ok: true },
    text: "selected=alpha"
  });
  assert.deepEqual(result.steps[1].response.result?.received, received[1]);
});

test("plan execution skips steps when declarative conditions do not match", async () => {
  const calls: string[] = [];
  const bridge = new AgentBridge();
  bridge.register({
    info: { id: "router", name: "Router Runtime" },
    capabilities() {
      return { pipeline: { write: true, methods: ["classify", "selected", "skipped"] } };
    },
    call(request) {
      calls.push(request.method);
      if (request.method === "classify") return { route: "selected" };
      return { method: request.method };
    }
  });

  const result = await bridge.runPlan({
    id: "conditional_plan",
    steps: [
      { id: "classify", runtime: "router", method: "classify" },
      {
        id: "selected",
        runtime: "router",
        method: "selected",
        when: { ref: "steps.classify.result.route", equals: "selected" }
      },
      {
        id: "skipped",
        runtime: "router",
        method: "skipped",
        when: { ref: "steps.classify.result.route", equals: "other" }
      }
    ]
  }) as {
    status: string;
    steps: Array<{ status: string; response: { result?: { skipped?: boolean } } }>;
  };

  assert.equal(result.status, "success");
  assert.deepEqual(calls, ["classify", "selected"]);
  assert.deepEqual(result.steps.map((step) => step.status), ["success", "success", "skipped"]);
  assert.equal(result.steps[2].response.result?.skipped, true);
});

test("plan execution runs adjacent parallel groups concurrently and joins their outputs", async () => {
  let active = 0;
  let maxActive = 0;
  const bridge = new AgentBridge();
  bridge.register({
    info: { id: "worker", name: "Worker Runtime" },
    capabilities() {
      return { pipeline: { write: true, methods: ["fetch.a", "fetch.b", "merge"] } };
    },
    async call(request) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (request.method !== "merge") {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { value: request.method };
        }
        return { merged: request.params };
      } finally {
        active -= 1;
      }
    }
  });

  const result = await bridge.runPlan({
    id: "parallel_plan",
    steps: [
      {
        id: "left",
        parallelGroup: "fanout",
        runtime: "worker",
        method: "fetch.a"
      },
      {
        id: "right",
        parallelGroup: "fanout",
        runtime: "worker",
        method: "fetch.b"
      },
      {
        id: "merge",
        runtime: "worker",
        method: "merge",
        params: {
          left: "${steps.left.result.value}",
          right: "${steps.right.result.value}"
        }
      }
    ]
  }) as {
    status: string;
    steps: Array<{ response: { result?: { merged?: unknown } } }>;
  };

  assert.equal(result.status, "success");
  assert.equal(maxActive, 2);
  assert.deepEqual(result.steps[2].response.result?.merged, {
    left: "fetch.a",
    right: "fetch.b"
  });
});

test("plan runs are persisted and queryable by run id", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uab-plan-state-"));
  const statePath = join(dir, "state.json");
  const bridge = new AgentBridge({ persistencePath: statePath });
  bridge.register(chatAdapter("alpha", (method) => ({ method })));

  const result = await bridge.runPlan({
    id: "persisted_plan",
    steps: [
      {
        id: "first",
        runtime: "alpha",
        method: "chat.send"
      }
    ]
  }) as { runId: string; status: string };
  await bridge.flushPersistence();

  const second = new AgentBridge({ persistencePath: statePath });
  const fetched = second.getPlanRun(result.runId) as {
    run: { id: string; status: string; steps: Array<{ status: string }> } | null;
  };

  assert.equal(result.status, "success");
  assert.equal(fetched.run?.id, "persisted_plan");
  assert.equal(fetched.run?.status, "succeeded");
  assert.deepEqual(fetched.run?.steps.map((step) => step.status), ["success"]);
});

test("persisted in-flight plan runs reload as resumable pending runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "uab-plan-inflight-"));
  const statePath = join(dir, "state.json");
  const bridge = new AgentBridge({ persistencePath: statePath });
  bridge.register({
    info: { id: "slow", name: "Slow Runtime" },
    capabilities() {
      return { pipeline: { write: true } };
    },
    async call(_request, context) {
      await new Promise<void>((resolve, reject) => {
        context.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("cancelled"), { code: -32005 }));
        }, { once: true });
        setTimeout(resolve, 500);
      });
      return { ok: true };
    }
  });

  bridge.startPlanRun({
    id: "restart_plan",
    steps: [
      { id: "slow", runtime: "slow", method: "work" }
    ]
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await bridge.flushPersistence();

  const reloaded = new AgentBridge({ persistencePath: statePath });
  const snapshot = reloaded.getPlanRun("restart_plan") as {
    run: { status: string; steps: Array<{ status: string }> } | null;
  };

  assert.equal(snapshot.run?.status, "pending");
  assert.deepEqual(snapshot.run?.steps.map((step) => step.status), ["pending"]);
  assert.equal(bridge.cancelPlanRun("restart_plan"), true);
});

test("DAG plan mode runs independent steps concurrently and waits for dependencies", async () => {
  let active = 0;
  let maxActive = 0;
  const bridge = new AgentBridge();
  bridge.register({
    info: { id: "dag", name: "DAG Runtime" },
    capabilities() {
      return { pipeline: { write: true } };
    },
    async call(request) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (request.method !== "merge") {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return { value: request.method };
        }
        return { merged: request.params };
      } finally {
        active -= 1;
      }
    }
  });

  const result = await bridge.runPlan({
    id: "dag_plan",
    mode: "dag",
    steps: [
      { id: "left", runtime: "dag", method: "left" },
      { id: "right", runtime: "dag", method: "right" },
      {
        id: "merge",
        dependsOn: ["left", "right"],
        runtime: "dag",
        method: "merge",
        params: {
          left: "${steps.left.result.value}",
          right: "${steps.right.result.value}"
        }
      }
    ]
  }) as {
    status: string;
    steps: Array<{ response: { result?: { merged?: unknown } } }>;
  };

  assert.equal(result.status, "success");
  assert.equal(maxActive, 2);
  assert.deepEqual(result.steps[2].response.result?.merged, {
    left: "left",
    right: "right"
  });
});

test("plan-level cancellation aborts running steps and marks the run cancelled", async () => {
  const bridge = new AgentBridge();
  bridge.register({
    info: { id: "slow", name: "Slow Runtime" },
    capabilities() {
      return { pipeline: { write: true } };
    },
    async call(_request, context) {
      await new Promise<void>((resolve, reject) => {
        context.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("plan cancelled"), { code: -32005 }));
        }, { once: true });
        setTimeout(resolve, 500);
      });
      return { ok: true };
    }
  });

  bridge.startPlanRun({
    id: "cancel_plan",
    steps: [
      { id: "slow", runtime: "slow", method: "work" }
    ]
  });
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(bridge.cancelPlanRun("cancel_plan"), true);
  await new Promise((resolve) => setTimeout(resolve, 40));

  const snapshot = bridge.getPlanRun("cancel_plan") as {
    run: { status: string; steps: Array<{ status: string; response?: { error?: { message: string } } }> } | null;
  };
  assert.equal(snapshot.run?.status, "cancelled");
  assert.equal(snapshot.run?.steps[0].status, "cancelled");
});

test("plan template references fail fast when a prior output is missing", async () => {
  const bridge = new AgentBridge();
  bridge.register(chatAdapter("alpha", () => ({ ok: true })));

  const result = await bridge.runPlan({
    id: "missing_ref_plan",
    steps: [
      {
        id: "first",
        runtime: "alpha",
        method: "chat.send",
        params: {
          value: "${steps.unknown.result.value}"
        }
      }
    ]
  }) as {
    status: string;
    steps: Array<{ status: string; response: { error?: { code: number; message: string } } }>;
  };

  assert.equal(result.status, "error");
  assert.equal(result.steps[0].status, "error");
  assert.equal(result.steps[0].response.error?.code, -32600);
  assert.match(result.steps[0].response.error?.message ?? "", /steps\.unknown\.result\.value/);
});
