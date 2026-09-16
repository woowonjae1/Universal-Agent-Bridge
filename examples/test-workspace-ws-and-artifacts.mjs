import { AgentBridge } from "@uab/core";
import { createHttpBridgeServer } from "@uab/transport-http";
import { WebSocket } from "ws";

// -------------------------------------------------------------
// 1. 创建模拟在线大模型角色适配器（快速且不依赖网络）
// -------------------------------------------------------------
function createMockLlmAdapter(id, name, defaultRolePrompt) {
  return {
    info: { id, name },
    capabilities() { return { stream: true }; },
    methods() {
      return [
        { name: "agent.stream", capability: "chat", description: "向该角色发起流式对话" }
      ];
    },
    async *stream(request) {
      const responseText = id === "mock-writer"
        ? "AI 与人类协同协作开启新纪元。"
        : "【主编修正】：AI 与人类并肩同行，共筑多 Agent 协同新纪元！";
      for (const char of responseText) {
        yield {
          type: "text",
          delta: char,
          messageId: `msg_${request.id}`
        };
        await new Promise(r => setTimeout(r, 10));
      }
    }
  };
}

// -------------------------------------------------------------
// 2. 初始化 UAB 并启动 HTTP + WebSocket 协同网关
// -------------------------------------------------------------
const bridge = new AgentBridge();
bridge.register(createMockLlmAdapter("mock-writer", "AI 创意起草官", "起草"));
bridge.register(createMockLlmAdapter("mock-editor", "AI 严苛主编", "润色"));

const server = createHttpBridgeServer({ bridge });
const port = 8699;

server.listen(port, "127.0.0.1", async () => {
  console.log(`\n=======================================================`);
  console.log(`🚀 UAB 实时协同 & 工件版本网关已在 http://127.0.0.1:${port} 启动`);
  console.log(`=======================================================\n`);

  try {
    // 1. 创建协同频道 #collaboration
    console.log("-> 1. 正在创建频道 #collaboration...");
    const channelRes = await fetch(`http://127.0.0.1:${port}/workspace/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "collaboration", description: "实时协同实验与版本管理频道" })
    });
    const channel = await channelRes.json();
    console.log(`   ✅ 频道创建成功: ${channel.name}\n`);

    // 2. 使用 WebSocket 连接到频道升级协议
    console.log("-> 2. 建立 WebSocket 实时双向频道订阅...");
    const ws = new WebSocket(`ws://127.0.0.1:${port}/workspace/channels/collaboration`);

    const events = [];
    ws.on("message", (data) => {
      const event = JSON.parse(data.toString());
      events.push(event);
      if (event.type === "agent.state") {
        console.log(`      [WS 广播 - 智能体状态]: ${event.data.runtimeId} -> ${event.data.state.toUpperCase()}`);
      } else if (event.type === "message.created") {
        console.log(`      [WS 广播 - 消息创建]: [${event.data.sender.name}]: "${event.data.content}"`);
      } else if (event.type === "artifact.saved") {
        console.log(`      [WS 广播 - 工件保存]: "${event.data.artifactId}" 新版本 V${event.data.version} 被 [${event.data.sender.name}] 提交`);
      }
    });

    // 等待 500ms 确保 WS 连接就绪
    await new Promise(r => setTimeout(r, 500));

    // 3. 通过 WebSocket 发送用户消息并激活智能体协同 cascade
    console.log("\n-> 3. 通过 WebSocket 实时发送用户指令，唤醒 AI 协作 cascade...");
    ws.send(JSON.stringify({
      content: "起草一份协同倡议书",
      sender: { type: "user", id: "ws_client", name: "客户端小张" },
      runtimes: ["mock-writer", "mock-editor"]
    }));

    // 给协同运行 2.5 秒时间
    await new Promise(r => setTimeout(r, 2500));

    // 4. 对该协同工作区生成并迭代共享工件 (Artifact)
    console.log("\n-> 4. 提交共享工件 Slogan.md 的初始版本 (V1)...");
    const artV1Res = await fetch(`http://127.0.0.1:${port}/workspace/channels/collaboration/artifacts/Slogan.md`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "## UAB 协同口号\n起草草案：一个人也可以成为一支队伍！",
        sender: { type: "runtime", id: "mock-writer", name: "AI 创意起草官" }
      })
    });
    const artV1 = await artV1Res.json();
    console.log(`   ✅ V1 提交成功，当前最新版本: V${artV1.versions.length}`);

    console.log("\n-> 5. 提交共享工件 Slogan.md 的主编精润版本 (V2)...");
    const artV2Res = await fetch(`http://127.0.0.1:${port}/workspace/channels/collaboration/artifacts/Slogan.md`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "## UAB 协同口号\n精润版本：汇聚多元智能，共筑协作之翼；聚沙成塔，智汇未来！",
        sender: { type: "runtime", id: "mock-editor", name: "AI 严苛主编" }
      })
    });
    const artV2 = await artV2Res.json();
    console.log(`   ✅ V2 提交成功，当前最新版本: V${artV2.versions.length}`);

    // 5. 检索工件历史版本并生成 diff 比较
    console.log("\n-> 6. 获取工件 Slogan.md 的完整历史版本记录...");
    const artGetRes = await fetch(`http://127.0.0.1:${port}/workspace/channels/collaboration/artifacts/Slogan.md`);
    const artData = await artGetRes.json();
    console.log("   ✅ 获取成功。历史版本列表:");
    for (const ver of artData.versions) {
      console.log(`      - V${ver.version} | 提交者: ${ver.sender.name} | 时间: ${ver.timestamp}`);
    }

    console.log("\n-> 7. 自动生成工件 V1 与 V2 之间的差异（Diff）分析...");
    const diffRes = await fetch(`http://127.0.0.1:${port}/workspace/channels/collaboration/artifacts/Slogan.md/diff?from=1&to=2`);
    const diffData = await diffRes.json();
    
    console.log("\n=======================================================");
    console.log("🔍 Slogan.md (V1 -> V2) 历史差分对比(Diff):");
    console.log("=======================================================");
    console.log(diffData.diff);
    console.log("=======================================================\n");

    ws.close();
    await new Promise(r => setTimeout(r, 200));

  } catch (error) {
    console.error("❌ 协同与版本控制测试失败:", error);
  } finally {
    server.close();
    console.log("✅ 测试完毕，实时协同网关已安全关闭。");
  }
});
