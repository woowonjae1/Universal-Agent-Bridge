import { AgentBridge } from "@uab/core";
import { createPiAdapter } from "@uab/adapter-pi";
import { createOpenClawAdapter } from "@uab/adapter-openclaw";

const bridge = new AgentBridge();
bridge.register(createOpenClawAdapter({ id: "openclaw", gatewayUrl: "ws://127.0.0.1:18789", token: "2373ff8bc2e239486265d2c31597266a4ff57911337a547b" }));
bridge.register(createPiAdapter({ id: "pi", piPath: "D:\\code\\pi\\pi_woowonjae" }));

const plan = {
  id: "uab_life_scenario_" + Date.now(),
  mode: "dag",
  timeoutMs: 60000,
  stopOnError: true,
  steps: [
    {
      id: "plan_recipe",
      runtime: "openclaw",
      method: "agent.stream",
      stream: true,
      params: { message: "根据食材（牛肉、番茄、西兰花），规划一顿简单好做的低碳水、高蛋白的晚餐食谱建议。" }
    },
    {
      id: "nutrition_review",
      runtime: "pi",
      dependsOn: ["plan_recipe"],
      method: "agent",
      params: { message: "请作为专业营养师，评估以下食谱建议，估算总热量（大卡），并给出两点营养搭配或烹饪的改进建议：\n\n${steps.plan_recipe.stream.text}" }
    }
  ]
};

console.log("\n=======================================================");
console.log("启动 UAB 生活测试场景：晚餐食谱与营养审查工作流");
console.log("Coordinating [OpenClaw (美食规划)] 和 [Pi Agent (营养评估)]");
console.log("=======================================================\n");

console.log("-> [Step 1: OpenClaw] 正在为您定制低碳晚餐食谱...");
const result = await bridge.runPlan(plan);

console.log("\n-> 工作流执行完成！");
console.log("=======================================================");
console.log(JSON.stringify(result, null, 2));

