import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 9000);

const capabilities = {
  system: { read: true },
  sessions: { read: true, write: true },
  models: { read: true }
};

const methods = [
  {
    name: "system.ping",
    title: "Ping example agent",
    description: "Verify that the external agent is reachable.",
    capability: "system",
    risk: "read",
    paramsExample: { message: "hello external agent" }
  },
  {
    name: "sessions.list",
    title: "List external sessions",
    description: "Return sessions from the example external agent.",
    capability: "sessions",
    risk: "read",
    paramsExample: {}
  },
  {
    name: "models.list",
    title: "List external models",
    description: "Return model options from the example external agent.",
    capability: "models",
    risk: "read",
    paramsExample: {}
  }
];

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://localhost");
  writeCors(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, {
      status: "ok",
      details: {
        runtime: "example-http-agent"
      }
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/capabilities") {
    sendJson(response, 200, {
      capabilities
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/methods") {
    sendJson(response, 200, {
      methods
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/rpc") {
    const payload = await readJson(request);
    sendJson(response, 200, handleRpc(payload));
    return;
  }

  sendJson(response, 404, {
    error: "Not found"
  });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Example HTTP agent listening on http://127.0.0.1:${port}`);
});

function handleRpc(payload) {
  const id = payload?.id ?? null;
  const method = payload?.method;

  if (method === "system.ping") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        ok: true,
        runtime: "example-http-agent",
        echo: payload.params ?? null,
        traceId: payload.meta?.traceId
      }
    };
  }

  if (method === "sessions.list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        sessions: [
          {
            id: "external_session_1",
            title: "External agent session",
            messageCount: 3
          }
        ]
      }
    };
  }

  if (method === "models.list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        current: "external-balanced",
        models: ["external-fast", "external-balanced", "external-deep"]
      }
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32601,
      message: `Method '${method}' is not supported.`
    }
  };
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function writeCors(response) {
  response.setHeader("access-control-allow-origin", "*");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type, authorization");
}

