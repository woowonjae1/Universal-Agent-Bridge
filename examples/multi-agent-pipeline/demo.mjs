// Zero-dependency demo: three heterogeneous "runtimes" coordinated in one DAG.
//
// Nothing external is required — no API keys, no OpenClaw, no ports. Each
// runtime below is a small in-process mock adapter standing in for a real
// agent system (an LLM gateway, a reviewer agent, a formatting tool). The
// point is the *bridge*: one protocol, capability routing, a streaming step
// whose text flows into the next step, all through the same AgentBridge you
// would run in production.
//
// Run it:  npm run demo

import { AgentBridge } from "@uab/core";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A mock streaming agent — the "how to write a streaming adapter" example.
 * It implements the same AgentRuntimeAdapter contract a real adapter does:
 * info, capabilities, and a stream() that yields text deltas then a result.
 */
function createStreamingAgent({ id, name, script, onDelta }) {
  return {
    info: { id, name, description: "Demo streaming agent (mock)" },
    capabilities: () => ({ chat: { read: true, write: true, methods: ["chat.stream"] } }),
    methods: () => [
      { name: "chat.stream", title: "Stream a reply", capability: "chat", risk: "read" }
    ],
    call(request) {
      // Non-streaming fallback: return the whole scripted reply at once.
      return { text: script(request.params) };
    },
    async *stream(request) {
      const text = script(request.params);
      for (const token of text.match(/\S+\s*/g) ?? []) {
        onDelta?.(id, token);
        yield { type: "text", delta: token };
        await sleep(35); // simulate token-by-token generation
      }
      yield { type: "result", data: { text } };
    }
  };
}

/** A mock non-streaming agent (reviewer / formatter / any tool runtime). */
function createCallAgent({ id, name, capability, method, handler }) {
  return {
    info: { id, name, description: "Demo call agent (mock)" },
    capabilities: () => ({ [capability]: { read: true, write: true, methods: [method] } }),
    methods: () => [{ name: method, capability, risk: "read" }],
    call(request) {
      return handler(request.params ?? {});
    }
  };
}

async function main() {
  const bridge = new AgentBridge();

  // --- Register three heterogeneous runtimes -----------------------------
  bridge.register(
    createStreamingAgent({
      id: "writer",
      name: "Writer (mock LLM)",
      onDelta: (_id, token) => process.stdout.write(GREEN + token + RESET),
      script: () =>
        "A multi-agent bridge is a control plane that lets independent agents " +
        "discover each other, share context, and coordinate through one protocol, " +
        "so specialized agents combine their strengths instead of working in silos."
    })
  );

  bridge.register(
    createCallAgent({
      id: "reviewer",
      name: "Reviewer (mock critic)",
      capability: "review",
      method: "review.rate",
      handler: ({ text }) => {
        const words = String(text ?? "").trim().split(/\s+/).filter(Boolean).length;
        const score = words > 0 && words <= 45 ? 9 : words <= 70 ? 7 : 5;
        return {
          score,
          note:
            score >= 9
              ? "Tight and clear — one sentence, no filler."
              : score >= 7
                ? "Clear, but could be tightened."
                : "Too long; split into shorter sentences."
        };
      }
    })
  );

  bridge.register(
    createCallAgent({
      id: "formatter",
      name: "Formatter (mock tool)",
      capability: "format",
      method: "format.render",
      handler: ({ text, score }) => ({
        markdown: `> ${String(text ?? "").trim()}\n\n**Clarity score:** ${score}/10`
      })
    })
  );

  // --- One DAG plan spanning all three runtimes --------------------------
  const plan = {
    id: "multi_agent_pipeline",
    mode: "dag",
    timeoutMs: 30000,
    stopOnError: true,
    steps: [
      {
        id: "write",
        runtime: "writer",
        method: "chat.stream",
        stream: true,
        params: { message: "In one sentence, what is a multi-agent bridge?" }
      },
      {
        id: "rate",
        runtime: "reviewer",
        dependsOn: ["write"],
        method: "review.rate",
        params: { text: "${steps.write.stream.text}" }
      },
      {
        id: "render",
        runtime: "formatter",
        dependsOn: ["rate"],
        method: "format.render",
        params: { text: "${steps.write.stream.text}", score: "${steps.rate.result.score}" }
      }
    ]
  };

  console.log(`\n${BOLD}Universal Agent Bridge — multi-agent pipeline demo${RESET}`);
  console.log(`${DIM}3 heterogeneous runtimes · 1 DAG · streaming handoff · in-process, no external services${RESET}\n`);
  console.log(`${CYAN}[write @ writer]${RESET} streaming...`);
  process.stdout.write("  ");

  const result = await bridge.runPlan(plan);

  const steps = Object.fromEntries(result.steps.map((s) => [s.stepId, s]));
  const rate = steps.rate.response?.result ?? {};
  const render = steps.render.response?.result ?? {};

  console.log(`\n\n${CYAN}[rate @ reviewer]${RESET} consumed the streamed text:`);
  console.log(`  ${YELLOW}score${RESET} ${rate.score}/10 — ${rate.note}`);
  console.log(`\n${CYAN}[render @ formatter]${RESET} combined both upstream results:`);
  console.log((render.markdown ?? "").split("\n").map((l) => "  " + l).join("\n"));

  console.log(`\n${DIM}plan status: ${result.runStatus} · ` +
    `write → rate → render, data passed via \${steps.*} templates${RESET}`);
  console.log(`${DIM}The same plan runs unchanged over real runtimes (OpenClaw, MCP, A2A, HTTP) — ` +
    `swap the mock adapters for real ones.${RESET}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
