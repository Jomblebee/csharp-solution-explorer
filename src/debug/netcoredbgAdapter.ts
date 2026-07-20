// Supplies VS Code with the netcoredbg executable to talk DAP to. The download happens here, on
// the first debug session, rather than at activation — it is ~3.4 MB the user may never need.

import * as path from "node:path";
import * as vscode from "vscode";
import { exists } from "../shared/httpDownload.js";
import { detectRid } from "../languageServer/rid.js";
import { DebuggerStateStore } from "./debugState.js";
import { ensureDebuggerDownloaded, pruneDebuggerCache } from "./netcoredbgDownloader.js";
import { binaryRelPath, buildAdapterExecutable, DebugRid, NETCOREDBG_VERSION, toDebugRid } from "./netcoredbgPackage.js";

const CONFIG_SECTION = "csharpSolutionExplorer.debug";

export class NetcoredbgDescriptorFactory implements vscode.DebugAdapterDescriptorFactory {
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: DebuggerStateStore,
    private readonly output: vscode.OutputChannel,
  ) {}

  async createDebugAdapterDescriptor(): Promise<vscode.DebugAdapterDescriptor> {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const logging = config.get<boolean>("logging", false);

    const binaryPath = await this.resolveBinary(config);
    const { command, args } = buildAdapterExecutable(binaryPath, logging);
    this.output.appendLine(`Starting debug adapter: ${command} ${args.join(" ")}`);
    this.state.update({ phase: "debugging", activity: undefined, detail: undefined });
    return new vscode.DebugAdapterExecutable(command, args);
  }

  private async resolveBinary(config: vscode.WorkspaceConfiguration): Promise<string> {
    const override = config.get<string>("debuggerPath")?.trim();
    if (override) {
      // Accept either the executable itself or the directory it lives in.
      const rid = toDebugRid(detectRid()) ?? "linux-x64";
      const candidate = override.toLowerCase().endsWith("netcoredbg") || override.toLowerCase().endsWith("netcoredbg.exe")
        ? override
        : path.join(override, binaryRelPath(rid));
      if (!(await exists(candidate))) {
        throw new Error(`No netcoredbg executable was found at '${candidate}' (from the debuggerPath setting).`);
      }
      return candidate;
    }

    const rid = requireDebugRid();
    const version = config.get<string>("version")?.trim() || NETCOREDBG_VERSION;
    this.state.set({ phase: "downloading", rid, version, activity: "Downloading debugger…" });
    const resolved = await ensureDebuggerDownloaded(this.context.globalStorageUri, rid, version);
    this.state.set({ phase: "ready", rid, version });
    void pruneDebuggerCache(this.context.globalStorageUri, version).then((removed) => {
      if (removed.length > 0) {
        this.output.appendLine(`Removed cached debugger versions: ${removed.join(", ")}`);
      }
    });
    return resolved.binaryPath;
  }
}

/**
 * The current platform's RID, or an actionable error. Samsung publishes only four builds, so Intel
 * Macs, win-arm64 and musl-based Linux have no adapter — better a clear message naming the escape
 * hatch than a 404 or a cryptic loader failure.
 */
export function requireDebugRid(): DebugRid {
  const rid = toDebugRid(detectRid());
  if (rid) {
    return rid;
  }
  const musl = process.platform === "linux" ? " (musl-based distributions are not supported)" : "";
  throw new Error(
    `No netcoredbg build is published for ${process.platform}/${process.arch}${musl}. ` +
      "Build it from source (github.com/Samsung/netcoredbg) and set " +
      "'csharpSolutionExplorer.debug.debuggerPath'.",
  );
}
