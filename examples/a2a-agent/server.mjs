#!/usr/bin/env node
import { createServer } from "node:http";

const portArg = process.argv.indexOf("--port");
const requestedPort = portArg === -1 ? 9010 : Number(process.argv[portArg + 1]);
const host = "127.0.0.1";
const tasks = new Map();

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${host}`);

  if (request.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
    sendJson(response, 200, agentCard(server.address().port));
    return;
  }

  if (request.method === "POST" && url.pathname === "/a2a/v1") {
    const payload = await readJson(request);
    const result = handleRpc(payload);
    sendJson(response, "error" in result ? 400 : 200, result);
    return;
  }

  sendJson(response, 404, { error: "not found" });
});

server.listen(requestedPort, host, () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});

function agentCard(port) {
  return {
    name: "Example A2A Agent",
    description: "Small A2A server used by Universal Agent Bridge tests.",
    version: "0.1.0",
    supportedInterfaces: [
      {
        url: `http://${host}:${port}/a2a/v1`,
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0"
      }
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: true
    },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "echo",
        name: "Echo",
        description: "Echoes the incoming text.",
        tags: ["demo"],
        examples: ["hello"]
      }
    ]
  };
}

function handleRpc(payload) {
  try {
    switch (payload.method) {
      case "SendMessage":
        return success(payload.id, sendMessage(payload.params ?? {}));
      case "GetTask":
        return success(payload.id, { task: tasks.get(payload.params?.id) ?? null });
      case "ListTasks":
        return success(payload.id, { tasks: [...tasks.values()] });
      case "CancelTask":
        return success(payload.id, cancelTask(payload.params?.id));
      case "GetExtendedAgentCard":
        return success(payload.id, {
          ...agentCard(server.address().port),
          extended: true
        });
      default:
        return error(payload.id, -32601, `Method '${payload.method}' is not supported.`);
    }
  } catch (err) {
    return error(payload.id, -32603, err instanceof Error ? err.message : String(err));
  }
}

function sendMessage(params) {
  const text = readText(params.message);
  const task = {
    id: `task_${tasks.size + 1}`,
    contextId: params.message?.contextId ?? `ctx_${tasks.size + 1}`,
    status: {
      state: "TASK_STATE_COMPLETED",
      timestamp: new Date().toISOString()
    }
  };
  tasks.set(task.id, task);

  return {
    message: {
      role: "ROLE_AGENT",
      parts: [{ text: `Echo: ${text}` }],
      messageId: `reply_${Date.now().toString(36)}`,
      taskId: task.id,
      contextId: task.contextId
    },
    task
  };
}

function cancelTask(id) {
  const task = tasks.get(id);
  if (!task) return { task: null };
  task.status = {
    state: "TASK_STATE_CANCELED",
    timestamp: new Date().toISOString()
  };
  return { task };
}

function readText(message) {
  const part = message?.parts?.find((entry) => typeof entry.text === "string");
  return part?.text ?? "";
}

function success(id, result) {
  return {
    jsonrpc: "2.0",
    id,
    result
  };
}

function error(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message }
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(JSON.stringify(payload, null, 2));
}
