// A file in the message box (D50): an attachment chip (base.css .attach-chip: an icon tile, the name over the size, a
// progress ring while it uploads, and Remove). The chip is all the box shows of the file; a tap or click on a done
// chip shows its path in one line under the chips (the composer draws it), and a second tap hides it. Nothing is sent.
// A file of the chat's folder picked with `@` (9.3, the owner's answer of 2026-11-01) is a chip too: its folder part
// stands where an upload's size is, a tap shows its absolute path, and its Remove takes it out of the message box
// only (act.removeMention): unlike an upload's, it deletes nothing. While the chat is held (row 80) Remove is off, shown
// as off (`off`); a tap still shows the path.
import { IconClose, IconFile, IconImage, IconInfo } from "../ui/icons";
import { ProgressRing, formatSize } from "../ui/files";
import type { ChipUpload, MentionChipFacts } from "./attach";

export function DraftChip(props: { upload: ChipUpload; open: boolean; pathId: string; onToggle: () => void; onRemove: () => void; off?: boolean }) {
  const { upload: u, open, pathId, onToggle, onRemove, off = false } = props;
  const failed = u.state === "failed";
  const icon = failed ? <IconInfo size={16} /> : u.type.startsWith("image/") ? <IconImage size={16} /> : <IconFile size={16} />;
  const name = u.name || "File";
  const line = failed ? u.error ?? "That file could not be uploaded." : u.unknown ? null : formatSize(u.size);
  const body = (
    <>
      <span className="attach-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="attach-text">
        <span className="attach-name">{name}</span>
        {line ? <span className="attach-size">{line}</span> : null}
      </span>
    </>
  );
  const showsPath = u.state === "done" && !!u.path;
  return (
    <span className={`attach-chip cmp-file-chip${failed ? " is-failed" : ""}`} data-testid={`attach-${u.id}`} data-state={u.state}>
      {showsPath ? (
        <button type="button" className="cmp-chip-body" aria-expanded={open} aria-controls={open ? pathId : undefined} aria-label={`${name}, ${line}. Show its path`} title={u.path} onClick={onToggle}>
          {body}
        </button>
      ) : (
        <span className="cmp-chip-body">{body}</span>
      )}
      {u.state === "uploading" ? <ProgressRing value={u.progress} /> : null}
      <button type="button" className="attach-remove" aria-label={`Remove ${name}`} title="Remove" data-testid="attach-remove" disabled={off} onClick={onRemove}>
        <IconClose size={10} />
      </button>
    </span>
  );
}

/** A mention chip (9.3): a file of the chat's folder, by its path relative to the folder. */
export function MentionChip(props: { mention: MentionChipFacts; open: boolean; pathId: string; onToggle: () => void; onRemove: () => void; off?: boolean }) {
  const { mention: m, open, pathId, onToggle, onRemove, off = false } = props;
  const where = m.dir ? `in ${m.dir}` : "in the chat's folder";
  return (
    <span className="attach-chip cmp-file-chip cmp-mention-chip" data-testid="mention-chip" data-path={m.path}>
      <button type="button" className="cmp-chip-body" aria-expanded={open} aria-controls={open ? pathId : undefined} aria-label={`${m.name}, ${where}. Show its path`} title={m.abs ?? m.path} onClick={onToggle}>
        <span className="attach-icon" aria-hidden="true">
          {m.image ? <IconImage size={16} /> : <IconFile size={16} />}
        </span>
        <span className="attach-text">
          <span className="attach-name">{m.name}</span>
          {m.dir ? (
            <span className="attach-size mention-dir" dir="auto">
              {m.dir}
            </span>
          ) : null}
        </span>
      </button>
      <button type="button" className="attach-remove" aria-label={`Remove ${m.name}`} title="Remove" data-testid="mention-remove" disabled={off} onClick={onRemove}>
        <IconClose size={10} />
      </button>
    </span>
  );
}
