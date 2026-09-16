import type { BridgeSpanExporter, BridgeSpan } from "./observability.js";

export class OpenTelemetrySpanExporter implements BridgeSpanExporter {
  private api: any = null;
  private tracer: any = null;
  private initialized = false;

  constructor() {
    this.init().catch(() => {
      // Ignore initialization errors
    });
  }

  private async init() {
    try {
      const moduleName = "@opentelemetry/api";
      this.api = await import(moduleName);
      if (this.api && this.api.trace) {
        this.tracer = this.api.trace.getTracer("universal-agent-bridge");
      }
    } catch (err) {
      // OpenTelemetry API not installed in the target environment
    } finally {
      this.initialized = true;
    }
  }

  async export(span: BridgeSpan): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
    if (!this.tracer) {
      // Fallback: if OTel is not present, we do not export
      return;
    }

    try {
      const startTime = new Date(span.startTime);
      const endTime = new Date(span.endTime);

      const otelSpan = this.tracer.startSpan(span.name, {
        startTime,
        attributes: span.attributes
      });

      if (span.status === "error") {
        // SpanStatusCode.ERROR = 2
        otelSpan.setStatus({ code: 2, message: String(span.attributes["uab.error_code"] ?? "Span error") });
      } else {
        // SpanStatusCode.OK = 1
        otelSpan.setStatus({ code: 1 });
      }

      otelSpan.end(endTime);
    } catch (err) {
      console.error("[OpenTelemetrySpanExporter] Failed to export span to OpenTelemetry API:", err);
    }
  }
}
