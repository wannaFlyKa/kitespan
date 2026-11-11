// The switch (prototype design plan v2): the iOS toggle, for every on/off setting. A real checkbox with role="switch"
// sits inside, over the track, so a click, a tap, Space (the checkbox's own key) and a screen reader all reach it;
// Enter turns it too, as the ARIA switch pattern allows. onChange runs only inside those handlers. base.css draws it
// (.switch, .switch-input, .switch-track, .switch-knob): --ok-fill when on.
import type { KeyboardEvent } from "react";

/**
 * What a key does to a switch that is `on`: the next value for Enter, else null. Space is not here because the
 * checkbox turns on Space by itself (handling it twice would undo it).
 */
export function switchKey(key: string, on: boolean): boolean | null {
  return key === "Enter" ? !on : null;
}

export function Switch(props: {
  checked: boolean;
  /** Called with the new value, from a click, a tap, Space or Enter. */
  onChange: (on: boolean) => void;
  /** The switch's name for a screen reader, when no visible label names it (else use `labelledBy`). */
  label?: string;
  /** The id of the visible label that names the switch. */
  labelledBy?: string;
  /** The id of the line that says what the switch does. */
  describedBy?: string;
  disabled?: boolean;
  /** A change it sent is on its way (aria-busy): the switch stays enabled, so the focus stays on it. */
  busy?: boolean;
  /** The checkbox's id, for a <label htmlFor>. */
  id?: string;
  /** The test id, on the checkbox. */
  testId?: string;
  className?: string;
}) {
  const { checked, onChange, label, labelledBy, describedBy, disabled, busy, id, testId, className } = props;
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const next = switchKey(e.key, checked);
    if (next === null || e.repeat || disabled) return;
    e.preventDefault();
    onChange(next);
  };
  return (
    <span className={className ? `switch ${className}` : "switch"} data-on={checked ? "true" : "false"}>
      <input
        type="checkbox"
        role="switch"
        className="switch-input"
        id={id}
        checked={checked}
        disabled={disabled}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-busy={busy || undefined}
        data-testid={testId}
        onChange={(e) => onChange(e.currentTarget.checked)}
        onKeyDown={onKeyDown}
      />
      <span className="switch-track" aria-hidden="true">
        <span className="switch-knob" />
      </span>
    </span>
  );
}
