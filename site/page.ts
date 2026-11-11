// The landing page's script (DESIGN-W1 1 and 2.2), for both languages: the demo's stand-in server (site/demo/server.ts,
// which the frames reach over a MessagePort), the device frames, the device switch, the theme button and Copy.
//
// The frames are made here at each load, never in the HTML, so a reload always starts them at demo/ (the app in a
// frame moves its own URL to its route). On a screen 900 px and wider: the phone first, then the laptop once the
// phone's frame has loaded; one shows at a time, and the other keeps its size and its live state, inert. Narrower: one
// frame, full width, whose app reads the real device.
import { segmentFor } from "../web/ui/Segmented.tsx";
import { startDemo } from "./demo/server";
import { THEME_KEY, type PageTheme } from "./theme";
import { WORDS, type Lang } from "./words";

type Device = "phone" | "laptop";

const root = document.documentElement;
const lang: Lang = root.lang === "zh-CN" ? "zh-CN" : "en";
const w = WORDS[lang];
const wide = matchMedia("(min-width: 900px)");
const systemDark = matchMedia("(prefers-color-scheme: dark)");
const coarse = matchMedia("(pointer: coarse)");

// base.css's touch sizes (44 px targets) for the page's own controls, as the app sets them for its own.
const touch = () => document.body.classList.toggle("touch", coarse.matches);
touch();
coarse.addEventListener("change", touch);

// ---- the theme: the device's until the button is pressed, then the visitor's for this tab; the frames follow it.
const chosen = (): PageTheme | null => {
  const t = root.getAttribute("data-theme");
  return t === "dark" || t === "light" ? t : null;
};
const isDark = () => (chosen() ?? (systemDark.matches ? "dark" : "light")) === "dark";
const demo = startDemo({ lang });
demo.setTheme(chosen() ?? "system");

const themeButton = document.querySelector<HTMLButtonElement>(".top .theme-btn");
const showTheme = () => themeButton?.setAttribute("aria-pressed", String(isDark()));
showTheme();
systemDark.addEventListener("change", showTheme);
themeButton?.addEventListener("click", () => {
  const next: PageTheme = isDark() ? "light" : "dark";
  root.setAttribute("data-theme", next);
  try {
    sessionStorage.setItem(THEME_KEY, next);
  } catch {}
  demo.setTheme(next);
  showTheme();
});

// ---- the frames
const device = document.querySelector<HTMLElement>(".stage .device");
const phoneBox = device?.querySelector<HTMLElement>(":scope > .phone") ?? null;
const laptopBox = device?.querySelector<HTMLElement>(":scope > .laptop") ?? null;
const laptopScreen = laptopBox?.querySelector<HTMLElement>(".screen") ?? null;
const demoPath = device?.dataset.demo ?? "demo/";
let phoneFrame: HTMLIFrameElement | null = null;
let laptopFrame: HTMLIFrameElement | null = null;

function frame(box: HTMLElement, kind: Device | "auto", title: string): HTMLIFrameElement {
  const f = document.createElement("iframe");
  f.className = "view";
  f.title = title;
  f.src = `${demoPath}?device=${kind}`;
  box.append(f);
  return f;
}

function makeLaptop() {
  if (laptopFrame || !laptopScreen || !wide.matches) return;
  laptopFrame = frame(laptopScreen, "laptop", w.laptopTitle);
}

function makeFrames() {
  if (!phoneFrame && phoneBox) {
    phoneFrame = frame(phoneBox, wide.matches ? "phone" : "auto", wide.matches ? w.phoneTitle : w.demoTitle);
    // The first screen gets the machine first: the laptop's app starts once the phone's has loaded.
    phoneFrame.addEventListener("load", makeLaptop, { once: true });
  } else if (phoneFrame?.contentDocument?.readyState === "complete") makeLaptop();
}

// ---- the device switch: a radio group (web/ui/Segmented.tsx's keys); the frame not shown is inert.
const seg = document.querySelector<HTMLElement>(".stage .seg");
const radios = seg ? [...seg.querySelectorAll<HTMLButtonElement>('[role="radio"]')] : [];

function show(on: Device, focus = false) {
  if (!device) return;
  device.dataset.on = on;
  const index = on === "phone" ? 0 : 1;
  seg?.style.setProperty("--seg-index", String(index));
  radios.forEach((r, i) => {
    r.setAttribute("aria-checked", String(i === index));
    r.tabIndex = i === index ? 0 : -1;
  });
  if (focus) radios[index]?.focus();
  for (const [box, kind] of [
    [phoneBox, "phone"],
    [laptopBox, "laptop"],
  ] as const) {
    if (!box) continue;
    // A frame that goes out of sight lets go of the keyboard (its app takes none while hidden: site/demo/shim.ts).
    if (kind !== on && document.activeElement instanceof HTMLIFrameElement && box.contains(document.activeElement)) document.activeElement.blur();
    box.inert = kind !== on;
    if (kind === on) box.removeAttribute("aria-hidden");
    else box.setAttribute("aria-hidden", "true");
  }
  if (on === "laptop") makeLaptop();
}

radios.forEach((r, i) => r.addEventListener("click", () => show(i === 0 ? "phone" : "laptop")));
seg?.addEventListener("keydown", (e) => {
  if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  const at = radios.indexOf(e.target as HTMLButtonElement);
  const next = segmentFor(e.key, at, [false, false]);
  if (next === null) return;
  e.preventDefault();
  show(next === 0 ? "phone" : "laptop", true);
});

makeFrames();
show("phone");
wide.addEventListener("change", () => {
  // Narrower than 900 px the page shows only the phone's place, full width.
  if (!wide.matches) show("phone");
  makeFrames();
});

// ---- Copy: the async clipboard, then the old way; a failed write selects the command, so it can be copied by hand.
function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.top = "0";
  ta.style.left = "0";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {}
  ta.remove();
  return ok;
}

function writeClipboard(text: string): Promise<boolean> {
  if (!navigator.clipboard?.writeText) return Promise.resolve(legacyCopy(text));
  return navigator.clipboard.writeText(text).then(
    () => true,
    () => legacyCopy(text),
  );
}

for (const button of document.querySelectorAll<HTMLButtonElement>(".cmd .copy-btn")) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Its name says which command (site/render.ts); it comes back with the button's word.
  const name = button.getAttribute("aria-label") ?? w.copy;
  button.addEventListener("click", () => {
    const code = button.parentElement?.querySelector("code");
    if (!code) return;
    void writeClipboard(code.textContent ?? "").then((ok) => {
      if (!ok) getSelection()?.selectAllChildren(code);
      // The button's name becomes what it shows, and goes back after a moment.
      button.textContent = ok ? w.copied : w.copyFailed;
      button.dataset.state = ok ? "copied" : "failed";
      button.removeAttribute("aria-label");
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          button.textContent = w.copy;
          button.setAttribute("aria-label", name);
          delete button.dataset.state;
        },
        ok ? 1500 : 6000,
      );
    });
  });
}
