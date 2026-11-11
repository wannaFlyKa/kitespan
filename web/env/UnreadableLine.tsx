// L39 in the chat: the line of a start that the environment's unreadable variables refused (the server's notice with
// the code env_unreadable, matched by the code, never by the text), with a link to the project's environment, where the
// variables are entered again or the unreadable file is removed. The link opens the editor only; nothing there acts
// before its own click or tap. A plain Send or a Start that the same refusal answered (its ack's code env_unreadable)
// shows the screen's one refused line with the same link under it (NoticeEnvLink).
import type { ErrorCode } from "../../shared/protocol";
import type { InfoItem } from "../state/types";
import { href } from "../router";
import { useStore } from "../state/store";
import { useTranscript } from "../chat/items/context";
import { IconWarning } from "../chat/items/icons";
import { Link } from "../ui/primitives";
import { ENV_WORDS } from "./vars";

/** True for the line of a start that unreadable variables refused: its notice's code (reduce.ts keeps it). */
export const isUnreadableLine = (item: InfoItem) => item.code === "env_unreadable";

export function UnreadableLine({ text }: { text: string }) {
  const t = useTranscript();
  const project = useStore((s) => (t ? s.chats.find((c) => c.id === t.chatId)?.projectId : undefined));
  return (
    <div className="chat-note is-text wt-start" data-testid="env-unreadable-line">
      <span className="chat-row-icon">
        <IconWarning size={15} />
      </span>
      <div className="chat-note-text wt-start-text">
        <p className="wt-start-line">{text}</p>
        {project && !t?.readOnly ? (
          <div className="wt-start-actions">
            <Link to={href("projectEnvironment", { project })} className="btn">
              {ENV_WORDS.title}
            </Link>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The link under a refused request's line whose code is env_unreadable (State.noticeFor): that project's editor. */
export function NoticeEnvLink({ notice }: { notice: { code: ErrorCode; project: string | null } | null }) {
  if (notice?.code !== "env_unreadable" || !notice.project) return null;
  return (
    <Link to={href("projectEnvironment", { project: notice.project })} className="btn notice-env-link" data-testid="notice-env-link">
      {ENV_WORDS.title}
    </Link>
  );
}
