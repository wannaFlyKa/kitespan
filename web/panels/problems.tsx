// The connectors' problem count (D51, MINIMALISM M18), drawn the same wherever it shows: the Details card's Connectors
// row and the + menu's Connectors item. Nothing while every connector works; else how many failed, in --danger, and
// how many need a sign-in, in --warn (panels.css .side-bad and .side-warn).
import type { ConnectorInfo } from "../../shared/protocol";
import { connectorProblems } from "./format";

export function ConnectorProblems({ list }: { list: readonly Pick<ConnectorInfo, "status">[] }) {
  const { failed, signIn } = connectorProblems(list);
  if (!failed && !signIn) return null;
  return (
    <>
      {failed ? <span className="side-bad">{failed} failed</span> : null}
      {failed && signIn ? ", " : null}
      {signIn ? <span className="side-warn">{`${signIn} ${signIn === 1 ? "needs" : "need"} sign-in`}</span> : null}
    </>
  );
}
