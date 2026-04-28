import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { JsonLineRpcClient } from "../src/codex/json-line-rpc.js";

describe("JsonLineRpcClient", () => {
  it("writes newline-delimited JSON-RPC requests and resolves matching responses", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonLineRpcClient(input, output);

    const response = client.request("thread/list", { limit: 5 });
    const sent = JSON.parse(input.read().toString("utf8"));

    expect(sent).toMatchObject({ id: 1, method: "thread/list", params: { limit: 5 } });
    output.write(JSON.stringify({ id: 1, result: { threads: [] } }) + "\n");

    await expect(response).resolves.toEqual({ threads: [] });
  });

  it("emits server requests with ids and writes responses", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const client = new JsonLineRpcClient(input, output);
    const onRequest = vi.fn((id: number | string, method: string, params: unknown) => {
      client.respond(id, { decision: "accept" });
      expect(method).toBe("item/commandExecution/requestApproval");
      expect(params).toMatchObject({ command: "mv file target" });
    });
    client.on("request", onRequest);

    output.write(JSON.stringify({
      id: 9,
      method: "item/commandExecution/requestApproval",
      params: { command: "mv file target" }
    }) + "\n");

    expect(onRequest).toHaveBeenCalledTimes(1);
    expect(JSON.parse(input.read().toString("utf8"))).toEqual({
      id: 9,
      result: { decision: "accept" }
    });
  });
});
