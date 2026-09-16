import { EventEmitter } from "node:events";
import type { JsonValue, BridgeRequest } from "@uab/protocol";
import { isSuccessResponse } from "@uab/protocol";
import type { AgentBridge } from "./bridge.js";

// Core Types for Collaboration Workspace
export interface WorkspaceChannel {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
}

export interface WorkspaceMessageSender {
  type: "user" | "runtime" | "system";
  id: string;
  name: string;
}

export interface WorkspaceMessage {
  id: string;
  channelId: string;
  sender: WorkspaceMessageSender;
  content: string;
  timestamp: string;
  meta?: Record<string, any>;
}

export interface WorkspaceEvent {
  type: "message.created" | "message.updated" | "agent.state" | "artifact.saved";
  channelId: string;
  data: JsonValue;
}

export interface WorkspaceArtifactVersion {
  version: number;
  content: string;
  timestamp: string;
  sender: WorkspaceMessageSender;
}

export interface WorkspaceArtifact {
  id: string;
  channelId: string;
  versions: WorkspaceArtifactVersion[];
}

export class WorkspaceManager {
  private channels = new Map<string, WorkspaceChannel>();
  private messages = new Map<string, WorkspaceMessage[]>();
  private artifacts = new Map<string, Map<string, WorkspaceArtifact>>();
  private emitter = new EventEmitter();

  constructor() {
    // Create a default general channel
    this.createChannel("general", "General discussion channel");
  }

  createChannel(name: string, description?: string): WorkspaceChannel {
    const id = name.toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (this.channels.has(id)) {
      return this.channels.get(id)!;
    }
    const channel: WorkspaceChannel = {
      id,
      name: `#${id}`,
      description,
      createdAt: new Date().toISOString()
    };
    this.channels.set(id, channel);
    this.messages.set(id, []);
    return channel;
  }

  listChannels(): WorkspaceChannel[] {
    return Array.from(this.channels.values());
  }

  getChannel(id: string): WorkspaceChannel | undefined {
    return this.channels.get(id);
  }

  getMessages(channelId: string, limit = 50): WorkspaceMessage[] {
    const list = this.messages.get(channelId) || [];
    return list.slice(-limit);
  }

  postMessage(channelId: string, sender: WorkspaceMessageSender, content: string, meta?: Record<string, any>): WorkspaceMessage {
    if (!this.channels.has(channelId)) {
      throw new Error(`Channel '${channelId}' does not exist.`);
    }
    const message: WorkspaceMessage = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      channelId,
      sender,
      content,
      timestamp: new Date().toISOString(),
      meta
    };
    this.messages.get(channelId)!.push(message);
    
    this.emitEvent({
      type: "message.created",
      channelId,
      data: message as unknown as JsonValue
    });

    return message;
  }

  updateMessage(channelId: string, messageId: string, content: string) {
    const list = this.messages.get(channelId) || [];
    const msg = list.find(m => m.id === messageId);
    if (msg) {
      msg.content = content;
      this.emitEvent({
        type: "message.updated",
        channelId,
        data: msg as unknown as JsonValue
      });
    }
  }

  emitEvent(event: WorkspaceEvent) {
    this.emitter.emit(`event:${event.channelId}`, event);
    this.emitter.emit("event:*", event);
  }

  subscribe(channelId: string, listener: (event: WorkspaceEvent) => void): () => void {
    const eventKey = channelId === "*" ? "event:*" : `event:${channelId}`;
    this.emitter.on(eventKey, listener);
    return () => {
      this.emitter.off(eventKey, listener);
    };
  }

  saveArtifact(channelId: string, id: string, sender: WorkspaceMessageSender, content: string): WorkspaceArtifact {
    if (!this.channels.has(channelId)) {
      throw new Error(`Channel '${channelId}' does not exist.`);
    }
    if (!this.artifacts.has(channelId)) {
      this.artifacts.set(channelId, new Map());
    }
    const channelArtifacts = this.artifacts.get(channelId)!;
    
    let artifact = channelArtifacts.get(id);
    if (!artifact) {
      artifact = {
        id,
        channelId,
        versions: []
      };
      channelArtifacts.set(id, artifact);
    }
    
    const newVersionNum = artifact.versions.length + 1;
    const version: WorkspaceArtifactVersion = {
      version: newVersionNum,
      content,
      timestamp: new Date().toISOString(),
      sender
    };
    artifact.versions.push(version);
    
    this.emitEvent({
      type: "artifact.saved",
      channelId,
      data: {
        artifactId: id,
        version: newVersionNum,
        sender,
        timestamp: version.timestamp
      } as unknown as JsonValue
    });
    
    return artifact;
  }

  listArtifacts(channelId: string): WorkspaceArtifact[] {
    const channelArtifacts = this.artifacts.get(channelId);
    if (!channelArtifacts) return [];
    return Array.from(channelArtifacts.values());
  }

  getArtifact(channelId: string, id: string): WorkspaceArtifact | undefined {
    return this.artifacts.get(channelId)?.get(id);
  }

  getArtifactDiff(channelId: string, id: string, fromVersion: number, toVersion: number): string {
    const artifact = this.getArtifact(channelId, id);
    if (!artifact) {
      throw new Error(`Artifact '${id}' not found in channel '${channelId}'.`);
    }
    const fromVer = artifact.versions.find(v => v.version === fromVersion);
    const toVer = artifact.versions.find(v => v.version === toVersion);
    if (!fromVer || !toVer) {
      throw new Error(`Invalid version range: ${fromVersion} to ${toVersion}`);
    }
    return generateSimpleDiff(fromVer.content, toVer.content);
  }
}

export function generateSimpleDiff(oldStr: string, newStr: string): string {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  
  let i = m;
  let j = n;
  const diffLines: string[] = [];
  
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diffLines.push(`  ${oldLines[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffLines.push(`+ ${newLines[j - 1]}`);
      j--;
    } else if (i > 0 && (j === 0 || dp[i - 1][j] > dp[i][j - 1])) {
      diffLines.push(`- ${oldLines[i - 1]}`);
      i--;
    }
  }
  
  return diffLines.reverse().join("\n");
}

export class WorkspaceCoordinator {
  private activeRuns = new Set<string>();
  private runs = new Map<string, { status: "queued" | "in_progress" | "completed" | "failed"; error?: string }>();

  constructor(
    private bridge: AgentBridge,
    private workspace: WorkspaceManager
  ) {}

  getRun(runId: string) {
    return this.runs.get(runId);
  }

  /**
   * Orchestrates collaborative multi-agent execution triggered by a user message.
   * Runs the configured agents in sequence, streaming their updates in real-time.
   */
  async handleUserMessage(channelId: string, message: WorkspaceMessage, runtimes: string[], runId?: string): Promise<string> {
    const id = runId ?? `run_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    this.runs.set(id, { status: "queued" });

    // Execute the cascade in the background so it doesn't block the caller
    setImmediate(() => {
      this.runCascade(channelId, message, runtimes, id).catch(err => {
        this.runs.set(id, { status: "failed", error: err instanceof Error ? err.message : String(err) });
      });
    });

    return id;
  }

  private async runCascade(channelId: string, message: WorkspaceMessage, runtimes: string[], runId: string): Promise<void> {
    if (runtimes.length === 0) {
      this.runs.set(runId, { status: "completed" });
      return;
    }

    this.runs.set(runId, { status: "in_progress" });
    let previousAgentOutput = message.content;

    try {
      for (let i = 0; i < runtimes.length; i++) {
        const runtimeId = runtimes[i];
        
        // Check if runtime is registered
        const runtimesResult = (await this.bridge.listRuntimes()) as any;
        const info = runtimesResult?.runtimes?.find((r: any) => r.id === runtimeId);
        if (!info) {
          console.warn(`[WorkspaceCoordinator] Skipping unregistered runtime: ${runtimeId}`);
          continue;
        }

        // 1. Notify that the agent is starting to type/think
        this.workspace.emitEvent({
          type: "agent.state",
          channelId,
          data: { runtimeId, state: "typing" }
        });

        // 2. Create an empty message for the agent in the channel
        const agentMsg = this.workspace.postMessage(channelId, {
          type: "runtime",
          id: runtimeId,
          name: info.name ?? runtimeId
        }, "");

        let accumulatedContent = "";
        let method = "agent.stream";

        // Fallback method detection
        const methodsRes = (await this.bridge.listMethods(runtimeId)) as any;
        const runtimeInfo = methodsRes?.runtimes?.find((r: any) => r.runtime === runtimeId);
        const hasStream = runtimeInfo?.methods?.some((m: any) => m.name === "agent.stream");
        if (!hasStream) {
          method = "agent";
        }

        try {
          // Compose message: if it is the second agent in cascade, reference the previous output
          const prompt = i === 0 
            ? previousAgentOutput 
            : `请对前一位智能体的输出内容进行优化或审查：\n\n${previousAgentOutput}`;

          const req: BridgeRequest = {
            jsonrpc: "2.0",
            id: `ws_req_${Date.now()}_${i}`,
            runtime: runtimeId,
            method,
            params: { message: prompt }
          };

          if (method === "agent.stream") {
            const stream = await this.bridge.streamCall(req);
            for await (const event of stream) {
              if (event.type === "text" && typeof event.delta === "string") {
                accumulatedContent += event.delta;
                this.workspace.updateMessage(channelId, agentMsg.id, accumulatedContent);
              }
            }
          } else {
            const result = await this.bridge.handleRequest(req);
            if (isSuccessResponse(result)) {
              accumulatedContent = typeof result.result === "string" 
                ? result.result 
                : JSON.stringify(result.result, null, 2);
              this.workspace.updateMessage(channelId, agentMsg.id, accumulatedContent);
            } else {
              throw new Error(result.error?.message ?? "Request failed");
            }
          }

          previousAgentOutput = accumulatedContent;

        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          this.workspace.updateMessage(channelId, agentMsg.id, `⚠️ 智能体运行错误: ${errorMsg}`);
          previousAgentOutput = `[Error in step ${runtimeId}]`;
        } finally {
          // Notify that the agent is done typing
          this.workspace.emitEvent({
            type: "agent.state",
            channelId,
            data: { runtimeId, state: "idle" }
          });
        }
      }
      this.runs.set(runId, { status: "completed" });
    } catch (err) {
      this.runs.set(runId, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }
}
