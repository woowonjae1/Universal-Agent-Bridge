import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
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
import { handleOpenAiRequest } from "./openai-compat.js";

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

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      writeCorsHeaders(response, cors);

      // Handle OpenAI Assistants API endpoints
      if (await handleOpenAiRequest(request, response, url, options.bridge, maxBodyBytes)) {
        return;
      }

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

      if (request.method === "GET" && url.pathname === "/workspace/channels") {
        sendJson(response, 200, options.bridge.workspace.listChannels());
        return;
      }

      if (request.method === "POST" && url.pathname === "/workspace/channels") {
        const payload = await readJsonBody(request, maxBodyBytes) as any;
        if (!payload || typeof payload !== "object" || !payload.name) {
          throw new Error("Missing 'name' field for channel creation.");
        }
        const channel = options.bridge.workspace.createChannel(payload.name, payload.description);
        sendJson(response, 201, channel);
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/workspace/channels/") && url.pathname.endsWith("/messages")) {
        const parts = url.pathname.split("/");
        const channelId = parts[3];
        if (!channelId) throw new Error("Missing channelId.");
        const limit = readNumber(url.searchParams.get("limit")) ?? 50;
        sendJson(response, 200, options.bridge.workspace.getMessages(channelId, limit));
        return;
      }

      if (request.method === "POST" && url.pathname.startsWith("/workspace/channels/") && url.pathname.endsWith("/messages")) {
        const parts = url.pathname.split("/");
        const channelId = parts[3];
        if (!channelId) throw new Error("Missing channelId.");
        const payload = await readJsonBody(request, maxBodyBytes) as any;
        if (!payload || typeof payload !== "object" || !payload.content) {
          throw new Error("Missing 'content' field for posting message.");
        }
        const sender = payload.sender ?? { type: "user", id: "user_default", name: "User" };
        const userMsg = options.bridge.workspace.postMessage(channelId, sender, payload.content, payload.meta);
        
        const runtimes = Array.isArray(payload.runtimes) ? payload.runtimes : [];
        if (runtimes.length > 0) {
          options.bridge.coordinator.handleUserMessage(channelId, userMsg, runtimes).catch(err => {
            console.error("[WorkspaceCoordinator] Error running message cascade:", err);
          });
        }
        
        sendJson(response, 201, userMsg);
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/workspace/channels/") && url.pathname.includes("/artifacts")) {
        const parts = url.pathname.split("/");
        const channelId = parts[3];
        if (!channelId) throw new Error("Missing channelId.");
        
        if (url.pathname.endsWith("/artifacts")) {
          sendJson(response, 200, options.bridge.workspace.listArtifacts(channelId));
          return;
        }

        if (url.pathname.endsWith("/diff")) {
          const artifactId = decodeURIComponent(parts[5]);
          const from = Number(url.searchParams.get("from"));
          const to = Number(url.searchParams.get("to"));
          if (Number.isNaN(from) || Number.isNaN(to)) {
            throw new Error("Missing or invalid 'from' or 'to' version parameters.");
          }
          const diff = options.bridge.workspace.getArtifactDiff(channelId, artifactId, from, to);
          sendJson(response, 200, { diff });
          return;
        }

        const artifactId = decodeURIComponent(parts[5]);
        const artifact = options.bridge.workspace.getArtifact(channelId, artifactId);
        if (!artifact) {
          sendJson(response, 404, { error: `Artifact '${artifactId}' not found.` });
        } else {
          sendJson(response, 200, artifact);
        }
        return;
      }

      if (request.method === "POST" && url.pathname.startsWith("/workspace/channels/") && url.pathname.includes("/artifacts/")) {
        const parts = url.pathname.split("/");
        const channelId = parts[3];
        const artifactId = decodeURIComponent(parts[5]);
        if (!channelId || !artifactId) throw new Error("Missing channelId or artifactId.");

        const payload = await readJsonBody(request, maxBodyBytes) as any;
        if (!payload || typeof payload !== "object" || payload.content === undefined) {
          throw new Error("Missing 'content' field in artifact payload.");
        }
        const sender = payload.sender ?? { type: "system", id: "system_default", name: "System" };
        const artifact = options.bridge.workspace.saveArtifact(channelId, artifactId, sender, payload.content);
        sendJson(response, 201, artifact);
        return;
      }

      if (request.method === "GET" && url.pathname.startsWith("/workspace/channels/") && url.pathname.endsWith("/events")) {
        const parts = url.pathname.split("/");
        const channelId = parts[3];
        if (!channelId) throw new Error("Missing channelId.");
        
        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("cache-control", "no-cache");
        response.setHeader("connection", "keep-alive");
        response.write("event: subscription.established\ndata: {}\n\n");
        
        const unsubscribe = options.bridge.workspace.subscribe(channelId, (event) => {
          response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        });
        
        request.on("close", () => {
          unsubscribe();
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

  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws: any, request: any, channelId: any) => {
    const unsubscribe = options.bridge.workspace.subscribe(channelId, (event) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify(event));
      }
    });

    ws.on("message", async (data: any) => {
      try {
        const payload = JSON.parse(data.toString());
        if (payload.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
          return;
        }

        if (payload.content) {
          const sender = payload.sender ?? { type: "user", id: "ws_user", name: "WebSocket User" };
          const userMsg = options.bridge.workspace.postMessage(channelId, sender, payload.content, payload.meta);

          const runtimes = Array.isArray(payload.runtimes) ? payload.runtimes : [];
          if (runtimes.length > 0) {
            options.bridge.coordinator.handleUserMessage(channelId, userMsg, runtimes).catch(err => {
              console.error("[WorkspaceCoordinator WS] Error running message cascade:", err);
            });
          }
        }
      } catch (err) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : String(err)
          }));
        }
      }
    });

    ws.on("close", () => unsubscribe());
    ws.on("error", () => unsubscribe());
  });

  server.on("upgrade", (request: any, socket: any, head: any) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/workspace/channels/")) {
      const parts = url.pathname.split("/");
      const channelId = parts[3];
      if (channelId) {
        wss.handleUpgrade(request, socket, head, (ws: any) => {
          wss.emit("connection", ws, request, channelId);
        });
        return;
      }
    }
    socket.destroy();
  });

  return server;
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
