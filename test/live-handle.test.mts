// test/live-handle.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toLiveHandle, type ChildSession, type LiveSessionHandle } from "../src/engine/spawnSubagent.ts";

/** A fake ChildSession that HAS steer + isStreaming (stands in for the pi backend). */
function steerableChild(streaming = true): ChildSession {
  let _streaming = streaming;
  return {
    prompt: async () => {},
    subscribe: () => () => {},
    abort: async () => {},
    dispose: () => {},
    steer: async (_t: string) => {},
    get isStreaming() { return _streaming; },
    set isStreaming(v: boolean) { _streaming = v; },
  };
}

/** A fake ChildSession that LACKS steer + isStreaming (stands in for the claude backend). */
function bareChild(): ChildSession {
  return {
    prompt: async () => {},
    subscribe: () => () => {},
    abort: async () => {},
    dispose: () => {},
  };
}

test("toLiveHandle: steerable child → supportsSteer true, steer forwards, isStreaming reflects live", async () => {
  const child = steerableChild(true);
  const h = toLiveHandle(child);
  assert.equal(h.supportsSteer, true);
  let steered = "";
  (child as any).steer = async (t: string) => { steered = t; };
  await h.steer("redirect now");
  assert.equal(steered, "redirect now");
  assert.equal(h.isStreaming, true);
  (child as any).isStreaming = false;
  assert.equal(h.isStreaming, false, "isStreaming is live (getter), not captured");
});

test("toLiveHandle: bare child → supportsSteer false, steer rejects, isStreaming defaults false", async () => {
  const h = toLiveHandle(bareChild());
  assert.equal(h.supportsSteer, false);
  assert.equal(h.isStreaming, false);
  await assert.rejects(() => h.steer("x"), /steer not supported/);
});

test("toLiveHandle: abort + subscribe forward to the wrapped child", async () => {
  let aborted = false;
  let subbed = false;
  const child: ChildSession = {
    prompt: async () => {},
    subscribe: () => { subbed = true; return () => {}; },
    abort: async () => { aborted = true; },
    dispose: () => {},
  };
  const h = toLiveHandle(child);
  await h.abort();
  assert.equal(aborted, true);
  h.subscribe(() => {});
  assert.equal(subbed, true);
});

test("toLiveHandle: steer rejects when child.steer is present but throws", async () => {
  const child: ChildSession = {
    prompt: async () => {},
    subscribe: () => () => {},
    abort: async () => {},
    dispose: () => {},
    steer: async () => { throw new Error("sdk says no"); },
  };
  const h = toLiveHandle(child);
  assert.equal(h.supportsSteer, true);
  await assert.rejects(() => h.steer("x"), /sdk says no/);
});