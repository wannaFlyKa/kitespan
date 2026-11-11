// A child's output, read from its first byte to its end by one reader, so that no chunk is lost. A loop that races
// `reader.read()` against a sleep leaves a read pending each time the sleep wins, and the next chunk goes to that
// abandoned read: a server that prints its first line later than the sleep (about 1 s on a macOS runner) was never seen.

/** Reads `stream` to its end, passing each decoded piece to `onText`; `until` waits for a condition, at most `ms`. */
export function readInto(stream: ReadableStream<Uint8Array>, onText: (text: string) => void): { until(ok: () => boolean, ms: number): Promise<boolean>; ended: Promise<void> } {
  let over = false;
  const decoder = new TextDecoder();
  const ended = (async () => {
    for await (const chunk of stream) onText(decoder.decode(chunk, { stream: true }));
    const rest = decoder.decode();
    if (rest) onText(rest);
  })()
    .catch(() => {})
    .finally(() => {
      over = true;
    });
  return {
    ended,
    async until(ok, ms) {
      const end = Date.now() + ms;
      while (!ok() && !over && Date.now() < end) await Bun.sleep(20);
      return ok();
    },
  };
}
