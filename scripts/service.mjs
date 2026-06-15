#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  buildLaunchAgentPlist,
  buildMacServiceCommands,
  buildWindowsServiceCommands,
  serviceLabel,
  windowsTaskName
} from "../dist/service.js";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "help";
const args = process.argv.slice(3);
const options = parseOptions(args);

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
  process.exit(0);
}

const servicePaths = {
  nodePath: options.nodePath ?? process.execPath,
  projectDir,
  dataDir: options.dataDir ?? resolve(homedir(), ".codex-wechat-bridge"),
  workspace: options.cwd ?? process.cwd()
};

if (process.platform === "darwin") {
  await runMac(command, servicePaths, options);
} else if (process.platform === "win32") {
  await runWindows(command, servicePaths, options);
} else {
  throw new Error(`Unsupported platform for persistent service: ${process.platform}`);
}

async function runMac(action, paths, opts) {
  const plistPath = opts.plistPath ?? resolve(homedir(), "Library", "LaunchAgents", `${serviceLabel}.plist`);
  const commands = buildMacServiceCommands({ plistPath, uidCommand: String(process.getuid?.() ?? "$(id -u)") });
  if (action === "install") {
    if (opts.dryRun) {
      console.log(`LaunchAgent would be written: ${plistPath}`);
    } else {
      await mkdir(dirname(plistPath), { recursive: true });
      await mkdir(resolve(paths.dataDir, "logs"), { recursive: true });
      await writeFile(plistPath, buildLaunchAgentPlist(paths), "utf8");
      console.log(`LaunchAgent written: ${plistPath}`);
    }
    for (const commandLine of commands.installSequence) {
      runCommand(commandLine, { ...opts, allowFailure: commandLine[1] === "bootout" });
    }
    return;
  }
  if (action === "start" || action === "restart") {
    runCommand(commands.restart, opts);
    return;
  }
  if (action === "stop" || action === "uninstall") {
    runCommand(commands.uninstall, { ...opts, allowFailure: action === "stop" });
    return;
  }
  if (action === "status") {
    runCommand(commands.status, { ...opts, allowFailure: true });
    return;
  }
  throw new Error(`Unknown service command: ${action}`);
}

async function runWindows(action, paths, opts) {
  const commands = buildWindowsServiceCommands(paths);
  if (action === "install") {
    await mkdir(resolve(paths.dataDir, "logs"), { recursive: true });
    runCommand(commands.install, opts);
    runCommand(commands.start, { ...opts, allowFailure: true });
    return;
  }
  if (action === "start") {
    runCommand(commands.start, opts);
    return;
  }
  if (action === "stop") {
    runCommand(commands.stop, { ...opts, allowFailure: true });
    return;
  }
  if (action === "restart") {
    for (const commandLine of commands.restart) {
      runCommand(commandLine, { ...opts, allowFailure: commandLine[1] === "/End" });
    }
    return;
  }
  if (action === "uninstall") {
    runCommand(commands.uninstall, opts);
    return;
  }
  if (action === "status") {
    runCommand(commands.status, { ...opts, allowFailure: true });
    return;
  }
  throw new Error(`Unknown service command: ${action}`);
}

function runCommand(commandLine, opts) {
  console.log(formatCommand(commandLine));
  if (opts.dryRun) return;
  const result = spawnSync(commandLine[0], commandLine.slice(1), { stdio: "inherit" });
  if (result.status !== 0 && !opts.allowFailure) {
    throw new Error(`Command failed: ${formatCommand(commandLine)}`);
  }
}

function parseOptions(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if ((arg === "--cwd" || arg === "-C") && next) {
      options.cwd = resolve(next);
      index += 1;
    } else if (arg === "--data-dir" && next) {
      options.dataDir = resolve(next);
      index += 1;
    } else if (arg === "--node" && next) {
      options.nodePath = resolve(next);
      index += 1;
    } else if (arg === "--plist" && next) {
      options.plistPath = resolve(next);
      index += 1;
    }
  }
  return options;
}

function formatCommand(commandLine) {
  return commandLine.map((part) => /[\s"]/u.test(part) ? `'${part.replaceAll("'", "'\\''")}'` : part).join(" ");
}

function printHelp() {
  console.log(`codex-wechat-bridge service

Usage:
  node scripts/service.mjs install [--cwd DIR] [--data-dir DIR] [--dry-run]
  node scripts/service.mjs start
  node scripts/service.mjs stop
  node scripts/service.mjs restart
  node scripts/service.mjs status
  node scripts/service.mjs uninstall

macOS:
  Installs LaunchAgent ${serviceLabel}.

Windows:
  Installs Task Scheduler task ${windowsTaskName}.
`);
}
