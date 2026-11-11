// "Claude is acting" in the bar (DESIGN-B1 4.4, 4.16, 4.18; F2, F13, F26): a .chip with the working mark (base.css; its
// hit area is 44 px on touch). In the tab on screen it is a status, and beside a chat that is not the acting one a link
// to that chat; in another tab a button that shows Claude's tab; with the tab unknown a status. Its narrow form (the
// bar's fit rule) is the mark alone for a status, and "Claude's tab" for another tab; its name keeps its words.
import { href } from "../router";
import { useStore } from "../state/store";
import { Link } from "../ui/primitives";
import { CHIP_WORDS, type ChipForm } from "./claude";

const Spin = () => (
  <span className="chat-spin" aria-hidden="true">
    <span className="chat-spin-still">{CHIP_WORDS.acting}</span>
  </span>
);

export function Chip({ chip, narrow, onShowTab, measure }: { chip: ChipForm; narrow: boolean; onShowTab: (tab: string) => void; measure?: "long" | "narrow" }) {
  const title = useStore((s) => (chip.form === "here" ? s.chats.find((c) => c.id === chip.chat)?.title : undefined));
  const probe = measure ? { "aria-hidden": true as const, tabIndex: -1, "data-chip-measure": measure, className: "chip bp-chip bp-chip-measure" } : null;
  if (chip.form === "other") {
    const words = narrow ? CHIP_WORDS.narrowOther : CHIP_WORDS.other;
    const name = narrow ? CHIP_WORDS.narrowOtherName : CHIP_WORDS.otherName;
    if (probe)
      return (
        <span {...probe}>
          <Spin />
          {words}
        </span>
      );
    return (
      <button type="button" className="chip bp-chip" aria-label={name} title={narrow ? CHIP_WORDS.other : undefined} data-testid="browser-chip" data-form="other" onClick={() => onShowTab(chip.tab)}>
        <Spin />
        {words}
      </button>
    );
  }
  const words = narrow ? null : CHIP_WORDS.acting;
  if (probe)
    return (
      <span {...probe} className={`chip bp-chip bp-chip-measure${narrow ? " is-narrow" : ""}`}>
        <Spin />
        {words}
      </span>
    );
  if (chip.form === "here" && chip.link)
    return (
      <Link to={href("chat", { chat: chip.chat })} className={`chip bp-chip${narrow ? " is-narrow" : ""}`} aria-label={CHIP_WORDS.link(title ?? "another chat")} title={narrow ? CHIP_WORDS.acting : undefined} data-testid="browser-chip">
        <Spin />
        {words}
      </Link>
    );
  return (
    <span className={`chip bp-chip${narrow ? " is-narrow" : ""}`} role={narrow ? "img" : undefined} aria-label={narrow ? CHIP_WORDS.acting : undefined} title={narrow ? CHIP_WORDS.acting : undefined} data-testid="browser-chip" data-form={chip.form}>
      <Spin />
      {words}
    </span>
  );
}
