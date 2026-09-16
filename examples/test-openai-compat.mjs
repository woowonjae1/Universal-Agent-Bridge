import { AgentBridge } from "@uab/core";
import { createHttpBridgeServer } from "@uab/transport-http";

// -------------------------------------------------------------
// 1. 创建模拟在线大模型角色适配器（不依赖网络，直接在本地以流式/非流式返回）
// -------------------------------------------------------------
function createMockLlmAdapter(id, name, defaultRolePrompt) {
  return {
    info: { id, name },
    capabilities() { return { stream: true }; },
    methods() {
      return [
        { name: "agent.stream", capability: "chat", description: "向该角色发起流式对话" },
        { name: "agent", capability: "chat", description: "向该角色发起对话" }
      ];
    },
    async call(request) {
      return id === "mock-writer"
        ? "【创意起草官草案】：与 AI 智能体同行，把一个人的能力变成一支队伍。"
        : "【主编润色】：携手多元智能，共筑协作之翼；聚沙成塔，智汇未来！";
    },
    async *stream(request) {
      const responseText = id === "mock-writer"
        ? "与 AI 智能体同行，把一个人的能力变成一支队伍。"
        : "【UAB 协同总线】：携手多元智能，共筑协作之翼；聚沙成塔，智汇未来！";
      for (const char of responseText) {
        yield {
          type: "text",
          delta: char,
          messageId: `msg_${request.id}`
        };
        await new Promise(r => setTimeout(r, 20));
      }
    }
  };
}

// -------------------------------------------------------------
// 2. 初始化 UAB 并启动 HTTP 网关服务
// -------------------------------------------------------------
const bridge = new AgentBridge();
bridge.register(createMockLlmAdapter("mock-writer", "AI 创意起草官", "起草口号"));
bridge.register(createMockLlmAdapter("mock-editor", "AI 严苛主编", "润色口号"));

const server = createHttpBridgeServer({ bridge });
const port = 8999;

server.listen(port, "127.0.0.1", async () => {
  console.log(`\n=======================================================`);
  console.log(`🚀 UAB OpenAI 兼容接口测试服务已启动在 http://127.0.0.1:${port}`);
  console.log(`=======================================================\n`);

  try {
    // 1. GET /v1/assistants
    console.log("-> 1. 获取 Assistants 列表...");
    const assistantsRes = await fetch(`http://127.0.0.1:${port}/v1/assistants`);
    const assistants = await assistantsRes.json();
    console.log("   ✅ 获取成功，当前可用的 Assistants:");
    for (const ast of assistants.data) {
      console.log(`      - ID: ${ast.id}, Name: ${ast.name}`);
    }
    console.log();

    // 2. POST /v1/threads
    console.log("-> 2. 创建新会话 Thread...");
    const threadRes = await fetch(`http://127.0.0.1:${port}/v1/threads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    });
    const thread = await threadRes.json();
    console.log(`   ✅ 会话创建成功: ${thread.id}\n`);

    // 3. POST /v1/threads/:id/messages
    console.log("-> 3. 发送用户消息...");
    const msgRes = await fetch(`http://127.0.0.1:${port}/v1/threads/${thread.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        role: "user",
        content: "起草一句有创意的 Slogan"
      })
    });
    const message = await msgRes.json();
    console.log(`   ✅ 消息发送成功，ID: ${message.id}\n`);

    // 4. POST /v1/threads/:id/runs (触发级联协同)
    console.log("-> 4. 触发智能体链条 Cascade Run (mock-writer -> mock-editor)...");
    const runRes = await fetch(`http://127.0.0.1:${port}/v1/threads/${thread.id}/runs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        assistant_id: "mock-writer",
        metadata: {
          runtimes: ["mock-writer", "mock-editor"] // 通过 metadata 指定级联链条
        }
      })
    });
    const run = await runRes.json();
    console.log(`   ✅ Run 成功创建并入队，Run ID: ${run.id}\n`);

    // 5. 轮询 GET /v1/threads/:id/runs/:runId
    console.log("-> 5. 开始轮询 Run 状态...");
    let status = run.status;
    let attempts = 0;
    while (status !== "completed" && status !== "failed" && attempts < 20) {
      await new Promise(r => setTimeout(r, 1000));
      const pollRes = await fetch(`http://127.0.0.1:${port}/v1/threads/${thread.id}/runs/${run.id}`);
      const pollData = await pollRes.json();
      status = pollData.status;
      console.log(`   [轮询] 状态: ${status}`);
      attempts++;
    }

    if (status === "completed") {
      console.log("\n   ✅ Run 执行完毕，状态: completed");
    } else {
      console.error(`\n   ❌ Run 执行失败或超时，状态: ${status}`);
    }

    // 6. GET /v1/threads/:id/messages
    console.log("\n-> 6. 获取 Thread 最终消息列表并打印...");
    const historyRes = await fetch(`http://127.0.0.1:${port}/v1/threads/${thread.id}/messages`);
    const history = await historyRes.json();

    console.log("\n=======================================================");
    console.log(`💬 OpenAI 兼容 Thread (${thread.id}) 对话历史:`);
    console.log("=======================================================");
    for (const msg of history.data) {
      console.log(`\n[${msg.role.toUpperCase()} (AssistantID: ${msg.assistant_id})]:`);
      console.log(msg.content[0].text.value);
    }
    console.log("=======================================================\n");

  } catch (error) {
    console.error("❌ 验证流程发生错误:", error);
  } finally {
    server.close();
    console.log("✅ 测试完毕，网关服务关闭。");
  }
});
