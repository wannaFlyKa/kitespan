// The + menu (DESIGN.md 6.5) with Desktop's item names and no helper line under an item (D51, M12): the labels say what
// each one does. Nothing here acts on the chat by itself: Add files or photos opens the device's file picker (the
// composer's file input; D37, v0.1 core), and each other item opens a state that has its own URL. Uploads opens the
// chat's Uploads list (/c/<chat>/uploads), only while the chat has an upload: the side panel draws no empty Uploads
// row, and the list stays one tap from + (6.7, D51, M17). Permission and Model sit here too, as in Anthropic's phone
// app, but only while the phone's picker row is folded away under the keyboard (7.5, M11); at 834 px and wider the
// chips show them, so the menu does not. Stop is the phone's first row, in a group of its own, while a turn runs
// (DESIGN-T1 T-4): the phone's one key is Send while the box holds a draft (7.5), and + is by the thumb; it opens the
// Stop confirm, as the session menu's Stop does. Connectors says something only
// when a connector needs the user (M18's rule), drawn as the Details card draws it (panels/problems.tsx: failed in
// --danger, sign-in in --warn). Add folder is not offered: an SDK session has no /add-dir, and kitespan
// never passes additionalDirectories (6.5, D5). Plugins opens, in the menu itself, the list of the plugins that the
// chat loaded, each with its version, as its second line (6.5: the init message's plugins); installing or managing
// one stays with the user's own claude, so the list holds no control. It folds open in place, so it has the fold
// chevron (down, turned up while open); the right chevron is for the items that open another view (6.7).
// A laptop shows base.css's .menu with .menu-row rows; a sheet shows one .group list with the look's icon tiles.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { ConnectorInfo, PluginInfo } from "../../shared/protocol";
import { Popup } from "../ui/primitives";
import { IconAgent, IconChevron, IconFile, IconPaperclip, IconPlug, IconRight, IconShield, IconStop } from "../ui/icons";
import { IconPuzzle } from "../chat/items/icons";
import { connectorProblems } from "../panels/format";
import { ConnectorProblems } from "../panels/problems";
import { listKeys } from "./lists";

/** The Plugins list of a chat whose Claude Code has not started in this server life: its next message starts it. */
export const PLUGINS_UNREAD = "Send a message to read it.";

/**
 * The plugins that the chat loaded (null: not known until its Claude Code starts), each with its version: the Plugins
 * item's second line while it is open, so the list starts where the items' labels do in every look. Text only (it sits
 * inside the item's button).
 */
export function PluginsList({ plugins }: { plugins: readonly PluginInfo[] | null }) {
  if (!plugins || !plugins.length) return <span className="cmp-plugins">{plugins ? "None" : PLUGINS_UNREAD}</span>;
  return (
    <span className="cmp-plugins">
      {plugins.map((p) => (
        <span key={p.name} className="cmp-plugin">
          <span className="cmp-plugin-name">{p.name}</span>
          {p.version ? <span className="cmp-plugin-version">{` ${p.version}`}</span> : null}
        </span>
      ))}
    </span>
  );
}

type Tile = "blue" | "grey" | "green" | "orange" | "indigo" | "purple" | "red";

/** `more`: the item opens another view (the right chevron); `fold`: it opens in place (the fold chevron). */
function Item(props: { sheet: boolean; icon: ReactNode; tile: Tile; label: string; hint?: ReactNode; value?: ReactNode; more?: boolean; fold?: boolean; expanded?: boolean; testId?: string; onClick: () => void }) {
  const { sheet, icon, tile, label, hint, value, more, fold, expanded, testId, onClick } = props;
  if (sheet)
    return (
      <button type="button" role="menuitem" className={`group-row cmp-plus-row${expanded ? " is-expanded" : ""}`} data-testid={testId} aria-expanded={expanded} onClick={onClick}>
        <span className={`group-icon tile-${tile}`} aria-hidden="true">
          {icon}
        </span>
        <span className="group-text">
          <span className="group-label">{label}</span>
          {hint ? <span className="group-sub">{hint}</span> : null}
        </span>
        {value ? <span className="group-value">{value}</span> : null}
        {fold ? <IconChevron className="group-chevron cmp-fold-chevron" /> : more ? <IconRight className="group-chevron" /> : null}
      </button>
    );
  return (
    <button type="button" role="menuitem" className={`menu-row cmp-plus-row${expanded ? " is-expanded" : ""}`} data-testid={testId} aria-expanded={expanded} onClick={onClick}>
      <span className="cmp-plus-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="cmp-row-text">
        <span className="cmp-row-label">{label}</span>
        {hint || value ? <span className="row-hint">{hint ?? value}</span> : null}
      </span>
    </button>
  );
}

export function PlusMenu(props: {
  open: boolean;
  anchor: RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  sheet: boolean;
  /** The phone's picker row is folded (the keyboard was up when + was pressed): Permission and Model show here. */
  pickers: boolean;
  /** The chat's connectors as the Details card reads them (panels/details.ts connectorsOf). */
  connectors: readonly Pick<ConnectorInfo, "status">[];
  /** The plugins that the chat loaded (its init facts), or null while its Claude Code has not started. */
  plugins: readonly PluginInfo[] | null;
  /** No upload can go anywhere yet (store.ts uploadRoot): the line that says why, under Add files or photos. */
  refused: string | null;
  /** The chat has an upload: the Uploads item shows. */
  uploads: boolean;
  modeName: string;
  modelName: string;
  onAttach: () => void;
  onUploads: () => void;
  onSlash: () => void;
  onConnectors: () => void;
  onPermission: () => void;
  onModel: () => void;
  /** A turn runs on the phone: Stop first, which opens the Stop confirm (T-4). */
  onStop?: () => void;
}) {
  const { open, anchor, onClose, sheet, pickers, refused } = props;
  const problems = connectorProblems(props.connectors);
  const box = useRef<HTMLDivElement>(null);
  // Plugins opens its list under it, in the menu; the menu opens with the list closed.
  const [plugins, setPlugins] = useState(false);
  useEffect(() => {
    // The first row that adds to the message takes the focus, never Stop.
    if (open) box.current?.querySelector<HTMLElement>('.cmp-plus-main [role="menuitem"]')?.focus({ preventScroll: true });
    else setPlugins(false);
  }, [open]);
  return (
    <Popup open={open} onClose={onClose} anchor={anchor} title="Add to this chat" testId="plus-menu">
      <div className={sheet ? "cmp-sheet" : undefined} ref={box}>
        {props.onStop ? (
          <div className={sheet ? "group cmp-plus cmp-plus-stop" : "cmp-plus cmp-plus-stop"} role="menu" aria-label="Turn" onKeyDown={listKeys}>
            <Item sheet={sheet} tile="red" icon={<IconStop />} label="Stop" testId="plus-stop" onClick={props.onStop} />
          </div>
        ) : null}
        <div className={sheet ? "group cmp-plus cmp-plus-main" : "cmp-plus cmp-plus-main"} role="menu" aria-label="Add to this chat" onKeyDown={listKeys}>
          <Item sheet={sheet} tile="blue" icon={<IconPaperclip />} label="Add files or photos" hint={refused ?? undefined} testId="plus-attach" onClick={props.onAttach} />
          {props.uploads ? <Item sheet={sheet} tile="blue" icon={<IconFile />} label="Uploads" more testId="plus-uploads" onClick={props.onUploads} /> : null}
          <Item sheet={sheet} tile="grey" icon={<span className="cmp-plus-slash">/</span>} label="Slash commands" testId="plus-slash" onClick={props.onSlash} />
          <Item sheet={sheet} tile="green" icon={<IconPlug />} label="Connectors" value={problems.failed || problems.signIn ? <ConnectorProblems list={props.connectors} /> : undefined} more testId="plus-connectors" onClick={props.onConnectors} />
          <Item
            sheet={sheet}
            tile="purple"
            icon={<IconPuzzle />}
            label="Plugins"
            hint={plugins ? <PluginsList plugins={props.plugins} /> : undefined}
            fold
            expanded={plugins}
            testId="plus-plugins"
            onClick={() => setPlugins((v) => !v)}
          />
          {pickers ? <Item sheet={sheet} tile="orange" icon={<IconShield />} label="Permission" value={props.modeName} more testId="plus-permission" onClick={props.onPermission} /> : null}
          {pickers ? <Item sheet={sheet} tile="indigo" icon={<IconAgent />} label="Model" value={props.modelName} more testId="plus-model" onClick={props.onModel} /> : null}
        </div>
      </div>
    </Popup>
  );
}
