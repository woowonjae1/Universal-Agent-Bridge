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
import type { AgentBridge } from "@uab/core";
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
        await sendAgUiRun(response, options.bridge, payload);
        return;
      }

      if (request.method === "POST" && url.pathname === rpcPath) {
        const payload = await readJsonBody(request, maxBodyBytes);
        const bridgeResponse = await options.bridge.handleRequest(payload);
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
  response: ServerResponse,
  bridge: AgentBridge,
  payload: unknown
): Promise<void> {
  writeSseHeaders(response);

  let descriptor: ReturnType<typeof readBridgeRun>;
  try {
    descriptor = readBridgeRun(payload);
  } catch (error) {
    writeSse(response, createAgUiEvent({
      type: "RUN_ERROR",
      message: error instanceof Error ? error.message : "Invalid AG-UI run input.",
      code: "INVALID_AG_UI_INPUT"
    }));
    response.end();
    return;
  }

  const input = payload as AgUiRunAgentInput;
  writeSse(response, createAgUiEvent({
    type: "RUN_STARTED",
    threadId: descriptor.threadId,
    runId: descriptor.runId,
    parentRunId: descriptor.parentRunId,
    input
  }));
  writeSse(response, createAgUiEvent({
    type: "STATE_SNAPSHOT",
    snapshot: {
      bridge: "universal-agent-bridge",
      runtime: descriptor.runtime,
      method: descriptor.method,
      status: "calling"
    }
  }));
  writeSse(response, createAgUiEvent({
    type: "CUSTOM",
    name: "uab.request",
    value: {
      runtime: descriptor.runtime,
      method: descriptor.method,
      params: descriptor.params,
      requestId: descriptor.request.id
    }
  }));
  writeSse(response, createAgUiEvent({
    type: "STEP_STARTED",
    stepName: "bridge.call"
  }));

  if (bridge.registry.get(descriptor.runtime)?.stream) {
    writeSse(response, createAgUiEvent({
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
        writeSse(response, agUiEvent);
      }
    }

    if (!endedWithError) {
      writeSse(response, createAgUiEvent({
        type: "TEXT_MESSAGE_END",
        messageId: `msg_${descriptor.runId}`
      }));
    }
    response.end();
    return;
  }

  const bridgeResponse = await bridge.handleRequest(descriptor.request);
  const [, , , , ...tailEvents] = createBridgeRunEvents(input, descriptor, bridgeResponse);
  for (const event of tailEvents) {
    writeSse(response, event);
  }
  response.end();
}

function writeSseHeaders(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.flushHeaders?.();
}

function writeSse(response: ServerResponse, event: AgUiEvent): void {
  response.write(encodeSseEvent(event));
}

function writeCorsHeaders(response: ServerResponse, cors: CorsOptions | false): void {
  if (cors === false) return;

  response.setHeader("access-control-allow-origin", cors.origin ?? "*");
  response.setHeader(
    "access-control-allow-methods",
    (cors.methods ?? ["GET", "POST", "OPTIONS"]).join(", ")
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
