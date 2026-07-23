# @getpipher/armory-fleet

> The armory suite's subagent orchestrator for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — a cross-harness, superpowers-native fleet where every agent is **armory-native from birth**.

`@getpipher/armory-fleet` brings Claude-Code-style autonomous sub-agents to pi, built so that the armory ecosystem ([armory-todo](https://github.com/getpipher/armory-todo), [armory-memory](https://github.com/getpipher/armory-memory), [vision](https://github.com/getpipher/vision), [cursor](https://github.com/getpipher/cursor)) is the *default substrate* agents run on — not a bolt-on.

## Why

The pi-subagent ecosystem is crowded (nicobailon/pi-subagents at 2688⭐, tintinweb at 702⭐, QuintinShaw at 287⭐, and more). Three structural gaps remain open:

1. **Armory-native integration** — no external package can integrate with the armory suite; they don't own it. Agents that sync to armory-todo, hydrate from armory-memory, see via vision, and edit via cursor *by default* are uncopyable.
2. **Cross-harness peers** — only one attempt (kky42/pi-flow, 66⭐) runs Claude Code + Pi as peer subagent backends, and it's early. A dual-arsenal topology deserves a first-class implementation.
3. **Superpowers-native lifecycle** — only one attempt (teelicht/pi-superagents, 54⭐) wraps the superpowers skill pipeline, and it's synchronous-only.

`armory-fleet` owns all three, then reaches parity on the rest (fleet TUI, scheduling, worktree isolation, cost accounting, quality patterns, workflows-as-code, event-bus/RPC) — to be the best pi-subagent package in the ecosystem.

## Status

🚧 **Pre-implementation.** The master PRD + 7-SPEC roadmap are written and self-reviewed; SPEC-1 (core engine + armory-todo sync) is the next brainstorm cycle.

- **Master PRD:** [`PRD.md`](./PRD.md)
- **Landscape research:** [`research/`](./research) (11+ packages mapped, 5 contenders deep-read)
- **Roadmap:** PRD → SPEC-1 (core+todo-sync) → SPEC-2 (deep armory) → SPEC-3 (cross-harness) → SPEC-4 (superpowers lifecycle) → SPEC-5a (ops) → SPEC-5b (fleet TUI) → SPEC-6 (power-user → v1.0)

## Compatibility

pi `^0.81.1`.

## License

MIT — see [LICENSE](./LICENSE).