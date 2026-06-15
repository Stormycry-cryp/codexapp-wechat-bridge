import { describe, expect, it } from "vitest";
import {
  buildLaunchAgentPlist,
  buildMacServiceCommands,
  buildWindowsServiceCommands,
  serviceLabel,
  windowsTaskName
} from "../src/service.js";

describe("service helpers", () => {
  it("builds a launchd plist that runs the compiled bridge with explicit paths", () => {
    const plist = buildLaunchAgentPlist({
      nodePath: "/opt/homebrew/bin/node",
      projectDir: "/Users/me/codex-wechat-bridge",
      dataDir: "/Users/me/.codex-wechat-bridge",
      workspace: "/Users/me/workspace"
    });

    expect(plist).toContain(`<string>${serviceLabel}</string>`);
    expect(plist).toContain("<string>/usr/bin/env</string>");
    expect(plist).toContain("<string>-i</string>");
    expect(plist).toContain("<string>HOME=/Users/me</string>");
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain("<string>/Users/me/codex-wechat-bridge/dist/cli.js</string>");
    expect(plist).toContain("<string>--data-dir</string>");
    expect(plist).toContain("<string>/Users/me/.codex-wechat-bridge</string>");
    expect(plist).toContain("<string>/Users/me/workspace</string>");
    expect(plist).toContain("<key>KeepAlive</key>");
  });

  it("escapes launchd plist values", () => {
    const plist = buildLaunchAgentPlist({
      nodePath: "/node",
      projectDir: "/tmp/A&B",
      dataDir: "/tmp/data",
      workspace: "/tmp/<workspace>"
    });

    expect(plist).toContain("/tmp/A&amp;B/dist/cli.js");
    expect(plist).toContain("/tmp/&lt;workspace&gt;");
  });

  it("builds macOS service commands without hard-coding the current uid", () => {
    const commands = buildMacServiceCommands({
      plistPath: "/Users/me/Library/LaunchAgents/com.codex.wechat-bridge.plist",
      uidCommand: "$(id -u)"
    });

    expect(commands.install).toEqual([
      "launchctl",
      "bootstrap",
      "gui/$(id -u)",
      "/Users/me/Library/LaunchAgents/com.codex.wechat-bridge.plist"
    ]);
    expect(commands.installSequence).toEqual([
      ["launchctl", "bootout", `gui/$(id -u)/${serviceLabel}`],
      ["launchctl", "bootstrap", "gui/$(id -u)", "/Users/me/Library/LaunchAgents/com.codex.wechat-bridge.plist"],
      ["launchctl", "kickstart", "-k", `gui/$(id -u)/${serviceLabel}`]
    ]);
    expect(commands.restart).toEqual([
      "launchctl",
      "kickstart",
      "-k",
      `gui/$(id -u)/${serviceLabel}`
    ]);
    expect(commands.uninstall).toEqual([
      "launchctl",
      "bootout",
      `gui/$(id -u)/${serviceLabel}`
    ]);
  });

  it("builds Windows Task Scheduler commands for the compiled bridge", () => {
    const commands = buildWindowsServiceCommands({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      projectDir: "C:\\Users\\me\\codex-wechat-bridge",
      dataDir: "C:\\Users\\me\\.codex-wechat-bridge",
      workspace: "C:\\Users\\me\\workspace"
    });

    expect(commands.install).toEqual([
      "schtasks",
      "/Create",
      "/TN",
      windowsTaskName,
      "/SC",
      "ONLOGON",
      "/TR",
      `"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\codex-wechat-bridge\\dist\\cli.js" run --data-dir "C:\\Users\\me\\.codex-wechat-bridge" --cwd "C:\\Users\\me\\workspace"`,
      "/F"
    ]);
    expect(commands.start).toEqual(["schtasks", "/Run", "/TN", windowsTaskName]);
    expect(commands.stop).toEqual(["schtasks", "/End", "/TN", windowsTaskName]);
    expect(commands.uninstall).toEqual(["schtasks", "/Delete", "/TN", windowsTaskName, "/F"]);
  });
});
