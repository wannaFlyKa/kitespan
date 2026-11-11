// The bodies of tool rows and permission cards: numbered code (Read, Write), a diff (Edit), a capped list (Grep,
// Glob) and a command with its output (Bash). Line numbers, diff signs and the "$" are user-select: none, so a
// selection inside a body copies only the code (DESIGN.md 7.10). Code and diffs scroll sideways inside their box;
// command output wraps. Everything is text: tool output never renders as markup (D20).

const more = (n: number) => `... ${n} more ${n === 1 ? "line" : "lines"}`;

function cap<T>(lines: T[], max: number): [T[], number] {
  return lines.length > max ? [lines.slice(0, max), lines.length - max] : [lines, 0];
}

export function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function CodeLines({ text, start = 1, max = 400 }: { text: string; start?: number; max?: number }) {
  const [lines, rest] = cap(splitLines(text), max);
  return (
    <div className="chat-lines is-code">
      <div className="chat-lines-in">
        {lines.map((l, i) => (
          <div className="chat-line" key={i}>
            <span className="chat-ln">{start + i}</span>
            <span className="chat-lt">{l || " "}</span>
          </div>
        ))}
      </div>
      {rest ? <div className="chat-lines-more">{more(rest)}</div> : null}
    </div>
  );
}

export function DiffLines({ path, removed, added, max = 400 }: { path?: string; removed: string[]; added: string[]; max?: number }) {
  const all: ["-" | "+", string][] = [...removed.map((l): ["-", string] => ["-", l]), ...added.map((l): ["+", string] => ["+", l])];
  const [rows, rest] = cap(all, max);
  const delN = removed.length;
  const addN = added.length;
  return (
    <div className="chat-lines is-code is-diff">
      {path ? (
        <div className="chat-lines-head">
          <span className="mono">{path}</span>
          <span className="chat-diff-count">
            <span className="is-add">+{addN}</span> <span className="is-del">-{delN}</span>
          </span>
        </div>
      ) : null}
      <div className="chat-lines-in">
        {rows.map(([sign, l], i) => (
          <div className={`chat-line ${sign === "+" ? "is-add" : "is-del"}`} key={i}>
            <span className="chat-sign">{sign}</span>
            <span className="chat-lt">{l || " "}</span>
          </div>
        ))}
      </div>
      {rest ? <div className="chat-lines-more">{more(rest)}</div> : null}
    </div>
  );
}

export function ListLines({ text, max = 40 }: { text: string; max?: number }) {
  const [lines, rest] = cap(splitLines(text), max);
  return (
    <div className="chat-lines is-wrap">
      <div className="chat-lines-in">
        {lines.map((l, i) => (
          <div className="chat-line" key={i}>
            <span className="chat-lt">{l || " "}</span>
          </div>
        ))}
      </div>
      {rest ? <div className="chat-lines-more">{more(rest)}</div> : null}
    </div>
  );
}

export function CommandLines({ command, output, max = 400 }: { command: string; output?: string; max?: number }) {
  const [lines, rest] = cap(output ? splitLines(output) : [], max);
  return (
    <div className="chat-lines is-wrap">
      <div className="chat-lines-in">
        <div className="chat-line is-cmd">
          <span className="chat-sign">$</span>
          <span className="chat-lt">{command}</span>
        </div>
        {lines.map((l, i) => (
          <div className="chat-line is-out" key={i}>
            <span className="chat-sign" />
            <span className="chat-lt">{l || " "}</span>
          </div>
        ))}
      </div>
      {rest ? <div className="chat-lines-more">{more(rest)}</div> : null}
    </div>
  );
}
