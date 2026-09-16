import { AgentBridge } from "@uab/core";
import { createHttpBridgeServer } from "@uab/transport-http";
import http from "node:http";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("❌ 错误: 未检测到 OPENAI_API_KEY 环境变量，已退出测试。");
  process.exit(1);
}

// -------------------------------------------------------------
// 1. 创建在线大模型角色适配器
// -------------------------------------------------------------
function createMockLlmAdapter(id, name, defaultRolePrompt) {
  return {
    info: { id, name },
    capabilities() { return { stream: true }; },
    methods() {
      return [
        {
          name: "agent.stream",
          capability: "chat",
          description: "向该角色发起对话并流式返回"
        }
      ];
    },
    async *stream(request) {
      const message = request.params.message;
      const res = await fetch("https://ai.1982video.cn/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [
            { role: "system", content: defaultRolePrompt },
            { role: "user", content: message }
          ],
          stream: true
        })
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          const cleanLine = line.trim();
          if (cleanLine.startsWith("data: ")) {
            const dataStr = cleanLine.slice(6).trim();
            if (dataStr === "[DONE]") break;
            try {
              const data = JSON.parse(dataStr);
              const delta = data.choices[0]?.delta?.content;
              if (delta) {
                yield {
                  type: "text",
                  delta,
                  messageId: `msg_${request.id}`
                };
              }
            } catch (e) {
              // Ignore
            }
          }
        }
      }
    }
  };
}

// -------------------------------------------------------------
// 2. 初始化 UAB 并启动本地 HTTP Gateway 服务
// -------------------------------------------------------------
const bridge = new AgentBridge();
bridge.register(createMockLlmAdapter("mock-writer", "AI 创意起草官", "你是一个极其富有创意的文案。请为【多智能体协同协作系统 UAB】写一句有创意的、简短口号。"));
bridge.register(createMockLlmAdapter("mock-editor", "AI 严苛主编", "你是一个极其追求完美的主编。请润色前一个智能体生成的口号，让它听起来非常震撼人心。"));

const server = createHttpBridgeServer({ bridge });
const port = 8799;

server.listen(port, "127.0.0.1", async () => {
  console.log(`\n=======================================================`);
  console.log(`🚀 UAB 协同工作区 HTTP 网关已在 http://127.0.0.1:${port} 启动`);
  console.log(`=======================================================\n`);

  try {
    // 3. 创建频道 #cooperation
    console.log("-> 1. 正在创建频道 #cooperation...");
    const createChanRes = await fetch(`http://127.0.0.1:${port}/workspace/channels`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "cooperation", description: "多智能体协同实验频道" })
    });
    const channel = await createChanRes.json();
    console.log(`   ✅ 频道创建成功: ${channel.name} (${channel.description})\n`);

    // 4. 订阅频道的实时 SSE 事件流
    console.log("-> 2. 正在建立 SSE 事件订阅监听...");
    const sseController = new AbortController();
    const ssePromise = (async () => {
      const sseRes = await fetch(`http://127.0.0.1:${port}/workspace/channels/cooperation/events`, {
        signal: sseController.signal
      });
      const reader = sseRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        
        for (const line of lines) {
          const cleanLine = line.trim();
          if (cleanLine.startsWith("event: ")) {
            const eventType = cleanLine.slice(7);
            const dataLine = lines[lines.indexOf(line) + 1] || "";
            if (dataLine.startsWith("data: ")) {
              const dataStr = dataLine.slice(6);
              try {
                const event = JSON.parse(dataStr);
                
                // 打印关键协同事件
                if (eventType === "agent.state") {
                  console.log(`   [⚡ SSE 事件 - 智能体状态]: ${event.data.runtimeId} -> ${event.data.state.toUpperCase()}`);
                } else if (eventType === "message.created") {
                  console.log(`   [⚡ SSE 事件 - 消息创建]: [${event.data.sender.name}]: "${event.data.content}"`);
                } else if (eventType === "message.updated") {
                  // 部分流式打印，避免控制台刷屏
                  process.stdout.write(`.`); 
                }
              } catch (e) {
                // Ignore
              }
            }
          }
        }
      }
    })();

    // 等待 1 秒确保 SSE 建立成功
    await new Promise(r => setTimeout(r, 1000));

    // 5. 模拟用户发送消息，并触发 AI 协同链
    console.log("\n-> 3. 发送用户消息并触发 AI 协同 (mock-writer -> mock-editor 接力)...");
    const sendMsgRes = await fetch(`http://127.0.0.1:${port}/workspace/channels/cooperation/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "起草一句 Slogan",
        sender: { type: "user", id: "user_owner", name: "项目经理" },
        runtimes: ["mock-writer", "mock-editor"] // 按顺序自动接力
      })
    });
    
    // 等待协同彻底跑完（大模型生成需要一点时间，给 12 秒）
    await new Promise(r => setTimeout(r, 12000));

    // 6. 获取频道的最终历史消息并打印
    console.log("\n\n-> 4. 查询频道 #cooperation 最终历史消息日志...");
    const historyRes = await fetch(`http://127.0.0.1:${port}/workspace/channels/cooperation/messages`);
    const history = await historyRes.json();
    
    console.log("\n=======================================================");
    console.log("💬 #cooperation 频道历史对话记录:");
    console.log("=======================================================");
    for (const msg of history) {
      const roleName = msg.sender.type === "user" ? "👤 " + msg.sender.name : "🤖 " + msg.sender.name;
      console.log(`\n[${roleName}]:`);
      console.log(msg.content);
    }
    console.log("=======================================================\n");

    // 关闭 SSE
    sseController.abort();
    await ssePromise.catch(() => {});
    
  } catch (error) {
    console.error("❌ 协同流程验证失败:", error);
  } finally {
    server.close();
    console.log("✅ 测试完毕，HTTP 网关服务已关闭。");
  }
});
