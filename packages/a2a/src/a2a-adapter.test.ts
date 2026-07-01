import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createA2aAdapter } from "./index.js";

const serverPath = fileURLToPath(
  new URL("../../../examples/a2a-agent/server.mjs", import.meta.url)
);

test("A2A adapter discovers Agent Card and sends messages", async () => {
  const server = spawn(process.execPath, [serverPath, "--port", "0"], {
    stdio: ["ignore", "pipe", "inherit"]
  });
  server.stdout.setEncoding("utf8");
  const [line] = await once(server.stdout, "data") as [string];
  const { port } = JSON.parse(line.trim()) as { port: number };

  const adapter = createA2aAdapter({
    agents: [
      {
        id: "example",
        baseUrl: `http://127.0.0.1:${port}`
      }
    ]
  });

  try {
    const card = await adapter.call({
      method: "a2a.agent.card",
      params: { agentId: "example" },
      raw: {
        jsonrpc: "2.0",
        id: "card",
        runtime: "a2a",
        method: "a2a.agent.card"
      }
    }, {
      requestId: "card",
      traceId: "trace"
    }) as { name: string };
    assert.equal(card.name, "Example A2A Agent");

    const result = await adapter.call({
      method: "a2a.message.send",
      params: { agentId: "example", text: "hello a2a" },
      raw: {
        jsonrpc: "2.0",
        id: "send",
        runtime: "a2a",
        method: "a2a.message.send"
      }
    }, {
      requestId: "send",
      traceId: "trace"
    }) as {
      result: {
        message: {
          parts: Array<{ text: string }>;
        };
      };
    };

    assert.equal(result.result.message.parts[0].text, "Echo: hello a2a");
  } finally {
    server.kill();
  }
});
