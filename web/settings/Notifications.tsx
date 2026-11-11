// Settings > Notifications (owner rows 128 and 130; DESIGN-R130 4.5, 4.6, 6 and 8): per device, from the user's own tap.
//   - "Notifications on this device": a switch, or, where this browser cannot get them, no switch and one line (an
//     insecure origin, a browser with no push, a blocked permission; gate.ts). While the section reads (the server's
//     list, this browser's subscription) no control is drawn, so the row mounts once with its state. After a turn-on
//     that did not go through, its one line.
//   - "Show chat titles", only while this device is on, with the line that says who can read a title and who cannot.
//   - "Devices", only while one device or more is on: each device's name (a button that turns into a field: Enter or
//     Save saves, Esc or leaving it unchanged gives it back), "This device" on this browser's row, Turn off on every
//     other row, and a failing device's line. Also under a blocked permission's line and an insecure origin's, so the
//     other devices can be turned off from here (then every row has Turn off); a browser with no push (the phone's
//     company browser) gets its line and nothing more (gate.ts listsDevices).
// A link only pre-fills (5.2): /settings/notifications/this-device?value=on shows the value with Not saved, and its
// Save, "Turn on notifications", is the user's own tap that asks the browser; ?value= on show-titles is a draft with
// Save; /settings/notifications/device/<device>?name= marks that row with the name in its field, not saved, and the
// device's own name in view above the field, so the link says which device it renames.
// The phone gets all of it (row 115: a notification brings the user back to read, steer or answer a card), with
// 44 px targets and each device on one line. Nothing moves but the switches, as every switch does.
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Switch } from "../ui/Switch";
import { gateLine, listsDevices } from "../notify/gate";
import { DEVICE_NAME_MAX, cleanName } from "../notify/names";
import type { PushDevice } from "../notify/api";
import type { NotifyActions, NotifyModel } from "../notify/useNotify";
import { NOTIFY_WORDS as W } from "../notify/words";

export interface NotifyCtx {
  /** The row a link names: this-device or show-titles, with the link's value. */
  focusKey?: string;
  urlValue?: string;
  /** /settings/notifications/device/<device>: that row is marked, with the link's name. */
  device?: string;
  deviceName?: string;
  touch: boolean;
}

const onOff = (raw: string | undefined): boolean | null => {
  const v = raw?.trim().toLowerCase();
  return v === "on" || v === "true" || v === "1" ? true : v === "off" || v === "false" || v === "0" ? false : null;
};

/** Focus `el` (and bring its row into view) once, when its link opened the section. */
function useLinkFocus(on: boolean, row: React.RefObject<HTMLElement | null>, target: () => HTMLElement | null | undefined) {
  useEffect(() => {
    if (!on) return;
    row.current?.scrollIntoView({ block: "center" });
    (target() ?? row.current)?.focus({ preventScroll: true });
    // Once, as the row mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** The words of a row and its control, in Settings' row form (panels.css .set-row). */
function RowShell(props: { testId: string; labelId: string; label: string; line?: ReactNode; status?: ReactNode; control?: ReactNode; focused?: boolean; className?: string; rowRef?: React.RefObject<HTMLLIElement | null> }) {
  const { testId, labelId, label, line, status, control, focused, className, rowRef } = props;
  return (
    <li ref={rowRef} className={`set-row set-row-switch${className ? ` ${className}` : ""}`} data-testid={testId} data-focused={focused || undefined} tabIndex={-1}>
      <div className="set-row-main">
        <div className="set-row-text">
          <span className="set-label-line">
            <span className="set-label" id={labelId}>
              {label}
            </span>
          </span>
          {line ? <span className="set-help">{line}</span> : null}
          {status}
        </div>
        {control !== undefined ? <div className="set-control">{control}</div> : null}
      </div>
    </li>
  );
}

/** A switch with a link's draft: shown with Not saved, and its Save (named `save`) does the change. */
function DraftSwitch(props: { labelId: string; value: boolean; draft: boolean | null; busy: boolean; onChange: (on: boolean) => void; save: string; testId: string; saveRef: React.RefObject<HTMLButtonElement | null>; onDraft: (v: boolean | null) => void }) {
  const { labelId, value, draft, busy, onChange, save, testId, saveRef, onDraft } = props;
  const dirty = draft !== null && draft !== value;
  return (
    <>
      <Switch checked={dirty ? draft : value} busy={busy} labelledBy={labelId} testId={testId} className="set-switch" onChange={(on) => (draft !== null ? onDraft(on) : onChange(on))} />
      {dirty ? (
        <span className="set-save">
          <span className="set-unsaved">Not saved</span>
          <button
            type="button"
            ref={saveRef}
            className="btn primary"
            data-testid="confirm-save"
            onClick={() => {
              onDraft(null);
              onChange(draft);
            }}
          >
            {save}
          </button>
        </span>
      ) : null}
    </>
  );
}

export function NotificationsBody({ model, actions, ctx }: { model: NotifyModel; actions: NotifyActions; ctx: NotifyCtx }) {
  const { gate, read, busy, line } = model;
  const firstId = useId();
  const titlesId = useId();
  const devicesId = useId();
  const firstRow = useRef<HTMLLIElement>(null);
  const titlesRow = useRef<HTMLLIElement>(null);
  const firstSave = useRef<HTMLButtonElement>(null);
  const titlesSave = useRef<HTMLButtonElement>(null);
  const [firstDraft, setFirstDraft] = useState<boolean | null>(() => (ctx.focusKey === "this-device" ? onOff(ctx.urlValue) : null));
  const [titlesDraft, setTitlesDraft] = useState<boolean | null>(() => (ctx.focusKey === "show-titles" ? onOff(ctx.urlValue) : null));
  const blocked = gateLine(gate);
  // The server's list, where this browser could be a device (useNotify reads it then).
  const listed = listsDevices(gate) && !!read;
  const mine = read?.mine ?? null;
  const on = busy ? busy === "on" : mine !== null;
  const me = mine ? read?.devices.find((d) => d.id === mine) : undefined;
  const devices = read ? [...read.devices].sort((a, b) => (a.id === mine ? -1 : b.id === mine ? 1 : a.at < b.at ? -1 : a.at > b.at ? 1 : 0)) : [];
  const badValue = (k: string) => ctx.focusKey === k && !!ctx.urlValue && onOff(ctx.urlValue) === null;

  return (
    <>
      <div className="set-block">
        <ul className="group set-group" data-testid="settings-notifications-device">
          {blocked ? (
            <RowShell rowRef={firstRow} testId="setting-this-device" labelId={firstId} label={W.thisDevice} line={blocked} className="nt-blocked" focused={ctx.focusKey === "this-device"} />
          ) : !read ? (
            // Reading: the row's words only, so it mounts once with its control.
            <RowShell rowRef={firstRow} testId="setting-this-device" labelId={firstId} label={W.thisDevice} focused={ctx.focusKey === "this-device"} />
          ) : (
            <FirstRow
              rowRef={firstRow}
              labelId={firstId}
              on={on}
              busy={busy !== null}
              draft={firstDraft}
              setDraft={setFirstDraft}
              saveRef={firstSave}
              line={line}
              bad={badValue("this-device")}
              focused={ctx.focusKey === "this-device"}
              onChange={actions.setThisDevice}
            />
          )}
          {!blocked && read && mine && !busy ? (
            <TitlesRow rowRef={titlesRow} labelId={titlesId} on={!!me?.titles} draft={titlesDraft} setDraft={setTitlesDraft} saveRef={titlesSave} bad={badValue("show-titles")} focused={ctx.focusKey === "show-titles"} onChange={actions.setTitles} />
          ) : null}
        </ul>
      </div>
      {listed && devices.length ? (
        <div className="set-block">
          <h3 className="group-title set-group-title" id={devicesId}>
            {W.devices}
          </h3>
          <ul className="group set-group" aria-labelledby={devicesId} data-testid="settings-devices">
            {devices.map((d) => (
              <DeviceRow key={`${d.id}|${ctx.device === d.id ? (ctx.deviceName ?? "") : ""}`} d={d} mine={d.id === mine} actions={actions} ctx={ctx} />
            ))}
          </ul>
        </div>
      ) : null}
      {listed && ctx.device && !devices.some((d) => d.id === ctx.device) ? (
        <p className="notice set-notice" data-testid="link-notice">
          <span>{W.deviceGone}</span>
        </p>
      ) : null}
    </>
  );
}

const PART_UNREAD = "Part of that link could not be read.";

function FirstRow(props: {
  rowRef: React.RefObject<HTMLLIElement | null>;
  labelId: string;
  on: boolean;
  busy: boolean;
  draft: boolean | null;
  setDraft: (v: boolean | null) => void;
  saveRef: React.RefObject<HTMLButtonElement | null>;
  line: string | null;
  bad: boolean;
  focused: boolean;
  onChange: (on: boolean) => void;
}) {
  const { rowRef, labelId, on, busy, draft, setDraft, saveRef, line, bad, focused, onChange } = props;
  useLinkFocus(focused, rowRef, () => (draft !== null && draft !== on ? saveRef.current : rowRef.current?.querySelector<HTMLElement>(".set-control input")));
  return (
    <RowShell
      rowRef={rowRef}
      testId="setting-this-device"
      labelId={labelId}
      label={W.thisDevice}
      focused={focused}
      status={
        line || bad ? (
          <span className="set-row-line" role="status" data-testid="notify-line">
            {bad ? PART_UNREAD : line}
          </span>
        ) : null
      }
      control={<DraftSwitch labelId={labelId} value={on} draft={draft} busy={busy} onChange={onChange} onDraft={setDraft} save={draft ? W.turnOn : W.turnOffAll} testId="notify-switch" saveRef={saveRef} />}
    />
  );
}

function TitlesRow(props: { rowRef: React.RefObject<HTMLLIElement | null>; labelId: string; on: boolean; draft: boolean | null; setDraft: (v: boolean | null) => void; saveRef: React.RefObject<HTMLButtonElement | null>; bad: boolean; focused: boolean; onChange: (on: boolean) => void }) {
  const { rowRef, labelId, on, draft, setDraft, saveRef, bad, focused, onChange } = props;
  useLinkFocus(focused, rowRef, () => (draft !== null && draft !== on ? saveRef.current : rowRef.current?.querySelector<HTMLElement>(".set-control input")));
  return (
    <RowShell
      rowRef={rowRef}
      testId="setting-show-titles"
      labelId={labelId}
      label={W.titles}
      line={W.titlesLine}
      focused={focused}
      status={
        bad ? (
          <span className="set-row-line" role="status">
            {PART_UNREAD}
          </span>
        ) : null
      }
      control={<DraftSwitch labelId={labelId} value={on} draft={draft} busy={false} onChange={onChange} onDraft={setDraft} save="Save" testId="titles-switch" saveRef={saveRef} />}
    />
  );
}

/**
 * One device: its name (a button that turns into a field, as the title bar's rename does), "This device" on this
 * browser's row or Turn off on another's, and a failing device's line. Its link marks it, with the link's name in the
 * field and not saved.
 */
function DeviceRow({ d, mine, actions, ctx }: { d: PushDevice; mine: boolean; actions: NotifyActions; ctx: NotifyCtx }) {
  const linked = ctx.device === d.id;
  const fromLink = linked && ctx.deviceName !== undefined ? cleanName(ctx.deviceName) : null;
  const [editing, setEditing] = useState<string | null>(fromLink);
  const [saving, setSaving] = useState(false);
  const row = useRef<HTMLLIElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const nameBtn = useRef<HTMLButtonElement>(null);
  const dirty = editing !== null && cleanName(editing) !== "" && cleanName(editing) !== d.name;
  // A link marks the row; on a laptop the field (or the name) takes the focus, on touch nothing does (no keyboard).
  useEffect(() => {
    if (!linked) return;
    row.current?.scrollIntoView({ block: "center" });
    if (!ctx.touch) (field.current ?? nameBtn.current ?? row.current)?.focus({ preventScroll: true });
    // Once, as the row mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const open = () => {
    setEditing(d.name);
    requestAnimationFrame(() => {
      field.current?.focus({ preventScroll: true });
      field.current?.select();
    });
  };
  const cancel = () => {
    setEditing(null);
    requestAnimationFrame(() => nameBtn.current?.focus({ preventScroll: true }));
  };
  const save = () => {
    if (editing === null || saving) return;
    if (!dirty) return cancel();
    setSaving(true);
    void actions.rename(d.id, editing).then((ok) => {
      setSaving(false);
      if (ok) cancel();
    });
  };
  return (
    <li ref={row} className="set-row nt-dev" data-testid={`device-${d.id}`} data-focused={linked || undefined} data-mine={mine || undefined} tabIndex={-1}>
      <div className="set-row-main">
        <div className="set-row-text">
          {/* A link's draft name replaces the name in the field, so the row keeps the device's own name in view. */}
          {editing !== null && linked ? (
            <span className="set-help" aria-hidden="true" data-testid="device-current">
              {d.name}
            </span>
          ) : null}
          {editing !== null ? (
            <input
              ref={field}
              className="field nt-name"
              type="text"
              value={editing}
              maxLength={DEVICE_NAME_MAX}
              aria-label={W.rename(d.name)}
              autoComplete="off"
              spellCheck={false}
              data-testid="device-name-field"
              onChange={(e) => setEditing(e.target.value)}
              // A field left with no change gives the name back (on touch there is no Esc).
              onBlur={() => {
                if (!dirty && !saving) setEditing(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  save();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  cancel();
                }
              }}
            />
          ) : (
            <span className="set-label-line">
              <button type="button" ref={nameBtn} className="nt-name-btn" aria-label={W.rename(d.name)} data-testid="device-name" onClick={open}>
                {d.name}
              </button>
            </span>
          )}
          {d.failing && editing === null ? (
            <span className="set-row-line" role="status">
              {W.failing}
            </span>
          ) : null}
        </div>
        <div className="set-control">
          {editing !== null ? (
            dirty ? (
              <span className="set-save">
                <span className="set-unsaved">Not saved</span>
                <button type="button" className="btn primary" data-testid="device-save" disabled={saving} onClick={save}>
                  Save
                </button>
              </span>
            ) : null
          ) : mine ? (
            <span className="set-dim nt-you">{W.you}</span>
          ) : (
            <button type="button" className="btn" data-testid="device-turn-off" aria-label={W.turnOffName(d.name)} onClick={() => actions.remove(d.id)}>
              {W.turnOff}
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
