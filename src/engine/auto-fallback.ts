// src/engine/auto-fallback.ts
// #58: resolve the ARMORY_FLEET_MODEL_FALLBACK=auto sentinel — pick a fallback model from the
// runtime's configured+available snapshot without the operator naming one. Prefers a model from
// a DIFFERENT provider than the session model (a real fallback family, per the "Ollama primary +
// OpenRouter fallback" pattern the feature was named for); if every available model shares the
// session's provider, a different model id on that provider. undefined when nothing differs
// (single-model setups) — the caller keeps auto-retry off and surfaces why.

export function resolveAutoFallback(
  available: ReadonlyArray<{ provider: string; id: string }>,
  parentModel: { provider: string; id: string },
): string | undefined {
  const parentProvider = parentModel.provider || "";
  const parentKey = `${parentModel.provider}/${parentModel.id}`;
  const differentProvider = available.filter((m) => m.provider !== parentProvider);
  const pool = differentProvider.length > 0 ? differentProvider : available;
  const pick = pool.find((m) => `${m.provider}/${m.id}` !== parentKey);
  return pick ? `${pick.provider}/${pick.id}` : undefined;
}
