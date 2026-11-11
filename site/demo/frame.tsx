// The demo frame's entry (DESIGN-W1 4.2): the site's build resolves web/index.html's ./main.tsx to this file. The
// order is the point: the stand-in first (shim.ts), then the app itself (web/main.tsx, unchanged), then the bridge
// that needs the running app (bridge.ts). ES modules run in this order, and the bundle keeps it.
import "./shim";
import "../../web/main.tsx";
import "./bridge";
