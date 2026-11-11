// A small set of 16 px stroke icons, drawn inline (no icon font, no files).
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 16): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
});

export const IconPlus = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M8 3v10M3 8h10" /></svg>);
export const IconChats = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" /></svg>);
export const IconGear = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7 3.6 3.6" /></svg>);
export const IconMore = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="3.5" cy="8" r=".9" fill="currentColor" /><circle cx="8" cy="8" r=".9" fill="currentColor" /><circle cx="12.5" cy="8" r=".9" fill="currentColor" /></svg>);
export const IconSend = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M8 13V3M3.8 7.2 8 3l4.2 4.2" /></svg>);
export const IconStop = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none" /></svg>);
export const IconChevron = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="m5 6.5 3 3 3-3" /></svg>);
export const IconRight = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="m6.5 4.5 3.5 3.5-3.5 3.5" /></svg>);
export const IconClose = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="m4 4 8 8M12 4l-8 8" /></svg>);
export const IconBack = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>);
export const IconTerminal = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" /><path d="m4.6 6.2 2 1.8-2 1.8M8.2 10h3" /></svg>);
export const IconFolder = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M2 4.6c0-.6.5-1.1 1.1-1.1h3l1.4 1.5h5.4c.6 0 1.1.5 1.1 1.1v5.8c0 .6-.5 1.1-1.1 1.1H3.1c-.6 0-1.1-.5-1.1-1.1z" /></svg>);
export const IconBranch = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="4.5" cy="3.8" r="1.4" /><circle cx="4.5" cy="12.2" r="1.4" /><circle cx="11.5" cy="5.5" r="1.4" /><path d="M4.5 5.2v5.6M11.5 6.9c0 2.6-3.2 2.4-6.2 4" /></svg>);
export const IconPlug = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.2a3.5 3.5 0 0 1-7 0zM8 11.2v2.3" /></svg>);
export const IconFile = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4 1.8h5l3 3v8.4c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2.8c0-.6.4-1 1-1zM9 1.8v3h3" /></svg>);
export const IconDoc = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4 1.8h8c.6 0 1 .4 1 1v8l-3.4 3.4H4c-.6 0-1-.4-1-1V2.8c0-.6.4-1 1-1zM9.6 14.2v-3.4H13" /></svg>);
export const IconCopy = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="5" y="5" width="8.5" height="8.5" rx="1.6" /><path d="M10.8 5V3.6c0-.6-.5-1.1-1.1-1.1H3.6c-.6 0-1.1.5-1.1 1.1v6.1c0 .6.5 1.1 1.1 1.1H5" /></svg>);
export const IconCheck = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="m3.5 8.5 3 3 6-7" /></svg>);
export const IconPanel = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" /><path d="M10 2.8v10.4" /></svg>);
export const IconSidebar = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" /><path d="M6 2.8v10.4" /></svg>);
export const IconSearch = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="7" cy="7" r="4.2" /><path d="m10.2 10.2 3.3 3.3" /></svg>);
/** The side chat (R124): one bubble with a smaller one beside it, a question asked on the side. */
export const IconSideChat = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M2 3.6c0-.8.6-1.4 1.4-1.4h6.2c.8 0 1.4.6 1.4 1.4v3.6c0 .8-.6 1.4-1.4 1.4H5.2L2.6 10.4V8.5A1.4 1.4 0 0 1 2 7.3z" /><path d="M12.6 7.4h.1c.7 0 1.3.6 1.3 1.3v2.9c0 .5-.3.9-.7 1.2v1.4l-1.8-1.3H9.4c-.7 0-1.3-.6-1.3-1.3v-.6" /></svg>);
/** R130: Settings > Notifications' tile, a bell in the tiles' stroke. */
export const IconBell = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4.2 11.2V7.1a3.8 3.8 0 0 1 7.6 0v4.1l1.2 1.2H3z" /><path d="M6.6 14a1.6 1.6 0 0 0 2.8 0" /></svg>);
export const IconGlobe = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="8" cy="8" r="6.2" /><path d="M1.8 8h12.4M8 1.8c1.8 2 2.6 4 2.6 6.2S9.8 12.2 8 14.2C6.2 12.2 5.4 10.2 5.4 8S6.2 3.8 8 1.8z" /></svg>);
export const IconCards = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="2.2" y="2.2" width="11.6" height="4.6" rx="1.6" /><rect x="2.2" y="9.2" width="11.6" height="4.6" rx="1.6" /></svg>);
export const IconBolt = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M9 1.8 3.8 9h4L7 14.2 12.2 7h-4z" /></svg>);
export const IconShield = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M8 1.8 13 3.8v3.9c0 3-2.1 5.4-5 6.5-2.9-1.1-5-3.5-5-6.5V3.8z" /></svg>);
export const IconAgent = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="3" y="4.5" width="10" height="8" rx="2.5" /><path d="M8 4.5V2.5M6 8.2v.6M10 8.2v.6" /></svg>);
export const IconFlow = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="3.5" cy="4" r="1.5" /><circle cx="3.5" cy="12" r="1.5" /><circle cx="12.5" cy="8" r="1.5" /><path d="M5 4h2.5c1.4 0 2 .8 2 2v0c0 1 .5 2 1.5 2M5 12h2.5c1.4 0 2-.8 2-2" /></svg>);
// Plan v2 and the files flow (D37): the compose button (a square with a pencil, New chat), upload and download, an
// image, a paperclip, a trash can and an info mark.
export const IconCompose = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M13.2 8.6v3.6c0 1.1-.9 2-2 2H3.8c-1.1 0-2-.9-2-2V4.8c0-1.1.9-2 2-2h3.6" /><path d="m11.6 1.9 2.5 2.5-5.9 5.9-3 .5.5-3z" /></svg>);
export const IconUpload = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M8 10.2V2.2M4.8 5.4 8 2.2l3.2 3.2M2.5 10.5v1.7c0 .9.7 1.6 1.6 1.6h7.8c.9 0 1.6-.7 1.6-1.6v-1.7" /></svg>);
export const IconDownload = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M8 2.2v8M4.8 7 8 10.2 11.2 7M2.5 10.5v1.7c0 .9.7 1.6 1.6 1.6h7.8c.9 0 1.6-.7 1.6-1.6v-1.7" /></svg>);
export const IconImage = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="2" /><circle cx="5.6" cy="6.4" r="1.2" /><path d="m2.2 12 3.6-3.4 2.6 2.4 2-1.8 3.6 3.2" /></svg>);
export const IconPaperclip = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="m13 7.4-5.2 5.2a3.2 3.2 0 0 1-4.5-4.5l5.6-5.6a2.1 2.1 0 0 1 3 3L6.3 11a1 1 0 0 1-1.5-1.5l5-5" /></svg>);
export const IconTrash = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M2.8 4.3h10.4M6.4 4.3V2.8h3.2v1.5M4.2 4.3l.6 8.6c0 .7.6 1.3 1.3 1.3h3.8c.7 0 1.3-.6 1.3-1.3l.6-8.6M6.7 7v4.5M9.3 7v4.5" /></svg>);
export const IconInfo = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="8" cy="8" r="6.2" /><path d="M8 7.3v3.8" /><circle cx="8" cy="4.9" r=".8" fill="currentColor" stroke="none" /></svg>);
// Iteration 7, the browser pane (DESIGN-B1 4): Forward (Back turned), Reload, the globe with a slash (a browser state
// that needs the user), Claude's pointer on a tab, the Keyboard button, the phone's Tabs, Zoom out, Move, and a page
// that crashed.
export const IconForward = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M6 3.5 10.5 8 6 12.5" /></svg>);
export const IconReload = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M13 8.2A5 5 0 1 1 11.6 4.5" /><path d="M12.2 2.4v2.6H9.6" /></svg>);
export const IconGlobeOff = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="8" cy="8" r="6.2" /><path d="M1.8 8h12.4M8 1.8c1.8 2 2.6 4 2.6 6.2S9.8 12.2 8 14.2C6.2 12.2 5.4 10.2 5.4 8S6.2 3.8 8 1.8zM2.5 13.5l11-11" /></svg>);
export const IconPointer = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4.2 2.6 12 7.7l-3.5.9 2 3.6-1.5.8-2-3.6-2.6 2.5z" /></svg>);
export const IconKeyboard = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="1.5" y="3.8" width="13" height="8.4" rx="1.6" /><path d="M4 6.6h.6M6.5 6.6h.6M9 6.6h.6M11.4 6.6h.6M5 9.5h6" /></svg>);
export const IconTabs = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="2" y="4.6" width="8.8" height="8.8" rx="1.6" /><path d="M5.2 4.6v-1c0-.6.5-1.1 1.1-1.1h6.1c.6 0 1.1.5 1.1 1.1v6.1c0 .6-.5 1.1-1.1 1.1h-1.6" /></svg>);
export const IconMinus = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M3 8h10" /></svg>);
export const IconMove = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M8 1.8v12.4M1.8 8h12.4M6.2 3.6 8 1.8l1.8 1.8M6.2 12.4 8 14.2l1.8-1.8M3.6 6.2 1.8 8l1.8 1.8M12.4 6.2 14.2 8l-1.8 1.8" /></svg>);
export const IconPageCrash = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M4 1.8h5l3 3v8.4c0 .6-.4 1-1 1H4c-.6 0-1-.4-1-1V2.8c0-.6.4-1 1-1zM9 1.8v3h3" /><path d="m5.6 8.4 1.2 1.2 1.2-1.2 1.2 1.2 1.2-1.2" /></svg>);
