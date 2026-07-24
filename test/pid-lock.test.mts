// test/pid-lock.test.mts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PidLock } from "../src/scheduling/pid-lock.ts";

test("acquire returns true for a free lock + writes the current pid", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidlock-"));
  const lock = join(dir, "schedules.lock");
  const pl = new PidLock();
  assert.equal(pl.acquire(lock), true);
  assert.equal(pl.isOwner(), true);
  assert.equal(readFileSync(lock, "utf8").trim(), String(process.pid));
  pl.release();
  rmSync(dir, { recursive: true, force: true });
});

test("acquire re-entrantly returns true when the lock is already owned by this pid", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidlock-"));
  const lock = join(dir, "schedules.lock");
  writeFileSync(lock, String(process.pid));
  const pl = new PidLock();
  assert.equal(pl.acquire(lock), true);
  assert.equal(pl.isOwner(), true);
  pl.release();
  rmSync(dir, { recursive: true, force: true });
});

test("acquire reclaims a stale pid (a dead process) and returns true", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidlock-"));
  const lock = join(dir, "schedules.lock");
  writeFileSync(lock, "99999999"); // a pid that definitely doesn't exist
  const pl = new PidLock();
  assert.equal(pl.acquire(lock), true);
  assert.equal(pl.isOwner(), true);
  pl.release();
  rmSync(dir, { recursive: true, force: true });
});

test("release removes the lock file when owner", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidlock-"));
  const lock = join(dir, "schedules.lock");
  const pl = new PidLock();
  pl.acquire(lock);
  pl.release();
  assert.throws(() => readFileSync(lock, "utf8"));
  rmSync(dir, { recursive: true, force: true });
});

test("acquire returns false when a different live pid owns the lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "pidlock-"));
  const lock = join(dir, "schedules.lock");
  // find a live pid that isn't us: the current process's parent is alive.
  const ppid = process.ppid;
  writeFileSync(lock, String(ppid));
  const pl = new PidLock();
  assert.equal(pl.acquire(lock), false);
  assert.equal(pl.isOwner(), false);
  // clean up the lock we didn't own (test hygiene)
  try { require("node:fs").unlinkSync(lock); } catch {}
  rmSync(dir, { recursive: true, force: true });
});