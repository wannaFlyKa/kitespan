// The landing page's demo (DESIGN-W1 2): its own words, its devices and where each device starts. The stand-in
// server (server.ts), the frame's shim (shim.ts) and the site check (scripts/site-check.ts) read them from here, so
// a line is written once. Pure data: no DOM, no Bun API, no import from web/.

import type { UpdateRefusal } from "../../shared/update";

/** The line that a control which does not run in the demo shows in place (DESIGN-W1 2.3); English on both pages. */
export const DEMO_LINES = {
  terminal: "The Terminal pane does not run in this demo.",
  update: "Updates do not run in this demo.",
  restart: "Restart does not run in this demo.",
  notifications: "Notifications are off in this demo.",
  files: "Files do not upload in this demo.",
  downloads: "Downloads do not run in this demo.",
  commands: "Commands do not run in this demo.",
  folders: "This demo has only its made-up folders.",
  other: "This does not run in this demo.",
} as const;
export type DemoLineKey = keyof typeof DEMO_LINES;

/**
 * The refusal that the demo's Check now answers with (a kitespan that does not update itself); the demo's build says
 * DEMO_LINES.update for it (site/demo/swap/update-words.ts), in Check now's own row.
 */
export const DEMO_CHECK_REFUSAL: UpdateRefusal = "dist";

/** The landing page's languages. */
export const DEMO_LANGS = ["en", "zh-CN"] as const;
export type DemoLang = (typeof DEMO_LANGS)[number];

/** The scripted reply to a message sent in the demo (DESIGN-W1 2.5), in the landing page's language. */
export const DEMO_REPLIES: Record<DemoLang, string> = {
  en: "This is a demo with made-up chats, so nothing ran. With kitespan on your own machine, this message goes to your Claude Code, and its reply streams in here as it is written.",
  "zh-CN": "这是一个演示，对话都是虚构的，所以什么都没有真正运行。在你自己的机器上，kitespan 会把这条消息交给你的 Claude Code，它的回复会边写边显示在这里。",
};

/** The example chat ("Fix the flaky upload test"), its waiting permission card and its first turn's changes. */
export const EXAMPLE_CHAT = "k3m7q2x4abk3m7q2x4ab";
export const EXAMPLE_CARD = "toolu_01AbCdEf";
export const EXAMPLE_CHANGES = "m7q2x4abk3";

/** The demo's machine: its name, its home folder and the example chat's folder (a home folder of its own, /work). */
export const DEMO_HOST = "box";
export const DEMO_HOME = "/work";
export const DEMO_ROOT = "/work/kitespan";

/**
 * The frames: `phone` and `laptop` on a laptop or tablet screen (each acts as that device), `auto` full width on a
 * phone (the app reads the real device).
 */
export const DEMO_DEVICES = ["phone", "laptop", "auto"] as const;
export type DemoDevice = (typeof DEMO_DEVICES)[number];

/** Where each frame's app starts (DESIGN-W1 4.3): the card on the phone, the split panel with the diff on the laptop. */
export const START_ROUTES: Record<DemoDevice, string> = {
  phone: `/c/${EXAMPLE_CHAT}`,
  laptop: `/c/${EXAMPLE_CHAT}/changes/${EXAMPLE_CHANGES}/src/upload.ts?below=details`,
  auto: `/c/${EXAMPLE_CHAT}`,
};

/** The tag of a frame's first message to the landing page, which carries the frame's end of its MessageChannel. */
export const DEMO_TAG = "kitespanDemo";

/** The device of a frame's query (`?device=`): an unknown or missing one is `auto`. */
export function demoDevice(search: string): DemoDevice {
  const v = new URLSearchParams(search).get("device");
  return (DEMO_DEVICES as readonly string[]).includes(v ?? "") ? (v as DemoDevice) : "auto";
}
