import { dirname, join, win32 } from "node:path";

export const serviceLabel = "com.codex.wechat-bridge";
export const windowsTaskName = "CodexWechatBridge";

export type ServicePaths = {
  nodePath: string;
  projectDir: string;
  dataDir: string;
  workspace: string;
};

export type MacServiceCommandOptions = {
  plistPath: string;
  uidCommand?: string;
};

export type MacServiceCommands = {
  install: string[];
  installSequence: string[][];
  restart: string[];
  uninstall: string[];
  status: string[];
};

export type WindowsServiceCommands = {
  install: string[];
  start: string[];
  stop: string[];
  restart: string[][];
  uninstall: string[];
  status: string[];
};

export function buildLaunchAgentPlist(paths: ServicePaths): string {
  const cliPath = join(paths.projectDir, "dist", "cli.js");
  const stdoutPath = join(paths.dataDir, "logs", "launchd.out.log");
  const stderrPath = join(paths.dataDir, "logs", "launchd.err.log");
  const home = inferHome(paths.dataDir);
  const pathValue = launchdPath(paths.nodePath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapePlist(serviceLabel)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/env</string>
    <string>-i</string>
    <string>HOME=${escapePlist(home)}</string>
    <string>USER=${escapePlist(userFromHome(home))}</string>
    <string>LOGNAME=${escapePlist(userFromHome(home))}</string>
    <string>SHELL=/bin/zsh</string>
    <string>PATH=${escapePlist(pathValue)}</string>
    <string>${escapePlist(paths.nodePath)}</string>
    <string>${escapePlist(cliPath)}</string>
    <string>run</string>
    <string>--data-dir</string>
    <string>${escapePlist(paths.dataDir)}</string>
    <string>--cwd</string>
    <string>${escapePlist(paths.workspace)}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${escapePlist(paths.projectDir)}</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${escapePlist(stdoutPath)}</string>

  <key>StandardErrorPath</key>
  <string>${escapePlist(stderrPath)}</string>
</dict>
</plist>
`;
}

export function buildMacServiceCommands(options: MacServiceCommandOptions): MacServiceCommands {
  const domain = `gui/${options.uidCommand ?? "$(id -u)"}`;
  const target = `${domain}/${serviceLabel}`;
  return {
    install: ["launchctl", "bootstrap", domain, options.plistPath],
    installSequence: [
      ["launchctl", "bootout", target],
      ["launchctl", "bootstrap", domain, options.plistPath],
      ["launchctl", "kickstart", "-k", target]
    ],
    restart: ["launchctl", "kickstart", "-k", target],
    uninstall: ["launchctl", "bootout", target],
    status: ["launchctl", "print", target]
  };
}

export function buildWindowsServiceCommands(paths: ServicePaths): WindowsServiceCommands {
  const taskCommand = [
    quoteWindowsArg(paths.nodePath),
    quoteWindowsArg(win32.join(paths.projectDir, "dist", "cli.js")),
    "run",
    "--data-dir",
    quoteWindowsArg(paths.dataDir),
    "--cwd",
    quoteWindowsArg(paths.workspace)
  ].join(" ");
  return {
    install: ["schtasks", "/Create", "/TN", windowsTaskName, "/SC", "ONLOGON", "/TR", taskCommand, "/F"],
    start: ["schtasks", "/Run", "/TN", windowsTaskName],
    stop: ["schtasks", "/End", "/TN", windowsTaskName],
    restart: [
      ["schtasks", "/End", "/TN", windowsTaskName],
      ["schtasks", "/Run", "/TN", windowsTaskName]
    ],
    uninstall: ["schtasks", "/Delete", "/TN", windowsTaskName, "/F"],
    status: ["schtasks", "/Query", "/TN", windowsTaskName, "/V", "/FO", "LIST"]
  };
}

function escapePlist(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&apos;");
}

function quoteWindowsArg(value: string): string {
  return `"${value.replaceAll("\"", "\\\"")}"`;
}

function inferHome(dataDir: string): string {
  const marker = "/.codex-wechat-bridge";
  const index = dataDir.indexOf(marker);
  return index > 0 ? dataDir.slice(0, index) : dirname(dataDir);
}

function userFromHome(home: string): string {
  return home.split("/").filter(Boolean).at(-1) ?? "";
}

function launchdPath(nodePath: string): string {
  const nodeDir = dirname(nodePath);
  return [
    nodeDir,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin"
  ].filter((entry, index, entries) => entries.indexOf(entry) === index).join(":");
}
