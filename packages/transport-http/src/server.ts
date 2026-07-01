import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AgentBridge } from "@uab/core";
import {
  BRIDGE_ERROR_CODES,
  createErrorResponse
} from "@uab/protocol";

export interface HttpBridgeServerOptions {
  bridge: AgentBridge;
  rpcPath?: string;
  maxBodyBytes?: number;
}

export interface ListenOptions {
  host?: string;
  port: number;
}

export function createHttpBridgeServer(options: HttpBridgeServerOptions): Server {
  const rpcPath = options.rpcPath ?? "/rpc";
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024;

  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { status: "ok" });
        return;
      }

      if (request.method === "GET" && url.pathname === "/runtimes") {
        sendJson(response, 200, await options.bridge.listRuntimes());
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

