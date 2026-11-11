// One transcript item, as ChatView draws it (DESIGN.md 6.3). The session preview uses it too, read-only.
// Contract: export function ItemView({ item, chatId, readOnly }).
// Each item is wrapped in an element with data-testid "item-<id>" and data-item-id, which the routes scroll to.
import { memo, useMemo, useState, type ReactNode } from "react";
import type { Item } from "../../state/types";
import { TranscriptProvider, useTranscript, type Transcript } from "./context";
import { AgentBlock, WorkflowBlock } from "./Blocks";
import { BashBlock, COMPACT_LINE, CardRecord, Divider, RESET_LINE, SlashOutput } from "./Misc";
import { ErrorRow, HookRow, InfoLine, MemoryRow, PluginLine, ReconnectDivider, RefusalNotice, RetryLine, StatusLine } from "./Notes";
import { AssistantText, ThinkingRow, UserMessage } from "./Text";
import { TodoRow, ToolRow } from "./Tool";

/** The one-line rows: they sit close to each other, as tool rows do. */
const COMPACT = new Set<Item["kind"]>(["tool", "todo", "thinking", "card", "memory", "hook", "plugin", "info", "status", "retry", "refusal"]);

function body(item: Item): ReactNode {
  switch (item.kind) {
    case "user":
      return <UserMessage item={item} />;
    case "assistant":
      return <AssistantText item={item} />;
    case "thinking":
      return <ThinkingRow item={item} />;
    case "tool":
      return <ToolRow item={item} />;
    case "todo":
      return <TodoRow item={item} />;
    case "agent":
      return <AgentBlock item={item} />;
    case "workflow":
      return <WorkflowBlock item={item} />;
    case "slash":
      return <SlashOutput item={item} />;
    case "bash":
      return <BashBlock item={item} />;
    case "compact":
      return <Divider text={COMPACT_LINE} />;
    case "card":
      return <CardRecord id={item.id} card={item.card} />;
    case "status":
      return <StatusLine item={item} />;
    case "retry":
      return <RetryLine item={item} />;
    case "refusal":
      return <RefusalNotice item={item} />;
    case "info":
      return <InfoLine item={item} />;
    case "memory":
      return <MemoryRow item={item} />;
    case "plugin":
      return <PluginLine item={item} />;
    case "error":
      return <ErrorRow item={item} />;
    case "hook":
      return <HookRow item={item} />;
    case "reconnect":
      return <ReconnectDivider item={item} />;
    case "reset":
      // CV-7: Claude Code reset the conversation (/clear); what follows is a fresh transcript.
      return <Divider text={RESET_LINE} />;
  }
}

function Row({ item }: { item: Item }) {
  const ctx = useTranscript();
  const hl = ctx?.highlightId === item.id;
  return (
    <div
      className={`chat-item chat-item-${item.kind}${COMPACT.has(item.kind) ? " chat-compact" : ""}${hl ? " is-highlight" : ""}`}
      data-testid={`item-${item.id}`}
      data-item-id={item.id}
    >
      {body(item)}
    </div>
  );
}

export const ItemView = memo(function ItemView({ item, chatId, readOnly }: { item: Item; chatId: string; readOnly?: boolean }) {
  const outer = useTranscript();
  // Outside a chat (the session preview) there is no route to follow: rows keep their own open state.
  const [opened, setOpened] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const local = useMemo<Transcript | null>(
    () =>
      outer
        ? null
        : {
            chatId,
            view: "verbose",
            readOnly: !!readOnly,
            isOpen: (id, byDefault) => opened.get(id) ?? byDefault,
            toggle: (id, _route, open) => setOpened((m) => new Map(m).set(id, !open)),
          },
    [outer, chatId, readOnly, opened],
  );
  return local ? (
    <TranscriptProvider value={local}>
      <Row item={item} />
    </TranscriptProvider>
  ) : (
    <Row item={item} />
  );
});
