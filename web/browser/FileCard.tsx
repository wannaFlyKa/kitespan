// A page's file chooser (DESIGN-B1 4.7, D-9, F15; PAGE 8): the card over the frame. A chooser that the user's tap
// opened, or one whose opener kitespan cannot tell: "The page asks for a file" (or "for files"), "<host>, for <label>",
// the line about the uploads, Cancel and Choose file. One that Claude opened (`by: claude`, which the server decided
// when it opened, so the card keeps it while that chat lives): "Claude opened a file field", with Leave it to Claude
// (the chooser stays for Claude) and Choose file. The words and whose it is are fileWords.ts's. Choose file opens this
// device's own file input inside the press, with the page's `accept` and `multiple`; each file goes through kitespan's
// uploads (the chat beside the pane, else the browser's own uploads), then to the page. Esc while the card holds the
// focus is its plain button (Cancel, or Leave it to Claude), over the chat too (escape.ts); when the card goes while it
// holds the focus, the focus goes back to the frame.
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { UploadReply } from "../../server/http/api-types";
import { uploadBytes } from "../net/api";
import { tooLargeLine, useStore } from "../state/store";
import { IconUpload } from "../ui/icons";
import { readingOrder } from "../ui/primitives";
import { onEscape, useFocusBack } from "./escape";
import { acceptOf, FILE_LINES, fileIsClaudes, filePlain, fileTitle, fileWhere } from "./fileWords";
import type { ChooserFrame } from "./store";

export function FileCard(props: {
  c: ChooserFrame;
  /** The chat whose uploads take the file; null: the browser's own uploads. */
  chat: string | null;
  phone: boolean;
  onCancel: () => void;
  onLeave: () => void;
  onFiles: (uploads: string[]) => Promise<boolean>;
}) {
  const { c, chat, phone, onCancel, onLeave, onFiles } = props;
  const input = useRef<HTMLInputElement>(null);
  const maxMB = useStore((s) => s.settings.maxUploadMB);
  const [progress, setProgress] = useState<{ name: string; pct: number } | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [files, setFiles] = useState<File[] | null>(null);
  const theirs = fileIsClaudes(c);
  const card = useRef<HTMLElement>(null);
  const plain = useRef(theirs ? onLeave : onCancel);
  plain.current = theirs ? onLeave : onCancel;
  useEffect(
    () =>
      onEscape(() => {
        if (!card.current?.contains(document.activeElement)) return false;
        plain.current();
        return true;
      }),
    [],
  );
  useFocusBack(card);
  const onKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    plain.current();
  };
  const send = async (list: File[]) => {
    setLine(null);
    const big = list.find((f) => f.size > maxMB * 1_000_000);
    if (big) {
      setLine(tooLargeLine(maxMB));
      return;
    }
    const ids: string[] = [];
    for (const f of list) {
      setProgress({ name: f.name, pct: 0 });
      try {
        const up = uploadBytes<UploadReply>(chat ? { chat } : { browser: true }, f, f.name, f.type, (p) => setProgress({ name: f.name, pct: Math.round(p * 100) }));
        ids.push((await up.done).upload.id);
      } catch (e) {
        setProgress(null);
        setLine((e as Error).message);
        return;
      }
    }
    setProgress(null);
    if (!(await onFiles(ids))) {
      setFiles(list);
      setLine(FILE_LINES.missed);
    }
  };
  const buttons = (
    <>
      {theirs ? (
        <button key="leave" type="button" className="btn" onClick={onLeave} data-testid="browser-file-leave">
          {filePlain(c)}
        </button>
      ) : (
        <button key="cancel" type="button" className="btn" onClick={onCancel} data-testid="browser-file-cancel">
          {filePlain(c)}
        </button>
      )}
      {line === FILE_LINES.missed && files ? (
        <button key="again" type="button" className="btn primary" onClick={() => void send(files)}>
          Try again
        </button>
      ) : (
        <button key="choose" type="button" className="btn primary" disabled={!!progress} onClick={() => input.current?.click()} data-testid="browser-file-choose">
          {c.multiple ? "Choose files" : "Choose file"}
        </button>
      )}
    </>
  );
  return (
    <>
      <div className="bp-veil" />
      <div className="bp-card-wrap">
        <section ref={card} className="chat-card is-file" role="alertdialog" aria-labelledby={`bp-fc-${c.tab}`} onKeyDown={onKey} data-testid="browser-file">
          <header className="chat-card-head">
            <span className="chat-card-icon">
              <IconUpload />
            </span>
            <h2 className="chat-card-title" id={`bp-fc-${c.tab}`}>
              {fileTitle(c)}
            </h2>
          </header>
          <div className="chat-card-body">
            <p className="chat-card-text">{fileWhere(c)}</p>
            <p className="chat-card-from">{chat ? FILE_LINES.chat : FILE_LINES.own}</p>
            {progress ? (
              <p className="chat-card-from" role="status">
                Uploading {progress.name}… {progress.pct}%
              </p>
            ) : null}
            {line ? (
              <p className="notice" role="status">
                {line}
              </p>
            ) : null}
          </div>
          <div className="chat-card-actions">{readingOrder(buttons, phone)}</div>
          <input
            ref={input}
            type="file"
            hidden
            accept={acceptOf(c) || undefined}
            multiple={c.multiple}
            onChange={(e) => {
              const list = [...(e.target.files ?? [])].slice(0, 20);
              e.target.value = "";
              if (list.length) void send(list);
            }}
          />
        </section>
      </div>
    </>
  );
}
