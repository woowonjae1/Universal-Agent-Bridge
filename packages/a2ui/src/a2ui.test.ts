import assert from "node:assert/strict";
import test from "node:test";
import {
  A2UI_EVENT_NAME,
  extractA2uiEnvelope,
  sanitizeA2uiEnvelope
} from "./index.js";

test("sanitizes a createSurface envelope", () => {
  const envelope = sanitizeA2uiEnvelope({
    version: "1.0",
    type: "createSurface",
    surfaceId: "demo",
    components: [
      {
        type: "card",
        title: "Agent plan",
        children: [
          { type: "heading", text: "Next actions" },
          { type: "text", text: "Review adapter output." }
        ]
      }
    ],
    dataModel: {
      status: "ready"
    }
  });

  assert.equal(envelope?.type, "createSurface");
  assert.equal(envelope?.components?.[0]?.type, "card");
  assert.equal(envelope?.dataModel?.status, "ready");
});

test("drops unsupported components and script-like fields", () => {
  const envelope = sanitizeA2uiEnvelope({
    version: "1.0",
    type: "createSurface",
    surfaceId: "unsafe",
    components: [
      {
        type: "html",
        html: "<script>alert(1)</script>"
      },
      {
        type: "text",
        text: "safe",
        onClick: "bad",
        props: {
          script: "bad",
          label: "kept"
        }
      }
    ],
    dataModel: {
      onclick: "bad",
      value: "kept"
    }
  });

  assert.equal(envelope?.components?.length, 1);
  assert.equal(envelope?.components?.[0]?.type, "text");
  assert.deepEqual(envelope?.components?.[0]?.props, { label: "kept" });
  assert.deepEqual(envelope?.dataModel, { value: "kept" });
});

test("extracts nested a2ui envelopes", () => {
  const envelope = extractA2uiEnvelope({
    output: "Rendered a surface.",
    a2ui: {
      version: "1.0",
      type: "updateDataModel",
      surfaceId: "demo",
      dataModel: {
        count: 1
      }
    }
  });

  assert.equal(A2UI_EVENT_NAME, "a2ui.envelope");
  assert.equal(envelope?.type, "updateDataModel");
  assert.equal(envelope?.dataModel?.count, 1);
});
