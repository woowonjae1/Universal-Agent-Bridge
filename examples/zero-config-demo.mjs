import { AgentBridge } from "@uab/core";

// Ensure API key is configured
const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("\n❌ 错误: 未检测到 OPENAI_API_KEY 环境变量！");
  console.error("请先设置环境变量，例如：");
  console.error('  $env:OPENAI_API_KEY="your-sk-key"');
  console.error("\n演示已退出。\n");
  process.exit(1);
}

// -------------------------------------------------------------
// 1. 创建自定义在线大模型适配器 (Custom Inline LLM Adapter)
// -------------------------------------------------------------
function createMockLlmAdapter(id, name, defaultRolePrompt) {
  return {
    info: {
      id,
      name,
      version: "1.0.0",
      description: `虚拟角色: ${name}`
    },
    capabilities() {
      return {
        stream: true,
        sessionManagement: false
      };
    },
    methods() {
      return [
        {
          name: "agent",
          capability: "chat",
          description: "向该角色发起对话"
        }
      ];
    },
    async call(request) {
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
          stream: false
        })
      });
      const data = await res.json();
      return data.choices[0].message.content;
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
              // Ignore partial chunk errors
            }
          }
        }
      }
    }
  };
}

// -------------------------------------------------------------
// 2. 初始化 UAB 并注册适配器
// -------------------------------------------------------------
const bridge = new AgentBridge();
bridge.register(createMockLlmAdapter(
  "mock-writer", 
  "创意脑暴官", 
  "你是一位脑洞大开的创意文案策划，请根据用户提供的主题，写一句短小精悍的口号建议。"
));
bridge.register(createMockLlmAdapter(
  "mock-editor", 
  "严苛文案主编", 
  "你是一位严苛的杂志文案主编。请挑出前一个草案的毛病，并产出一句极其专业、高级、适合发到朋友圈的最终版文案。"
));

// -------------------------------------------------------------
// 3. 构建多智能体接力协同 Plan
// -------------------------------------------------------------
const plan = {
  id: "zero_config_flow_" + Date.now(),
  mode: "dag",
  timeoutMs: 120000,
  stopOnError: true,
  steps: [
    {
      id: "draft",
      runtime: "mock-writer",
      method: "agent",
      stream: true,
      params: { message: "主题：为什么人人都需要学会与 AI 智能体协同工作" }
    },
    {
      id: "polish",
      runtime: "mock-editor",
      dependsOn: ["draft"],
      method: "agent",
      params: { message: "请对以下文案草案进行修改润色，并列出你的修改点：\n\n${steps.draft.stream.text}" }
    }
  ]
};

console.log("\n=======================================================");
console.log("启动 UAB 零配置一键演示 (Zero-Configuration Demo)");
console.log("正在通过 UAB 编排 [创意脑暴官] 与 [文案主编] 进行接力运作...");
console.log("=======================================================\n");

console.log("⏳ 步骤 1: 正在运行 [创意脑暴官] 起草文案...");
const result = await bridge.runPlan(plan);

console.log("\n✅ 计划执行完毕！");
console.log("=======================================================");

const steps = Object.fromEntries(result.steps.map((s) => [s.stepId, s]));

console.log("\n[第一步：创意脑暴官 草案]:");
console.log(steps.draft.streamText || steps.draft.response?.result);

console.log("\n[第二步：文案主编 最终版]:");
console.log(steps.polish.response?.result);

console.log("\n=======================================================");
console.log("📊 [可观测性度量数据 (Metrics)]");
const metrics = bridge.metrics();
console.log(`- 引擎启动至今总调用次数: ${metrics.calls}`);
console.log(`- 本次工作流执行状态: ${result.runStatus}`);
console.log("=======================================================\n");
