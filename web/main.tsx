import { createRoot } from "react-dom/client";
import { App, applyAppearance, applyLook } from "./App";
import { linkMode } from "./composer/linkDrafts";
import { seedHeightMark } from "./layout/heightMark";
import { readViewport } from "./layout/size";
import { navigate, seedHistory } from "./router";
import { getState, readLinkModesWith, start } from "./state/store";
import { listenForOpen } from "./notify/worker";
import "./styles/app.css";

// The touch class, the size class, the look and a chosen theme, the text size and Reduce motion are on the page
// before the first render, so the first layout is already the final one (a chat opens at its end on a phone too).
// index.html's inline script set the look and the theme before the first paint already; applyLook only corrects them
// when the stored settings were not readable there. App keeps them in step afterwards.
// The layout height's mark first (layout/heightMark.ts), so the class and every keyboard read start from the full
// height, also a part that mounts while the on-screen keyboard is up.
seedHeightMark();
const vp = readViewport();
document.body.classList.toggle("touch", vp.touch);
document.body.dataset.size = vp.size;
const { settings } = getState();
applyLook(settings);
applyAppearance(settings);
// The store reads the composer's link marks, so a draft from a link goes to the server with `link` set (D49).
readLinkModesWith(linkMode);
// An entry that opened this document after a kitespan page of the tab (a link, a typed URL) gets that page as its
// `from`, so a dialog there closes to where the user was and Settings reads that chat (router.ts seedHistory).
seedHistory();
// One socket per tab to the server the page came from, the projects and the settings (state/store.ts).
start();
// R130: a notification's click opens its path here (the service worker posts it; registering it is Settings' own).
listenForOpen((path) => navigate(path));

createRoot(document.getElementById("root")!).render(<App />);
