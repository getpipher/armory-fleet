// SPEC-6-3 §6 — atomic workflow save with an injectable fs port for deterministic failure tests.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { join } from "node:path"
import { randomBytes } from "node:crypto"

import { parseWorkflowSource, validateWorkflowName } from "../source.ts"
import type { WorkflowDef, WorkflowSource } from "../registry.ts"

export interface SaveFs {
  existsSync(path: string): boolean
  mkdirSync(path: string, opts: { recursive: boolean }): void
  openSync(path: string, flags: string): number
  writeSync(fd: number, data: string): number
  closeSync(fd: number): void
  renameSync(oldPath: string, newPath: string): void
  unlinkSync(path: string): void
  readdirSync(path: string): string[]
  readFileSync(path: string, encoding: string): string
  writeFileSync(path: string, data: string, encoding: string): void
}

export const NODE_SAVE_FS: SaveFs = {
  existsSync,
  mkdirSync: (p, o) => mkdirSync(p, o),
  openSync,
  writeSync,
  closeSync,
  renameSync,
  unlinkSync,
  readdirSync,
  readFileSync: (p, enc) => readFileSync(p, enc as BufferEncoding),
  writeFileSync: (p, data, enc) => writeFileSync(p, data, enc as BufferEncoding),
}

export interface SaveInput {
  name: string
  source: string
  overwrite?: boolean
  /** Target directory for the workflow file. Defaults to process.cwd(). */
  dir?: string
}

export function saveWorkflowAtomic(input: SaveInput, fsOps: SaveFs = NODE_SAVE_FS): WorkflowDef {
  validateWorkflowName(input.name)

  const filePath = `${input.name}.js`
  const parsed = parseWorkflowSource(input.source, { filePath, requireMeta: true })
  if (!parsed.meta) throw new Error(`${filePath}: missing meta`)
  if (parsed.meta.name !== input.name) {
    throw new Error(`meta.name '${parsed.meta.name}' does not match save name '${input.name}'`)
  }

  const targetDir = input.dir ?? process.cwd()
  const targetPath = join(targetDir, filePath)

  fsOps.mkdirSync(targetDir, { recursive: true })

  if (fsOps.existsSync(targetPath) && !input.overwrite) {
    throw new Error(`workflow '${input.name}' already exists; set overwrite:true to replace`)
  }

  const nonce = randomBytes(6).toString("hex")
  const tempName = `.${input.name}.tmp-${process.pid}-${nonce}`
  const tempPath = join(targetDir, tempName)

  let fd: number | undefined
  try {
    fd = fsOps.openSync(tempPath, "w")
    fsOps.writeSync(fd, input.source)
    fsOps.closeSync(fd)
    fd = undefined
    fsOps.renameSync(tempPath, targetPath)
  } catch (e) {
    if (fd !== undefined) {
      try {
        fsOps.closeSync(fd)
      } catch {
        // best-effort
      }
    }
    try {
      fsOps.unlinkSync(tempPath)
    } catch {
      // best-effort — never mask the original error
    }
    throw e
  }

  const source: WorkflowSource = "project"
  return {
    name: parsed.meta.name,
    description: parsed.meta.description,
    phases: parsed.meta.phases,
    sourceText: parsed.source,
    body: parsed.body,
    executable: parsed.executable,
    source,
    filePath: targetPath,
  }
}
