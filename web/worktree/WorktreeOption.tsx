// Desktop's Worktree option (row 73): a row with the word "Worktree" and its switch, in New environment and in the
// project's editor. Off by default ("By default, Worktree is off"). Where a worktree cannot be made (a folder that is
// not a git repository, a repository with no commit, a WorktreeCreate hook, a git config that could run a program),
// that one line shows under the row, and the switch cannot be turned on; an option that is on when such a reason
// comes later (a hook that a plugin adds, a config with includeIf) can always be turned off, so it never locks a
// project's new chats on a worktree they cannot get. No other line: principle 0. While the switch's own POST runs it
// stays enabled (aria-busy), so the keyboard's focus stays on it, and a press then does nothing.
import { useId } from "react";
import { Switch } from "../ui/Switch";
import { WORKTREE_OFF_LINE, WORKTREE_WORDS, type WorktreeOff } from "./worktree";

export function WorktreeOption(props: { on: boolean; off: WorktreeOff | null; busy?: boolean; disabled?: boolean; onChange: (on: boolean) => void; testId?: string }) {
  const { on, off, busy = false, disabled = false, onChange, testId = "worktree-switch" } = props;
  const labelId = useId();
  const lineId = useId();
  return (
    <div className="wt-opt" data-off={off ?? undefined}>
      <div className="group-row wt-opt-row">
        <span className="group-label wt-opt-label" id={labelId}>
          {WORKTREE_WORDS.option}
        </span>
        <Switch
          checked={on}
          onChange={(v) => {
            if (!busy) onChange(v);
          }}
          labelledBy={labelId}
          describedBy={off ? lineId : undefined}
          disabled={disabled || (off !== null && !on)}
          busy={busy}
          testId={testId}
        />
      </div>
      {off ? (
        <p className="wt-opt-line" id={lineId} data-testid="worktree-off">
          {WORKTREE_OFF_LINE[off]}
        </p>
      ) : null}
    </div>
  );
}
