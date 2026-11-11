// A worktree's path in a line of text (Delete's confirm, the archived chat's kept line), which a phone's narrow line
// breaks only after a "/": each part up to and with its "/" is one box (environment.css .wt-path-part) that never
// breaks inside, at a hyphen or a space, unless it alone is wider than the line, and a <wbr> after each part offers the
// break. The leading "/" stays with the first folder's name. The text reads and copies as the one path.
import { Fragment } from "react";

/** The path's parts: a break after each "/" that follows a folder's name. */
const partsOf = (path: string) => path.split(/(?<=[^/]\/)/);

export function PathText({ path }: { path: string }) {
  return (
    <>
      {partsOf(path).map((part, i) => (
        <Fragment key={i}>
          {i ? <wbr /> : null}
          <span className="wt-path-part">{part}</span>
        </Fragment>
      ))}
    </>
  );
}

/** A line with a path in it: the path drawn as PathText, the rest as it is. */
export function WithPath({ text, path }: { text: string; path: string }) {
  const at = path ? text.indexOf(path) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <PathText path={path} />
      {text.slice(at + path.length)}
    </>
  );
}
