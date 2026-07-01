import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createMcpAdapter } from "./index.js";

const serverPath = fileURLToPath(
  new URL("../../../examples/mcp-stdio-server/server.mjs", import.meta.url)
);

test("MCP adapter lists tools from a stdio MCP server", async () => {
  const adapter = createMcpAdapter({
    servers: [
      {
        id: "example",
        transport: "stdio",
        command: process.execPath,
        args: [serverPath]
      }
    ]
  });

  try {
    const result = await adapter.call({
      method: "mcp.tools.list",
      params: { serverId: "example" },
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "mcp",
        method: "mcp.tools.list"
      }
    }, {
      requestId: "req",
      traceId: "trace"
    }) as { servers: Array<{ tools: Array<{ name: string }> }> };

    assert.equal(result.servers[0].tools[0].name, "echo");
  } finally {
    await adapter.stop?.();
  }
});

test("MCP adapter calls tools through a stdio MCP server", async () => {
  const adapter = createMcpAdapter({
    servers: [
      {
        id: "example",
        transport: "stdio",
        command: process.execPath,
        args: [serverPath]
      }
    ]
  });

  try {
    const result = await adapter.call({
      method: "mcp.tools.call",
      params: {
        serverId: "example",
        name: "echo",
        arguments: { text: "hello mcp" }
      },
      raw: {
        jsonrpc: "2.0",
        id: "req",
        runtime: "mcp",
        method: "mcp.tools.call"
      }
    }, {
      requestId: "req",
      traceId: "trace"
    }) as {
      result: {
        content: Array<{ type: string; text: string }>;
      };
    };

    assert.equal(result.result.content[0].text, "hello mcp");
  } finally {
    await adapter.stop?.();
  }
});
