// A list of transcript rows as a view folds them (fold.ts): summary rows and items, in order.
import type { ReactNode } from "react";
import type { Entry } from "../fold";
import { useTranscript } from "./context";
import { ItemView } from "./ItemView";
import { SummaryRow } from "./Tool";

/** One entry, keyed by its row's id (or its summary's), so it keeps its element wherever the list draws it. */
export function entryNode(e: Entry, chatId: string, readOnly?: boolean): ReactNode {
  return e.type === "summary" ? <SummaryRow key={e.id} id={e.id} items={e.items} /> : <ItemView key={e.item.id} item={e.item} chatId={chatId} readOnly={readOnly} />;
}

export function Entries({ entries }: { entries: Entry[] }) {
  const ctx = useTranscript();
  return <>{entries.map((e) => entryNode(e, ctx?.chatId ?? "", ctx?.readOnly))}</>;
}
