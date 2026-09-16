import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentBridge } from "@uab/core";

export function sendJson(response: ServerResponse, statusCode: number, payload: unknown) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

async function readJsonBody(request: IncomingMessage, maxBodyBytes: number): Promise<any> {
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
  return body.trim() ? JSON.parse(body) : {};
}

/**
 * Main request router for OpenAI compatibility endpoint (/v1/*)
 * Returns true if request was handled, false otherwise.
 */
export async function handleOpenAiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  bridge: AgentBridge,
  maxBodyBytes: number
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/v1/")) {
    return false;
  }

  try {
    // 1. GET /v1/assistants
    if (request.method === "GET" && path === "/v1/assistants") {
      const runtimesResult = (await bridge.listRuntimes()) as any;
      const assistants = (runtimesResult?.runtimes ?? []).map((r: any) => ({
        id: r.id,
        object: "assistant",
        created_at: Math.floor(Date.now() / 1000),
        name: r.name ?? r.id,
        description: r.description ?? "",
        model: "default",
        instructions: "",
        tools: [],
        metadata: {}
      }));
      sendJson(response, 200, {
        object: "list",
        data: assistants,
        first_id: assistants[0]?.id ?? null,
        last_id: assistants[assistants.length - 1]?.id ?? null,
        has_more: false
      });
      return true;
    }

    // 2. POST /v1/threads
    if (request.method === "POST" && path === "/v1/threads") {
      const payload = await readJsonBody(request, maxBodyBytes);
      const threadId = `thread_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      const channel = bridge.workspace.createChannel(threadId, "OpenAI Compatible Thread");

      if (payload.messages && Array.isArray(payload.messages)) {
        for (const msg of payload.messages) {
          const role = msg.role ?? "user";
          const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
          bridge.workspace.postMessage(channel.id, {
            type: role === "assistant" ? "runtime" : "user",
            id: role === "assistant" ? "assistant_default" : "user_default",
            name: role === "assistant" ? "Assistant" : "User"
          }, content);
        }
      }

      sendJson(response, 200, {
        id: channel.id,
        object: "thread",
        created_at: Math.floor(Date.parse(channel.createdAt) / 1000),
        metadata: payload.metadata ?? {}
      });
      return true;
    }

    // 3. POST /v1/threads/:threadId/messages
    if (request.method === "POST" && path.startsWith("/v1/threads/") && path.endsWith("/messages")) {
      const parts = path.split("/");
      const threadId = parts[3];
      if (!threadId) throw new Error("Missing threadId.");

      const payload = await readJsonBody(request, maxBodyBytes);
      const sender = {
        type: payload.role === "assistant" ? "runtime" : "user",
        id: payload.role === "assistant" ? "assistant_default" : "user_default",
        name: payload.role === "assistant" ? "Assistant" : "User"
      } as const;

      const msgContent = typeof payload.content === "string" ? payload.content : JSON.stringify(payload.content);
      const userMsg = bridge.workspace.postMessage(threadId, sender, msgContent);

      sendJson(response, 200, {
        id: userMsg.id,
        object: "thread.message",
        created_at: Math.floor(Date.parse(userMsg.timestamp) / 1000),
        thread_id: threadId,
        role: payload.role ?? "user",
        content: [
          {
            type: "text",
            text: {
              value: userMsg.content,
              annotations: []
            }
          }
        ],
        assistant_id: payload.role === "assistant" ? "assistant_default" : null,
        run_id: null,
        metadata: {}
      });
      return true;
    }

    // 4. GET /v1/threads/:threadId/messages
    if (request.method === "GET" && path.startsWith("/v1/threads/") && path.endsWith("/messages")) {
      const parts = path.split("/");
      const threadId = parts[3];
      if (!threadId) throw new Error("Missing threadId.");

      const messages = bridge.workspace.getMessages(threadId);
      const data = messages.map((m: any) => ({
        id: m.id,
        object: "thread.message",
        created_at: Math.floor(Date.parse(m.timestamp) / 1000),
        thread_id: threadId,
        role: m.sender.type === "runtime" ? "assistant" : "user",
        content: [
          {
            type: "text",
            text: {
              value: m.content,
              annotations: []
            }
          }
        ],
        assistant_id: m.sender.type === "runtime" ? m.sender.id : null,
        run_id: m.meta?.runId ?? null,
        metadata: m.meta ?? {}
      }));

      sendJson(response, 200, {
        object: "list",
        data: data,
        first_id: data[0]?.id ?? null,
        last_id: data[data.length - 1]?.id ?? null,
        has_more: false
      });
      return true;
    }

    // 5. POST /v1/threads/:threadId/runs
    if (request.method === "POST" && path.startsWith("/v1/threads/") && path.endsWith("/runs") && !path.includes("/runs/")) {
      const parts = path.split("/");
      const threadId = parts[3];
      if (!threadId) throw new Error("Missing threadId.");

      const payload = await readJsonBody(request, maxBodyBytes);
      const assistantId = payload.assistant_id;
      if (!assistantId) {
        throw new Error("Missing 'assistant_id' field for starting a run.");
      }

      const messages = bridge.workspace.getMessages(threadId);
      const lastUserMsg = [...messages].reverse().find((m: any) => m.sender.type === "user");
      if (!lastUserMsg) {
        throw new Error("Cannot run a thread with no user messages.");
      }

      const runId = `run_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
      const runtimes = payload.metadata?.runtimes ?? [assistantId];

      await bridge.coordinator.handleUserMessage(threadId, lastUserMsg, runtimes, runId);

      sendJson(response, 200, {
        id: runId,
        object: "thread.run",
        created_at: Math.floor(Date.now() / 1000),
        assistant_id: assistantId,
        thread_id: threadId,
        status: "queued",
        started_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 600,
        cancelled_at: null,
        failed_at: null,
        completed_at: null,
        last_error: null,
        model: payload.model ?? "default",
        instructions: payload.instructions ?? null,
        tools: [],
        metadata: payload.metadata ?? {}
      });
      return true;
    }

    // 6. GET /v1/threads/:threadId/runs/:runId
    if (request.method === "GET" && path.startsWith("/v1/threads/") && path.includes("/runs/")) {
      const parts = path.split("/");
      const threadId = parts[3];
      const runId = parts[5];
      if (!threadId || !runId) throw new Error("Missing threadId or runId.");

      const runState = bridge.coordinator.getRun(runId);
      const status = runState ? runState.status : "queued";
      const error = runState?.error ?? null;

      sendJson(response, 200, {
        id: runId,
        object: "thread.run",
        created_at: Math.floor(Date.now() / 1000),
        assistant_id: "default",
        thread_id: threadId,
        status: status,
        started_at: Math.floor(Date.now() / 1000),
        expires_at: Math.floor(Date.now() / 1000) + 600,
        cancelled_at: null,
        failed_at: status === "failed" ? Math.floor(Date.now() / 1000) : null,
        completed_at: status === "completed" ? Math.floor(Date.now() / 1000) : null,
        last_error: error ? { code: "server_error", message: error } : null,
        model: "default",
        instructions: null,
        tools: [],
        metadata: {}
      });
      return true;
    }

    // Unhandled /v1 endpoint
    sendJson(response, 404, {
      error: {
        message: `OpenAI compatible route '${path}' is not implemented.`,
        type: "invalid_request_error",
        code: "endpoint_not_found"
      }
    });
    return true;

  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    sendJson(response, 400, {
      error: {
        message: errorMsg,
        type: "invalid_request_error",
        code: "bad_request"
      }
    });
    return true;
  }
}
