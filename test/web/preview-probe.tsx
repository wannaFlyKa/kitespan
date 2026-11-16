// A probe that test/web/preview.test.ts runs in a process of its own: it gives React a small stand-in document (the
// tests have no DOM), mounts a message's file tiles (web/chat/items/Files.tsx MessageFiles) with React's own client
// renderer, so the effects, the layer stack and the unmount are the page's own, drives them as a reader would, and
// prints what it saw as one JSON line. A process of its own, because the page's modules read the window and the
// document when they are first imported (ui/primitives.tsx's listeners), and these globals must not reach another test.
import type { ReactElement } from "react";
import type { Upload } from "../../web/state/types";

type Listener = (e: Event) => void;

class FakeNode {
  nodeType = 1;
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  nodeValue: string | null = null;
  private readonly listeners: { type: string; fn: Listener; capture: boolean }[] = [];
  get ownerDocument(): FakeDocument {
    return doc;
  }
  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get lastChild(): FakeNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }
  get nextSibling(): FakeNode | null {
    const list = this.parentNode?.childNodes ?? [];
    return list[list.indexOf(this) + 1] ?? null;
  }
  get parentElement(): FakeElement | null {
    return this.parentNode instanceof FakeElement ? this.parentNode : null;
  }
  get isConnected(): boolean {
    return doc.contains(this);
  }
  contains(other: FakeNode | null): boolean {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  appendChild<T extends FakeNode>(child: T): T {
    return this.insertBefore(child, null);
  }
  insertBefore<T extends FakeNode>(child: T, before: FakeNode | null): T {
    child.parentNode?.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : this.childNodes.length;
    this.childNodes.splice(at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild<T extends FakeNode>(child: T): T {
    const at = this.childNodes.indexOf(child);
    if (at < 0) throw new Error("removeChild: not a child");
    // The element with the focus leaves the page: the focus is the body's, as in a browser.
    if (doc.activeElement && child.contains(doc.activeElement)) doc.activeElement = doc.body;
    this.childNodes.splice(at, 1);
    child.parentNode = null;
    return child;
  }
  get textContent(): string {
    return this.nodeType === 3 ? (this.nodeValue ?? "") : this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(text: string) {
    for (const c of [...this.childNodes]) this.removeChild(c);
    if (text) this.appendChild(new FakeText(text));
  }
  addEventListener(type: string, fn: Listener, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    if (!this.listeners.some((l) => l.type === type && l.fn === fn && l.capture === capture)) this.listeners.push({ type, fn, capture });
  }
  removeEventListener(type: string, fn: Listener, opts?: boolean | { capture?: boolean }) {
    const capture = typeof opts === "boolean" ? opts : !!opts?.capture;
    const at = this.listeners.findIndex((l) => l.type === type && l.fn === fn && l.capture === capture);
    if (at >= 0) this.listeners.splice(at, 1);
  }
  /** The event goes down from the window to this node, then (when it bubbles) back up, as in a browser. */
  dispatchEvent(e: Event): boolean {
    const path: FakeNode[] = [];
    for (let n: FakeNode | null = this; n; n = n.parentNode) path.push(n);
    if (path[path.length - 1] === doc) path.push(win);
    let stopped = false;
    let now = false;
    Object.defineProperty(e, "target", { value: this, configurable: true });
    e.stopPropagation = () => void (stopped = true);
    e.stopImmediatePropagation = () => void (stopped = now = true);
    const run = (node: FakeNode, capture: boolean) => {
      for (const l of [...node.listeners]) {
        if (now) return;
        if (l.type === e.type && (l.capture === capture || node === this)) l.fn(e);
      }
    };
    for (const node of [...path].reverse()) {
      if (node === this || stopped) break;
      run(node, true);
    }
    if (!stopped) run(this, true);
    if (e.bubbles) {
      for (const node of path.slice(1)) {
        if (stopped) break;
        run(node, false);
      }
    }
    return !e.defaultPrevented;
  }
}

class FakeText extends FakeNode {
  constructor(text: string) {
    super();
    this.nodeType = 3;
    this.nodeValue = text;
  }
}

/** One simple selector: a tag, attributes ([a], [a="v"]) and :not() of those. The page's own selectors are such. */
function matchesOne(el: FakeElement, selector: string): boolean {
  const m = /^([a-z0-9]*)((?:\[[^\]]+\]|:not\(\[[^\]]+\]\))*)$/i.exec(selector.trim());
  if (!m) throw new Error(`the stand-in document does not read the selector ${selector}`);
  if (m[1] && el.localName !== m[1].toLowerCase()) return false;
  for (const part of m[2]!.match(/:not\(\[[^\]]+\]\)|\[[^\]]+\]/g) ?? []) {
    const not = part.startsWith(":not");
    const [, name, , value] = /\[([^=\]]+)(=["']?([^"'\]]*)["']?)?\]/.exec(part)!;
    const has = value === undefined ? el.hasAttribute(name!) : el.getAttribute(name!) === value;
    if (has === not) return false;
  }
  return true;
}

class FakeElement extends FakeNode {
  readonly localName: string;
  readonly namespaceURI = "http://www.w3.org/1999/xhtml";
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, unknown> = { setProperty() {} };
  constructor(tag: string) {
    super();
    this.localName = tag.toLowerCase();
  }
  get tagName() {
    return this.localName.toUpperCase();
  }
  get nodeName() {
    return this.tagName;
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((c): c is FakeElement => c instanceof FakeElement);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value));
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  // React sets an image's source as a property once the element is in the page.
  set src(v: string) {
    this.setAttribute("src", v);
  }
  get src() {
    return this.getAttribute("src") ?? "";
  }
  set href(v: string) {
    this.setAttribute("href", v);
  }
  get href() {
    return this.getAttribute("href") ?? "";
  }
  matches(selector: string): boolean {
    return selector.split(",").some((s) => matchesOne(this, s));
  }
  closest(selector: string): FakeElement | null {
    for (let n: FakeNode | null = this; n; n = n.parentNode) if (n instanceof FakeElement && n.matches(selector)) return n;
    return null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (n: FakeNode) => {
      for (const c of n.childNodes) {
        if (c instanceof FakeElement && c.matches(selector)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  getClientRects() {
    return [{}];
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  }
  focus() {
    if (doc.activeElement === this || !this.isConnected) return;
    doc.activeElement = this;
    this.dispatchEvent(new Event("focusin", { bubbles: true }));
  }
  blur() {
    if (doc.activeElement === this) doc.activeElement = doc.body;
  }
  click() {
    if (this.localName === "a" && this.hasAttribute("download")) saved.push(this.href);
    this.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
  }
  remove() {
    this.parentNode?.removeChild(this);
  }
  set download(v: string) {
    this.setAttribute("download", v);
  }
  set rel(v: string) {
    this.setAttribute("rel", v);
  }
}

class FakeDocument extends FakeNode {
  readonly documentElement = new FakeElement("html");
  readonly body = new FakeElement("body");
  activeElement: FakeElement | null = null;
  defaultView: unknown = null;
  constructor() {
    super();
    this.nodeType = 9;
  }
  attach() {
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }
  createElement(tag: string) {
    return new FakeElement(tag);
  }
  createElementNS(_ns: string, tag: string) {
    return new FakeElement(tag);
  }
  createTextNode(text: string) {
    return new FakeText(text);
  }
  querySelectorAll(selector: string) {
    return this.documentElement.querySelectorAll(selector);
  }
  querySelector(selector: string) {
    return this.documentElement.querySelector(selector);
  }
}

class FakeWindow extends FakeNode {
  innerWidth = 1100;
  innerHeight = 800;
}

/** The observers the page made: `near` says that an element came near the viewport. */
class FakeObserver {
  static all: FakeObserver[] = [];
  static options: unknown[] = [];
  private readonly els = new Set<unknown>();
  constructor(
    private readonly cb: (entries: { isIntersecting: boolean; target: unknown }[]) => void,
    options?: unknown,
  ) {
    FakeObserver.all.push(this);
    FakeObserver.options.push(options);
  }
  observe(el: unknown) {
    this.els.add(el);
  }
  disconnect() {
    this.els.clear();
  }
  static near(el: FakeElement) {
    for (const o of FakeObserver.all) for (const seen of [...o.els]) if (seen === el || el.contains(seen as FakeNode)) o.cb([{ isIntersecting: true, target: seen }]);
  }
  static watched(): number {
    return FakeObserver.all.reduce((n, o) => n + o.els.size, 0);
  }
}

const doc = new FakeDocument();
const win = new FakeWindow();
doc.attach();
doc.defaultView = win;
const saved: string[] = [];
const asked: string[] = [];
const made: { url: string; type: string; size: number }[] = [];
const revoked: string[] = [];

const g = globalThis as unknown as Record<string, unknown>;
Object.assign(win, { document: doc, HTMLIFrameElement: class {}, getSelection: () => null });
g.window = win;
g.document = doc;
g.Node = FakeNode;
g.Element = FakeElement;
g.HTMLElement = FakeElement;
g.HTMLIFrameElement = (win as unknown as { HTMLIFrameElement: unknown }).HTMLIFrameElement;
g.IntersectionObserver = FakeObserver;
g.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
g.history = { state: null, length: 1, pushState() {}, replaceState() {}, back() {}, go() {} };
g.location = new URL("http://127.0.0.1:7944/c/c1");
URL.createObjectURL = (b: Blob) => {
  const url = `blob:test/${made.length + 1}`;
  made.push({ url, type: b.type, size: b.size });
  return url;
};
URL.revokeObjectURL = (url: string) => void revoked.push(url);

// The upload request (POST /api/uploads): it waits until the probe answers it.
class FakeXhr {
  static last: FakeXhr | null = null;
  status = 0;
  responseText = "";
  responseType = "";
  upload: { onprogress: unknown } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  send() {
    FakeXhr.last = this;
  }
  abort() {}
  answer(body: unknown) {
    this.status = 200;
    this.responseText = JSON.stringify(body);
    this.onload?.();
  }
}
g.XMLHttpRequest = FakeXhr;

// The server's two routes of an upload: the existence probe, then the bytes as application/octet-stream.
const GONE = "ugone";
const BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
g.fetch = (async (url: string, init?: RequestInit) => {
  asked.push(`${init?.method ?? "GET"} ${url}`);
  if (url.includes(GONE)) return url.endsWith("/exists") ? Response.json({ exists: false }) : new Response("gone", { status: 404 });
  if (url.endsWith("/exists") || url.includes("/exists/")) return Response.json({ exists: true, kind: "file", name: "x", size: BYTES.length });
  return new Response(BYTES, { headers: { "content-type": "application/octet-stream", "content-disposition": "attachment" } });
}) as unknown as typeof fetch;

const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const { createElement } = await import("react");
const { MessageFiles } = await import("../../web/chat/items/Files");

const up = (id: string, name: string, type: string, size = 48_213): Upload => ({ id, chatId: "c1", name, size, type, path: `/tmp/kitespan-uploads-dev/u-${id}/${name}`, folder: "temp", dir: `/tmp/kitespan-uploads-dev/u-${id}`, at: "2026-10-30T00:00:00Z", state: "done", progress: 1 });
const uploads = [
  up("upng", "shot.png", "image/png"),
  up("ujpeg", "photo.jpg", "image/jpeg"),
  up("ugif", "loop.gif", "image/gif"),
  up("uwebp", "page.webp", "image/webp"),
  up("usvg", "logo.svg", "image/svg+xml"),
  up("utext", "notes.txt", "text/plain"),
  up("ubig", "huge.png", "image/png", 10_000_001),
  up(GONE, "old.png", "image/png"),
  { id: "file docs/map.png", chatId: "c1", rel: "docs/map.png", path: "/work/kitespan/docs/map.png" },
  { id: "file docs/plan.md", chatId: "c1", rel: "docs/plan.md", path: "/work/kitespan/docs/plan.md" },
];

const settle = () => new Promise((r) => setTimeout(r, 20));
const byId = (id: string) => doc.querySelector(`[data-testid="${id}"]`);
/** A tile's thumbnail box: the placeholder or the button, beside the tile with this test id, or null. */
const boxOf = (tile: FakeElement | null) => tile?.closest('[class="chat-shot"]')?.querySelector('[class="chat-shot-thumb"]') ?? null;
const tileOf = (u: (typeof uploads)[number]) => ("rel" in u ? doc.querySelector(`[data-path="${u.rel}"]`) : byId(`download-${u.id}`));
const key = (name: string) => {
  const e = new Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "key", { value: name });
  (doc.activeElement ?? doc.body).dispatchEvent(e);
};
const viewer = () => {
  const v = byId("picture-viewer");
  if (!v) return null;
  const img = v.querySelector("img");
  return { role: v.getAttribute("role"), modal: v.getAttribute("aria-modal"), name: doc.querySelector(`[id="${v.getAttribute("aria-labelledby")}"]`)?.textContent ?? null, src: img?.src ?? null, alt: img?.getAttribute("alt") ?? null, download: !!byId("picture-download"), focus: doc.activeElement?.getAttribute("data-testid") ?? null };
};

const host = doc.body.appendChild(doc.createElement("div"));
const root = createRoot(host as unknown as HTMLElement);
flushSync(() => root.render(createElement(MessageFiles, { uploads }) as ReactElement));
await settle();

const out: Record<string, unknown> = {};
// Before any tile is near the viewport: the boxes stand, and nothing is read.
out.boxes = uploads.map((u) => [u.id, !!boxOf(tileOf(u))]);
out.tiles = uploads.map((u) => !!tileOf(u));
out.askedBeforeNear = [...asked];
out.imagesBeforeNear = doc.querySelectorAll("img").length;
out.watched = FakeObserver.watched();
out.margins = FakeObserver.options[0];

FakeObserver.near(host);
await settle();
out.asked = [...asked];
out.made = made.map((m) => ({ ...m }));
out.thumbs = uploads.map((u) => {
  const t = boxOf(tileOf(u));
  const img = t?.querySelector("img");
  return [u.id, img ? { tag: t!.localName, id: t!.getAttribute("data-testid"), label: t!.getAttribute("aria-label"), src: img.src, alt: img.getAttribute("alt"), width: img.getAttribute("width"), height: img.getAttribute("height") } : null];
});
// The file that is gone: no thumbnail and no box, and its tile as it is today.
out.gone = { box: !!boxOf(byId(`download-${GONE}`)), tile: !!byId(`download-${GONE}`), label: byId(`download-${GONE}`)?.getAttribute("aria-label") };
out.watchedAfter = FakeObserver.watched();

// The viewer: a press on the thumbnail opens it, Esc closes it, and the focus is the thumbnail's again.
const thumb = byId("preview-upng")!;
thumb.focus();
thumb.click();
await settle();
out.opened = viewer();
asked.length = 0;
byId("picture-download")!.click();
await settle();
out.viewerDownload = { asked: [...asked], saved: [...saved] };
key("Escape");
await settle();
out.afterEsc = { viewer: viewer(), focus: doc.activeElement?.getAttribute("data-testid") ?? null };
thumb.click();
await settle();
out.openedAgain = !!viewer();
byId("picture-close")!.click();
await settle();
out.afterClose = { viewer: viewer(), focus: doc.activeElement?.getAttribute("data-testid") ?? null };

// The tile's own press still downloads.
asked.length = 0;
saved.length = 0;
byId("download-upng")!.click();
await settle();
out.tileDownload = { asked: [...asked], saved: [...saved] };

// Bytes that do not draw: the picture goes, its URL with it, and the tile stays.
const bad = byId("preview-ugif")!;
const badUrl = bad.querySelector("img")!.src;
bad.querySelector("img")!.dispatchEvent(new Event("error"));
await settle();
out.bad = { thumb: !!byId("preview-ugif"), box: !!boxOf(byId("download-ugif")), tile: !!byId("download-ugif"), revoked: revoked.includes(badUrl) };

// The tiles unmount: every URL that was made is revoked.
flushSync(() => root.unmount());
await settle();
out.unmounted = { left: doc.querySelectorAll("img").length, made: made.map((m) => m.url), revoked: [...revoked].sort() };
// The composer's chips. A file this page sends draws from the file itself, while it uploads and once it is done (the
// chip of the done upload is a new one, under the server's id), with no request; another page's upload reads the route.
const { DraftChip } = await import("../../web/composer/Chip");
const { act, getState, localFile, newChatUploadsKey } = await import("../../web/state/store");
asked.length = 0;
made.length = 0;
revoked.length = 0;
const chipHost = doc.body.appendChild(doc.createElement("div"));
const chips = createRoot(chipHost as unknown as HTMLElement);
const draw = (list: Upload[]) => flushSync(() => chips.render(createElement("div", null, list.map((u) => createElement(DraftChip, { key: u.id, upload: u, open: false, pathId: "p", onToggle() {}, onRemove() {} })))));
const chipOf = (id: string, host: FakeElement = chipHost) => {
  const chip = host.querySelector(`[data-testid="attach-${id}"]`);
  const img = chip?.querySelector("img");
  return { state: chip?.getAttribute("data-state") ?? null, icon: !!chip?.querySelector('[class="attach-icon"]')?.querySelector("svg"), img: img ? { src: img.src, alt: img.getAttribute("alt"), in: img.parentElement?.getAttribute("class") } : null };
};
const [pending] = act.uploadForNewChat("s1", [{ name: "paste.png", size: BYTES.length, type: "image/png", file: new Blob([BYTES], { type: "image/png" }) }], "p1");
const other = up("uother", "theirs.webp", "image/webp");
draw([pending!, other, up("usvg2", "logo.svg", "image/svg+xml")]);
FakeObserver.near(chipHost);
await settle();
out.chipsUploading = { mine: chipOf(pending!.id), other: chipOf("uother"), svg: chipOf("usvg2"), asked: [...asked], made: made.map((m) => m.type) };
FakeXhr.last!.answer({ upload: { id: "umine", chat: null, project: "p1", name: "paste.png", size: BYTES.length, type: "image/png", path: "/tmp/kitespan-uploads-dev/u-mine/paste.png" } });
await settle();
const done = getState().uploads[newChatUploadsKey("s1")]![0]!;
asked.length = 0;
draw([done, other]);
FakeObserver.near(chipHost);
await settle();
out.chipsDone = { id: done.id, mine: chipOf(done.id), asked: [...asked], held: [!!localFile(pending!.id), !!localFile(done.id)] };
// The new-chat form's chip (web/ui/files.tsx AttachChip) draws this page's own file too.
const { AttachChip } = await import("../../web/ui/files");
const formHost = doc.body.appendChild(doc.createElement("div"));
const form = createRoot(formHost as unknown as HTMLElement);
flushSync(() => form.render(createElement(AttachChip, { upload: done })));
FakeObserver.near(formHost);
await settle();
out.formChip = { mine: chipOf(done.id, formHost), asked: [...asked] };
flushSync(() => form.unmount());
act.removeUpload(newChatUploadsKey("s1"), done.id);
out.heldAfterRemove = !!localFile(done.id);
flushSync(() => chips.unmount());
await settle();
out.chipsUnmounted = { made: made.map((m) => m.url).sort(), revoked: [...revoked].sort() };
// The page holds its newest 20 image files and no other file.
const many = act.uploadForNewChat("s2", [...Array.from({ length: 21 }, (_, i) => ({ name: `p${i}.png`, size: BYTES.length, type: "image/png", file: new Blob([BYTES]) })), { name: "notes.txt", size: 5, type: "text/plain", file: new Blob(["hello"]) }], "p1");
out.heldOfMany = many.map((u) => !!localFile(u.id));
// An upload that fails: its file is not held any more.
const [lost] = act.uploadForNewChat("s3", [{ name: "lost.png", size: BYTES.length, type: "image/png", file: new Blob([BYTES]) }], "p1");
const heldBefore = !!localFile(lost!.id);
FakeXhr.last!.onerror?.();
await settle();
out.failed = { state: getState().uploads[newChatUploadsKey("s3")]![0]!.state, held: [heldBefore, !!localFile(lost!.id)] };
console.log(JSON.stringify(out));
