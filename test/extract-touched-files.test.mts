// test/extract-touched-files.test.mts
// #87: the bash-redirect heuristic in extractTouchedFiles false-positived on ">" inside
// quoted strings/heredocs/code text and swallowed trailing punctuation — the turn-budget
// partial narrative then listed junk tokens ("cache.load(name,,", "[...active],,").
import { test } from "node:test";
import { deepStrictEqual, strictEqual } from "node:assert";
import { extractTouchedFiles } from "../src/engine/spawnSubagent.ts";

test("edit/write: path + file_path args (both casings) extract the path", () => {
  deepStrictEqual(extractTouchedFiles("edit", { path: "/repo/src/a.ts" }), ["/repo/src/a.ts"]);
  deepStrictEqual(extractTouchedFiles("Edit", { file_path: "/repo/src/b.ts" }), ["/repo/src/b.ts"]);
  deepStrictEqual(extractTouchedFiles("write", {}), []);
});

test("bash: plain redirects + tee capture the target", () => {
  deepStrictEqual(extractTouchedFiles("bash", { command: "echo hi > /tmp/out.txt" }), ["/tmp/out.txt"]);
  deepStrictEqual(extractTouchedFiles("bash", { command: "echo hi >> /var/log/app.log" }), ["/var/log/app.log"]);
  deepStrictEqual(extractTouchedFiles("bash", { command: "cat in | tee out.txt" }), ["out.txt"]);
  deepStrictEqual(extractTouchedFiles("bash", { command: "cat in | tee -a out.txt" }), ["out.txt"]);
});

test("#87: the REAL reported junk tokens are NOT captured", () => {
  // verbatim shapes from the #87 report (garbled "Files modified before the cut" list)
  deepStrictEqual(extractTouchedFiles("bash", { command: `echo "if (x > y) cache.load(name,, 3)" > /tmp/e2e-out.txt` }),
    ["/tmp/e2e-out.txt"], "code text after an in-string > must not be captured");
  deepStrictEqual(extractTouchedFiles("bash", { command: `echo "spread: > [...active],," > /tmp/ms-leg.txt` }),
    ["/tmp/ms-leg.txt"]);
  deepStrictEqual(extractTouchedFiles("bash", { command: `node -e 'console.log("> registered.set(t.name,")' > /tmp/x.txt` }),
    ["/tmp/x.txt"]);
  strictEqual(extractTouchedFiles("bash", { command: `echo "> cache.load(name,," ` }).length, 0,
    "junk token with no real path capture → nothing");
  strictEqual(extractTouchedFiles("bash", { command: `echo "> [...active],,"` }).length, 0);
});

test("#87: trailing punctuation from code-y commands is trimmed off real paths", () => {
  deepStrictEqual(extractTouchedFiles("bash", { command: `run_suite() { ... } > /tmp/e2e-out.txt), 2>&1` }),
    ["/tmp/e2e-out.txt"], "trailing ), stripped");
  deepStrictEqual(extractTouchedFiles("bash", { command: `tee /tmp/ms-leg.txt, <<EOF` }),
    ["/tmp/ms-leg.txt"], "trailing comma stripped");
});

test("#87: quoted redirect targets are unwrapped", () => {
  deepStrictEqual(extractTouchedFiles("bash", { command: `echo hi > '/tmp/quoted.txt'` }), ["/tmp/quoted.txt"]);
  deepStrictEqual(extractTouchedFiles("bash", { command: `echo hi > "out.txt"` }), ["out.txt"]);
});

test("#87: bare words and non-path dots stay rejected; dotted filenames pass", () => {
  strictEqual(extractTouchedFiles("bash", { command: `echo done > y` }).length, 0, "bare word, no / or ext");
  strictEqual(extractTouchedFiles("bash", { command: `cmp a b > /dev/null` }).length, 0, "/dev/null is not a touched file");
  deepStrictEqual(extractTouchedFiles("bash", { command: `git log > .gitignore` }), [".gitignore"], "leading-dot filenames allowed");
  deepStrictEqual(extractTouchedFiles("bash", { command: `obj.dump > dump.out` }), ["dump.out"]);
});
