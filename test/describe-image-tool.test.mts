// describe-image-tool.test.mts — the fleet-defined describe_image tool.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDescribeImageTool } from "../src/vision/describe-image-tool.ts";

test("describe_image delegates via VisionPort and returns text", async () => {
  const port = { isMultimodal: () => false, isConfigured: () => true, delegate: async () => ({ ok: true, text: "a cat on a laptop" }) } as any;
  const tool = createDescribeImageTool(port);
  const result = await tool.execute("t1", { image: "/tmp/x.png" }, undefined as any, undefined, undefined as any);
  assert.equal(result.content[0]?.text, "a cat on a laptop");
  assert.equal(result.isError, undefined);
});

test("describe_image returns actionable error when not configured", async () => {
  const port = { isMultimodal: () => false, isConfigured: () => false, delegate: async () => ({ ok: false, error: "no vision model configured" }) } as any;
  const tool = createDescribeImageTool(port);
  const result = await tool.execute("t1", { image: "/tmp/x.png" }, undefined as any, undefined, undefined as any) as any;
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /no vision model configured/);
});

test("describe_image surfaces a delegation failure as an actionable error", async () => {
  const port = { isMultimodal: () => false, isConfigured: () => true, delegate: async () => ({ ok: false, error: "vision model returned 500" }) } as any;
  const tool = createDescribeImageTool(port);
  const result = await tool.execute("t1", { image: "/tmp/x.png" }, undefined as any, undefined, undefined as any) as any;
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /vision model returned 500/);
});