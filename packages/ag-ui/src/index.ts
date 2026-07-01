import {
  A2UI_EVENT_NAME,
  createA2uiAgUiCustomValue,
  extractA2uiEnvelope
} from "@uab/a2ui";
import type { BridgeRequest, BridgeResponse, JsonObject, JsonValue } from "@uab/protocol";
import { isJsonObject } from "@uab/protocol";

export type AgUiEventType =
  | "RUN_STARTED"
  | "RUN_FINISHED"
  | "RUN_ERROR"
  | "STEP_STARTED"
  | "STEP_FINISHED"
  | "TEXT_MESSAGE_START"
  | "TEXT_MESSAGE_CONTENT"
  | "TEXT_MESSAGE_END"
  | "STATE_SNAPSHOT"
  | "CUSTOM"
  | "RAW";

export interface AgUiBaseEvent {
  type: AgUiEventType;
  timestamp?: number;
  rawEvent?: unknown;
}

export type AgUiEvent =
  | (AgUiBaseEvent & {
      type: "RUN_STARTED";
      threadId: string;
      runId: string;
      parentRunId?: string;
      input?: AgUiRunAgentInput;
    })
  | (AgUiBaseEvent & {
      type: "RUN_FINISHED";
      threadId: string;
      runId: string;
      result?: unknown;
    })
  | (AgUiBaseEvent & {
      type: "RUN_ERROR";
      message: string;
      code?: string;
    })
  | (AgUiBaseEvent & {
      type: "STEP_STARTED";
      stepName: string;
    })
  | (AgUiBaseEvent & {
      type: "STEP_FINISHED";
      stepName: string;
    })
  | (AgUiBaseEvent & {
      type: "TEXT_MESSAGE_START";
      messageId: string;
      role: "assistant";
    })
  | (AgUiBaseEvent & {
      type: "TEXT_MESSAGE_CONTENT";
      messageId: string;
      delta: string;
    })
  | (AgUiBaseEvent & {
      type: "TEXT_MESSAGE_END";
      messageId: string;
    })
  | (AgUiBaseEvent & {
      type: "STATE_SNAPSHOT";
      snapshot: unknown;
    })
  | (AgUiBaseEvent & {
      type: "CUSTOM";
      name: string;
      value: unknown;
    })
  | (AgUiBaseEvent & {
      type: "RAW";
      event: unknown;
      source?: string;
    });

export interface AgUiMessage {
  id?: string;
  role: "developer" | "system" | "assistant" | "user" | "tool" | "activity" | "reasoning";
  content?: unknown;
  [key: string]: unknown;
}

export interface AgUiContext {
  description?: string;
  value?: unknown;
  [key: string]: unknown;
}

export interface AgUiTool {
  name: string;
  description?: string;
  parameters?: unknown;
  [key: string]: unknown;
}

export interface AgUiRunAgentInput {
  threadId: string;
  runId: string;
  parentRunId?: string;
  state?: unknown;
  messages?: AgUiMessage[];
  tools?: AgUiTool[];
  context?: AgUiContext[];
  forwardedProps?: unknown;
}

export interface UniversalAgentRunInput extends AgUiRunAgentInput {
  runtime?: string;
  method?: string;
  params?: JsonValue;
}

export interface BridgeRunDescriptor {
  threadId: string;
  runId: string;
  parentRunId?: string;
  runtime: string;
  method: string;
  params: JsonValue;
  request: BridgeRequest;
}

export function createAgUiEvent<T extends AgUiEvent>(event: T): T {
  return {
    timestamp: Date.now(),
    ...event
  };
}

export function readBridgeRun(input: unknown): BridgeRunDescriptor {
  if (!isJsonObject(input)) {
    throw new Error("AG-UI run input must be an object.");
  }

  const agInput = input as Partial<UniversalAgentRunInput>;
  const forwarded = readForwardedUabProps(agInput.forwardedProps);
  const runtime = readNonEmptyString(agInput.runtime ?? forwarded.runtime, "runtime");
  const method = readNonEmptyString(agInput.method ?? forwarded.method, "method");
  const params = normalizeParams(agInput.params ?? forwarded.params ?? deriveParamsFromAgUi(method, agInput));
  const threadId = readOptionalString(agInput.threadId) ?? `thread_${runtime}`;
  const runId = readOptionalString(agInput.runId) ?? `run_${Date.now().toString(36)}`;
  const requestId = `${runId}_bridge`;

  return {
    threadId,
    runId,
    parentRunId: readOptionalString(agInput.parentRunId),
    runtime,
    method,
    params,
    request: {
      jsonrpc: "2.0",
      id: requestId,
      runtime,
      method,
      params,
      meta: {
        source: "ag-ui",
        traceId: `trace_${runId}`,
        threadId,
        runId
      }
    }
  };
}

export function bridgeResponseToAgUiText(response: BridgeResponse): string {
  if ("error" in response) {
    return response.error.message;
  }

  return extractText(response.result);
}

export function createBridgeRunEvents(
  input: AgUiRunAgentInput,
  descriptor: BridgeRunDescriptor,
  response: BridgeResponse
): AgUiEvent[] {
  const messageId = `msg_${descriptor.runId}`;
  const text = bridgeResponseToAgUiText(response);

  const events: AgUiEvent[] = [
    createAgUiEvent({
      type: "RUN_STARTED",
      threadId: descriptor.threadId,
      runId: descriptor.runId,
      parentRunId: descriptor.parentRunId,
      input
    }),
    createAgUiEvent({
      type: "STATE_SNAPSHOT",
      snapshot: {
        bridge: "universal-agent-bridge",
        runtime: descriptor.runtime,
        method: descriptor.method,
        status: "calling"
      }
    }),
    createAgUiEvent({
      type: "CUSTOM",
      name: "uab.request",
      value: {
        runtime: descriptor.runtime,
        method: descriptor.method,
        params: descriptor.params,
        requestId: descriptor.request.id
      }
    }),
    createAgUiEvent({
      type: "STEP_STARTED",
      stepName: "bridge.call"
    }),
    createAgUiEvent({
      type: "STEP_FINISHED",
      stepName: "bridge.call"
    })
  ];

  if ("error" in response) {
    events.push(
      createAgUiEvent({
        type: "CUSTOM",
        name: "uab.response",
        value: response
      }),
      createAgUiEvent({
        type: "RUN_ERROR",
        message: response.error.message,
        code: String(response.error.code)
      })
    );
    return events;
  }

  events.push(
    createAgUiEvent({
      type: "CUSTOM",
      name: "uab.response",
      value: response
    })
  );

  const a2uiEnvelope = extractA2uiEnvelope(response.result);
  if (a2uiEnvelope) {
    events.push(
      createAgUiEvent({
        type: "CUSTOM",
        name: A2UI_EVENT_NAME,
        value: createA2uiAgUiCustomValue(a2uiEnvelope)
      })
    );
  }

  events.push(
    createAgUiEvent({
      type: "TEXT_MESSAGE_START",
      messageId,
      role: "assistant"
    }),
    createAgUiEvent({
      type: "TEXT_MESSAGE_CONTENT",
      messageId,
      delta: text.length > 0 ? text : "Request completed."
    }),
    createAgUiEvent({
      type: "TEXT_MESSAGE_END",
      messageId
    }),
    createAgUiEvent({
      type: "RUN_FINISHED",
      threadId: descriptor.threadId,
      runId: descriptor.runId,
      result: response.result
    })
  );

  return events;
}

export function encodeSseEvent(event: AgUiEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function readForwardedUabProps(value: unknown): {
  runtime?: unknown;
  method?: unknown;
  params?: unknown;
} {
  if (!isJsonObject(value)) return {};
  const uab = value.uab;
  if (!isJsonObject(uab)) return {};
  return {
    runtime: uab.runtime,
    method: uab.method,
    params: uab.params
  };
}

function readNonEmptyString(value: unknown, key: string): string {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  throw new Error(`AG-UI forwardedProps.uab.${key} is required.`);
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  return undefined;
}

function normalizeParams(value: unknown): JsonValue {
  if (value === undefined) return {};
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function deriveParamsFromAgUi(
  method: string,
  input: Partial<UniversalAgentRunInput>
): JsonObject {
  const messages = input.messages ?? [];
  const latestText = readLatestUserText(messages);

  if (method === "chat.completions.create") {
    return {
      messages: normalizeParams(messages
        .filter((message) => ["system", "assistant", "user"].includes(message.role))
        .map((message) => ({
          role: message.role,
          content: message.content ?? ""
        }))),
      stream: false
    };
  }

  if (method === "responses.create" || method === "runs.create") {
    return {
      input: latestText
    };
  }

  return {};
}

function readLatestUserText(messages: AgUiMessage[]): string {
  const userMessage = [...messages].reverse().find((message) => message.role === "user");
  if (!userMessage) return "";
  return stringifyContent(userMessage.content);
}

function extractText(value: unknown): string {
  if (typeof value === "string") return value;
  if (isJsonObject(value)) {
    const output = value.output;
    if (typeof output === "string") return output;

    const message = value.message;
    if (isJsonObject(message)) {
      const content = message.content;
      if (typeof content === "string") return content;
    }

    const choices = value.choices;
    if (Array.isArray(choices)) {
      const first = choices[0];
      if (isJsonObject(first) && isJsonObject(first.message)) {
        const content = first.message.content;
        if (typeof content === "string") return content;
      }
    }
  }

  return JSON.stringify(value, null, 2);
}

function stringifyContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === "string") return entry;
        if (isJsonObject(entry) && typeof entry.text === "string") return entry.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return value === undefined || value === null ? "" : String(value);
}
