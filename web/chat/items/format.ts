// The transcript's small number formats (DESIGN.md 6.3): a running call's time ("12 s"), token counts ("18.4k
// tokens", "about 1.9k tokens") and a retry's wait ("in 4 s").

/** How long a call has run: "12 s", then "1 min 35 s". */
export function elapsedLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} min ${s % 60} s` : `${m} min`;
}

/** A token count the way Claude Code writes one: 950, 1.9k, 18.4k, 210k. */
export function tokensLabel(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n < 1000) return String(n);
  if (n < 100000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(n / 1000)}k`;
}

/** A retry's wait in whole seconds, never "0 s" while there is still a wait. */
export function delayLabel(ms: number): string {
  return `${Math.ceil(Math.max(0, ms) / 1000)} s`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
