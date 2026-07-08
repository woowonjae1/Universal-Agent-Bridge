import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  adapterStreamEventToAgUiEvents,
  createAgUiEvent,
  createBridgeRunEvents,
  encodeSseEvent,
  readBridgeRun,
  type AgUiEvent,
  type AgUiRunAgentInput
} from "@uab/ag-ui";
import type { AgentBridge, BridgePlan, BridgeResourcePatch, BridgeResourceWrite } from "@uab/core";
import {
  BRIDGE_ERROR_CODES,
  createErrorResponse
} from "@uab/protocol";

export interface HttpBridgeServerOptions {
  bridge: AgentBridge;
  rpcPath?: string;
  maxBodyBytes?: number;
  cors?: CorsOptions | false;
}

export interface ListenOptions {
  host?: string;
  port: number;
}

export interface CorsOptions {
  origin?: string;
  methods?: string[];
  headers?: string[];
}

export function createHttpBridgeServer(options: HttpBridgeServerOptions): Server {
  const rpcPath = options.rpcPath ?? "/rpc";
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;
  const cors = options.cors === false ? false : options.cors ?? {};

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      writeCorsHeaders(response, cors);

      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, {
          status: "ok",
          transport: "http"
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/health/runtimes") {
        sendJson(response, 200, await options.bridge.listHealth(url.searchParams.get("runtime") ?? undefined));
        return;
      }

      if (request.method === "GET" && url.pathname === "/runtimes") {
        sendJson(response, 200, await options.bridge.listRuntimes());
        return;
      }

      if (request.method === "GET" && url.pathname === "/methods") {
        const runtime = url.searchParams.get("runtime") ?? undefined;
        sendJson(response, 200, await options.bridge.listMethods(runtime));
        return;
      }

      if (request.method === "GET" && url.pathname === "/audit") {
        const limitParam = Number(url.searchParams.get("limit") ?? 50);
        const limit = Number.isFinite(limitParam) ? limitParam : 50;
        sendJson(response, 200, options.bridge.listAudit(limit));
        return;
      }

      if (request.method === "GET" && url.pathname === "/sessions") {
        sendJson(response, 200, options.bridge.listSessions());
        return;
      }

      if (request.method === "GET" && url.pathname === "/resources") {
        sendJson(response, 200, options.bridge.listResources({
          kind: readResourceKind(url.searchParams.get("kind")),
          runtime: url.searchParams.get("runtime") ?? undefined,
          sessionId: url.searchParams.get("sessionId") ?? url.searchParams.get("session") ?? undefined,
          limit: readNumber(url.searchParams.get("limit"))
        }));
        return;
      }

      if (request.method === "POST" && url.pathname === "/resources") {
        const payload = await readJsonBody(request, maxBodyBytes);
        sendJson(response, 201, options.bridge.createResource(readResourceWrite(payload)));
        return;
      }

      if (url.pathname.startsWith("/resources/")) {
        const resourceId = decodeURIComponent(url.pathname.slice("/resources/".length));
        if (request.method === "GET") {
          const payload = options.bridge.getResource(resourceId);
          sendJson(response, hasResource(payload) ? 200 : 404, payload);
          return;
        }
        if (request.method === "PATCH" || request.method === "PUT") {
          const payload = await readJsonBody(request, maxBodyBytes);
          const updated = options.bridge.updateResource(resourceId, readResourcePatch(payload));
          sendJson(response, hasResource(updated) ? 200 : 404, updated);
          return;
        }
        if (request.method === "DELETE") {
          sendJson(response, 200, {
            deleted: options.bridge.deleteResource(resourceId),
            resourceId
          });
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/metrics") {
        sendJson(response, 200, options.bridge.metrics());
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/traces/")) {
        const traceId = decodeURIComponent(url.pathname.slice("/traces/".length));
        sendJson(response, 200, options.bridge.getTrace(traceId));
        return;
      }

      if (request.method === "POST" && url.pathname === "/cancel") {
        const payload = await readJsonBody(request, maxBodyBytes);
        const requestId = readCancelRequestId(payload);
        sendJson(response, 200, {
          cancelled: options.bridge.cancel(requestId),
          requestId
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/broadcast") {
        const payload = await readJsonBody(request, maxBodyBytes);
        const { capability, bridgeRequest } = readBroadcast(payload);
        sendJson(response, 200, await options.bridge.broadcast(capability, bridgeRequest));
        return;
      }

      if (request.method === "GET" && url.pathname === "/plans") {
        sendJson(response, 200, options.bridge.listPlanRuns(readNumber(url.searchParams.get("limit"))));
        return;
      }

      if (request.method === "POST" && url.pathname === "/plans") {
        const payload = await readJsonBody(request, maxBodyBytes);
        sendJson(response, 202, options.bridge.startPlanRun(readPlan(payload)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/plans/run") {
        const payload = await readJsonBody(request, maxBodyBytes);
        sendJson(response, 200, await options.bridge.runPlan(readPlan(payload)));
        return;
      }

      if (request.method === "POST" && url.pathname === "/plans/run-template") {
        const payload = await readJsonBody(request, maxBodyBytes);
        if (!payload || typeof payload !== "object") {
          throw new Error("Invalid request body for run-template.");
        }
        const { plan, variables } = payload as any;
        if (!plan) throw new Error("Missing 'plan' field.");
        const instantiated = options.bridge.instantiatePlan(readPlan(plan), variables ?? {});
        sendJson(response, 200, await options.bridge.runPlan(instantiated));
        return;
      }

      if (url.pathname.startsWith("/plans/")) {
        const path = url.pathname.slice("/plans/".length);
        const [encodedRunId, action] = path.split("/");
        const runId = decodeURIComponent(encodedRunId ?? "");
        if (request.method === "GET" && runId && !action) {
          const payload = options.bridge.getPlanRun(runId);
          sendJson(response, hasPlanRun(payload) ? 200 : 404, payload);
          return;
        }
        if (request.method === "POST" && runId && action === "cancel") {
          sendJson(response, 200, {
            cancelled: options.bridge.cancelPlanRun(runId),
            runId
          });
          return;
        }
        if (request.method === "POST" && runId && action === "resume") {
          sendJson(response, 200, await options.bridge.resumePlanRun(runId));
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/agui/health") {
        sendJson(response, 200, {
          status: "ok",
          transport: "sse",
          endpoint: "/agui/runs"
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/agui/runs") {
        const payload = await readJsonBody(request, maxBodyBytes);
        await sendAgUiRun(request, response, options.bridge, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === rpcPath) {
        const payload = await readJsonBody(request, maxBodyBytes);
        const requestId = readBridgeRequestId(payload);
        const onClose = () => {
          if (requestId) options.bridge.cancel(requestId);
        };
        request.on("close", onClose);
        const bridgeResponse = await options.bridge.handleRequest(payload);
        request.off("close", onClose);
        sendJson(response, "error" in bridgeResponse ? 400 : 200, bridgeResponse);
        return;
      }

      sendJson(response, 404, {
        error: "Not found"
      });
    } catch (error) {
      sendJson(
        response,
        400,
        createErrorResponse({
          code: BRIDGE_ERROR_CODES.parseError,
          message: error instanceof Error ? error.message : "Invalid request body."
        })
      );
    }
  });
}

export function listen(server: Server, options: ListenOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload, null, 2));
}

async function sendAgUiRun(
  request: IncomingMessage,
  response: ServerResponse,
  bridge: AgentBridge,
  payload: unknown
): Promise<void> {
  writeSseHeaders(response);

  let descriptor: ReturnType<typeof readBridgeRun>;
  try {
    descriptor = readBridgeRun(payload);
  } catch (error) {
    await writeSse(response, createAgUiEvent({
      type: "RUN_ERROR",
      message: error instanceof Error ? error.message : "Invalid AG-UI run input.",
      code: "INVALID_AG_UI_INPUT"
    }));
    response.end();
    return;
  }

  const input = payload as AgUiRunAgentInput;
  const onClose = () => bridge.cancel(String(descriptor.request.id ?? descriptor.runId));
  request.on("close", onClose);

  await writeSse(response, createAgUiEvent({
    type: "RUN_STARTED",
    threadId: descriptor.threadId,
    runId: descriptor.runId,
    parentRunId: descriptor.parentRunId,
    input
  }));
  await writeSse(response, createAgUiEvent({
    type: "STATE_SNAPSHOT",
    snapshot: {
      bridge: "universal-agent-bridge",
      runtime: descriptor.runtime,
      method: descriptor.method,
      status: "calling"
    }
  }));
  await writeSse(response, createAgUiEvent({
    type: "CUSTOM",
    name: "uab.request",
    value: {
      runtime: descriptor.runtime,
      method: descriptor.method,
      params: descriptor.params,
      requestId: descriptor.request.id
    }
  }));
  await writeSse(response, createAgUiEvent({
    type: "STEP_STARTED",
    stepName: "bridge.call"
  }));

  if (bridge.registry.get(descriptor.runtime)?.stream) {
    await writeSse(response, createAgUiEvent({
      type: "TEXT_MESSAGE_START",
      messageId: `msg_${descriptor.runId}`,
      role: "assistant"
    }));

    let endedWithError = false;
    for await (const streamEvent of bridge.streamCall(descriptor.request)) {
      for (const agUiEvent of adapterStreamEventToAgUiEvents(streamEvent, descriptor)) {
        if (agUiEvent.type === "RUN_ERROR") {
          endedWithError = true;
        }
        await writeSse(response, agUiEvent);
      }
    }

    if (!endedWithError) {
      await writeSse(response, createAgUiEvent({
        type: "TEXT_MESSAGE_END",
        messageId: `msg_${descriptor.runId}`
      }));
    }
    request.off("close", onClose);
    response.end();
    return;
  }

  const bridgeResponse = await bridge.handleRequest(descriptor.request);
  const [, , , , ...tailEvents] = createBridgeRunEvents(input, descriptor, bridgeResponse);
  for (const event of tailEvents) {
    await writeSse(response, event);
  }
  request.off("close", onClose);
  response.end();
}

function writeSseHeaders(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.flushHeaders?.();
}

function writeSse(response: ServerResponse, event: AgUiEvent): Promise<void> {
  return new Promise((resolve) => {
    if (response.write(encodeSseEvent(event))) {
      resolve();
      return;
    }
    response.once("drain", resolve);
  });
}

function writeCorsHeaders(response: ServerResponse, cors: CorsOptions | false): void {
  if (cors === false) return;

  response.setHeader("access-control-allow-origin", cors.origin ?? "*");
  response.setHeader(
    "access-control-allow-methods",
    (cors.methods ?? ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"]).join(", ")
  );
  response.setHeader(
    "access-control-allow-headers",
    (cors.headers ?? ["content-type", "authorization"]).join(", ")
  );
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBodyBytes) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8");
  if (!body.trim()) {
    throw new Error("Request body is required.");
  }

  return JSON.parse(body);
}

function readBridgeRequestId(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const id = payload.id;
  if (typeof id === "string" || typeof id === "number") return String(id);
  return undefined;
}

function readCancelRequestId(payload: unknown): string {
  if (!isRecord(payload)) throw new Error("Cancel request body must be an object.");
  const value = payload.requestId ?? payload.id;
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error("Cancel request requires requestId.");
}

function readBroadcast(payload: unknown): { capability: string; bridgeRequest: Parameters<AgentBridge["broadcast"]>[1] } {
  if (!isRecord(payload)) throw new Error("Broadcast request body must be an object.");
  const capability = payload.capability;
  if (typeof capability !== "string" || capability.trim() === "") {
    throw new Error("Broadcast request requires capability.");
  }
  const bridgeRequest = payload.request;
  if (!isRecord(bridgeRequest)) {
    throw new Error("Broadcast request requires request.");
  }
  return {
    capability: capability.trim(),
    bridgeRequest: bridgeRequest as Parameters<AgentBridge["broadcast"]>[1]
  };
}

function readPlan(payload: unknown): BridgePlan {
  if (!isRecord(payload)) throw new Error("Plan request body must be an object.");
  if (!Array.isArray(payload.steps)) throw new Error("Plan request requires steps.");
  return payload as unknown as BridgePlan;
}

function readResourceWrite(payload: unknown): BridgeResourceWrite {
  if (!isRecord(payload)) throw new Error("Resource body must be an object.");
  if (payload.kind !== "memory" && payload.kind !== "artifact") {
    throw new Error("Resource kind must be 'memory' or 'artifact'.");
  }
  return payload as unknown as BridgeResourceWrite;
}

function readResourcePatch(payload: unknown): BridgeResourcePatch {
  if (!isRecord(payload)) throw new Error("Resource patch body must be an object.");
  if (payload.kind !== undefined && payload.kind !== "memory" && payload.kind !== "artifact") {
    throw new Error("Resource kind must be 'memory' or 'artifact'.");
  }
  return payload as unknown as BridgeResourcePatch;
}

function hasResource(payload: unknown): boolean {
  return isRecord(payload) && payload.resource !== null && payload.resource !== undefined;
}

function hasPlanRun(payload: unknown): boolean {
  return isRecord(payload) && payload.run !== null && payload.run !== undefined;
}

function readResourceKind(value: string | null): "memory" | "artifact" | undefined {
  if (value === "memory" || value === "artifact") return value;
  return undefined;
}

function readNumber(value: string | null): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
