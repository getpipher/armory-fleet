# cron-parser (vendored)

- **Origin:** https://github.com/harrisi/cron-parser
- **npm:** `cron-parser`
- **Version:** 1.1.1 (latest 1.x — dependency-free; later versions pull in `luxon`)
- **License:** MIT (see upstream LICENSE)
- **Vendored on:** 2026-07-24
- **Vendored surface:** `lib/` (4 files: `parser.js`, `expression.js`, `date.js`, `number.js` — CommonJS, all-relative `require()`s, zero runtime deps)
- **Frozen:** do NOT edit files under `lib/`. To upgrade, replace `lib/` + update this NOTICE (version + date). Note: v2+ adds `luxon` as a runtime dep — vendoring those would require also vendoring luxon; v1.1.1 is intentionally dep-free.

## Why vendored (per SPEC-5a §9, Q9=A)
cron expression parsing is commodity plumbing (DST, month-length, DOW/DOM OR-semantics, Feb 29).
We freeze a battle-tested MIT copy rather than reinvent it. The worktree lifecycle, by contrast,
is greenfield (thin git shell-outs) — see `src/worktree/`.

## API used (v1.1.1)
```js
const cp = require("./lib/parser.js");
const expr = cp.parseExpression("0 9 * * 1-5", { currentDate: new Date() });
const nextDate = expr.next();  // CronDate (extends Date) — a real Date instance
```
Note: v1.1.1 has no `tz` option — it uses the process local timezone, which is the right default
for a dev tool ("9am" means 9am the user's time).