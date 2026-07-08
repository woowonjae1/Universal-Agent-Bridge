import type {
  AgentRuntimeAdapter,
  RuntimeMethodDefinition,
  RuntimeCapabilities,
  AdapterCallRequest,
  AdapterCallContext,
  AdapterHealth
} from "@uab/adapter-sdk";
import { isJsonObject } from "@uab/protocol";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

// Cross-platform Clipboard Helpers
function writeClipboard(text: string): void {
  if (process.platform === "win32") {
    const escaped = text.replace(/'/g, "''").replace(/"/g, '`"');
    execSync(`powershell -NoProfile -Command "Set-Clipboard -Value \\"${escaped}\\""`);
  } else if (process.platform === "darwin") {
    execSync("pbcopy", { input: text });
  } else {
    try {
      execSync("xclip -selection clipboard", { input: text });
    } catch {
      execSync("xsel --clipboard --input", { input: text });
    }
  }
}

function readClipboard(): string {
  if (process.platform === "win32") {
    return execSync("powershell -NoProfile -Command \"Get-Clipboard\"").toString().trim();
  } else if (process.platform === "darwin") {
    return execSync("pbpaste").toString();
  } else {
    try {
      return execSync("xclip -o -selection clipboard").toString();
    } catch {
      return execSync("xsel --clipboard --output").toString();
    }
  }
}

// Cross-platform Desktop Notification Helper
function sendNotification(title: string, message: string): void {
  if (process.platform === "win32") {
    const escapedTitle = title.replace(/'/g, "''").replace(/"/g, '`"');
    const escapedMsg = message.replace(/'/g, "''").replace(/"/g, '`"');
    const psCmd = `
      [void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');
      $notification = New-Object System.Windows.Forms.NotifyIcon;
      $notification.Icon = [System.Drawing.SystemIcons]::Information;
      $notification.BalloonTipIcon = 'Info';
      $notification.BalloonTipTitle = \\"${escapedTitle}\\";
      $notification.BalloonTipText = \\"${escapedMsg}\\";
      $notification.Visible = $true;
      $notification.ShowBalloonTip(5000);
    `.replace(/\s+/g, ' ');
    try {
      execSync(`powershell -NoProfile -Command "${psCmd}"`);
    } catch {
      // ignore
    }
  } else if (process.platform === "darwin") {
    const escapedTitle = title.replace(/"/g, '\\"');
    const escapedMsg = message.replace(/"/g, '\\"');
    execSync(`osascript -e 'display notification "${escapedMsg}" with title "${escapedTitle}"'`);
  } else {
    try {
      execSync(`notify-send "${title}" "${message}"`);
    } catch {
      // ignore
    }
  }
}

const METHODS: RuntimeMethodDefinition[] = [
  {
    name: "read_file",
    title: "Read File",
    description: "Read content of a local file.",
    capability: "system",
    risk: "read",
    paramsSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of file to read" }
      },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    title: "Write File",
    description: "Write content to a local file.",
    capability: "system",
    risk: "write",
    paramsSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path of file to write" },
        content: { type: "string", description: "Content to write" }
      },
      required: ["path", "content"]
    }
  },
  {
    name: "list_dir",
    title: "List Directory",
    description: "List contents of a directory.",
    capability: "system",
    risk: "read",
    paramsSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute directory path" }
      },
      required: ["path"]
    }
  },
  {
    name: "exec",
    title: "Execute Command",
    description: "Run a CLI shell command on the host OS.",
    capability: "system",
    risk: "admin",
    paramsSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute" }
      },
      required: ["command"]
    }
  },
  {
    name: "clipboard_read",
    title: "Read Clipboard",
    description: "Get text currently stored in system clipboard.",
    capability: "system",
    risk: "read",
    paramsSchema: {
      type: "object",
      properties: {}
    }
  },
  {
    name: "clipboard_write",
    title: "Write Clipboard",
    description: "Set system clipboard text.",
    capability: "system",
    risk: "write",
    paramsSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text content to write to clipboard" }
      },
      required: ["text"]
    }
  },
  {
    name: "notify",
    title: "Send Notification",
    description: "Trigger a desktop notification bubble.",
    capability: "system",
    risk: "write",
    paramsSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Notification title" },
        message: { type: "string", description: "Notification message text" }
      },
      required: ["title", "message"]
    }
  }
];

export function createHostAdapter(): AgentRuntimeAdapter {
  return {
    info: {
      id: "host",
      name: "Host System Adapter",
      version: "0.1.0",
      description: "Direct OS interface adapter for Universal Agent Bridge."
    },
    capabilities(): RuntimeCapabilities {
      return {
        system: { read: true, write: true, admin: true, description: "System execution capabilities" }
      };
    },
    methods(): RuntimeMethodDefinition[] {
      return METHODS;
    },
    health(): AdapterHealth {
      return { status: "ok" };
    },
    call(request: AdapterCallRequest): unknown {
      const params = isJsonObject(request.params) ? request.params : {};
      
      switch (request.method) {
        case "read_file": {
          const filePath = String(params.path);
          return fs.readFileSync(filePath, "utf8");
        }
        case "write_file": {
          const filePath = String(params.path);
          const content = String(params.content);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          fs.writeFileSync(filePath, content, "utf8");
          return { success: true, path: filePath };
        }
        case "list_dir": {
          const dirPath = String(params.path);
          return fs.readdirSync(dirPath).map(name => {
            const stat = fs.statSync(path.join(dirPath, name));
            return {
              name,
              isDirectory: stat.isDirectory(),
              size: stat.size
            };
          });
        }
        case "exec": {
          const cmd = String(params.command);
          const output = execSync(cmd, { encoding: "utf8" });
          return { stdout: output };
        }
        case "clipboard_read": {
          return { text: readClipboard() };
        }
        case "clipboard_write": {
          writeClipboard(String(params.text));
          return { success: true };
        }
        case "notify": {
          sendNotification(String(params.title), String(params.message));
          return { success: true };
        }
        default:
          throw new Error(`Method '${request.method}' not supported by Host adapter.`);
      }
    }
  };
}
