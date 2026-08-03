import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import {
  controllerFixture,
  atomicSaveFixture,
  PROJECT_SOURCE,
  UPDATED_SOURCE,
} from "./helpers/workflow-controller-fixture.mts"

test("save is atomic, refuses overwrite, and removes temporary files", () => {
  const dir = mkdtempSync(join(tmpdir(), "wf-save-"))
  const { controller, registry, cleanup } = controllerFixture({ projectDir: dir })
  try {
    const saved = controller.save({ name: "code-review", source: PROJECT_SOURCE })
    assert.equal(saved.source, "project")
    assert.equal(registry.get("code-review")?.source, "project")
    assert.throws(
      () => controller.save({ name: "code-review", source: PROJECT_SOURCE }),
      /overwrite:true/,
    )
    assert.doesNotThrow(() =>
      controller.save({ name: "code-review", source: UPDATED_SOURCE, overwrite: true }),
    )
    assert.deepEqual(
      readdirSync(dir).filter((f) => f.includes(".tmp-")),
      [],
    )
  } finally {
    cleanup()
  }
})

test("rename failure preserves the prior target and removes only the temporary file", () => {
  const { saveFixture, targetPath, cleanup } = atomicSaveFixture({
    renameError: new Error("disk full"),
  })
  try {
    writeFileSync(targetPath, UPDATED_SOURCE, "utf8")
    assert.throws(
      () => saveFixture({ name: "code-review", source: PROJECT_SOURCE, overwrite: true }),
      /disk full/,
    )
    assert.equal(readFileSync(targetPath, "utf8"), UPDATED_SOURCE)
    assert.deepEqual(
      readdirSync(dirname(targetPath)).filter((f) => f.includes(".tmp-")),
      [],
    )
  } finally {
    cleanup()
  }
})
