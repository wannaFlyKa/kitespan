// The transcript's own 16 px stroke icons, drawn like ui/icons.tsx (which the lead owns).
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

export const IconPencil = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M10.6 2.9 13.1 5.4 5.6 12.9 2.6 13.4 3.1 10.4z M9.3 4.2l2.5 2.5" /></svg>);
export const IconFilePlus = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M9 1.8H4c-.6 0-1 .4-1 1v10.4c0 .6.4 1 1 1h7c.6 0 1-.4 1-1V4.8zM9 1.8v3h3M7.5 7.6v4M5.5 9.6h4" /></svg>);
export const IconStack = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" /><path d="M2.5 4.5h.01M2.5 8h.01M2.5 11.5h.01" strokeWidth={2.4} /></svg>);
export const IconChecklist = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="m2.4 4.4 1.2 1.2 2-2.2M2.4 10.4l1.2 1.2 2-2.2M8 4.6h5.6M8 10.6h5.6" /></svg>);
export const IconQuestion = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="8" cy="8" r="6.2" /><path d="M6.3 6.3a1.8 1.8 0 1 1 2.6 1.6c-.6.3-.9.7-.9 1.3v.3M8 11.6h.01" /></svg>);
export const IconThought = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M8 2.2a4.3 4.3 0 0 0-2.6 7.7c.4.3.6.8.6 1.3v.6h4v-.6c0-.5.2-1 .6-1.3A4.3 4.3 0 0 0 8 2.2zM6.4 14h3.2" /></svg>);
export const IconPlan = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><rect x="2.5" y="2" width="11" height="12" rx="1.8" /><path d="M5.2 5.4h5.6M5.2 8h5.6M5.2 10.6h3.4" /></svg>);
export const IconDialog = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M2.4 3.8c0-.7.6-1.3 1.3-1.3h8.6c.7 0 1.3.6 1.3 1.3v6c0 .7-.6 1.3-1.3 1.3H7.4L4.6 13.5v-2.4h-.9c-.7 0-1.3-.6-1.3-1.3z" /></svg>);
export const IconDown = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M8 3v10M3.8 8.8 8 13l4.2-4.2" /></svg>);

// Claude Code's own lines (DESIGN.md 6.3): info and warning lines, the retry and status lines, the refusal notice,
// the error row, memory recall, plugin installs and hook rows.
export const IconInfo = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="8" cy="8" r="6.2" /><path d="M8 7.3v3.9M8 4.9h.01" /></svg>);
export const IconWarning = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M7.1 2.7a1 1 0 0 1 1.8 0l5.3 9.6a1 1 0 0 1-.9 1.5H2.7a1 1 0 0 1-.9-1.5z" /><path d="M8 6.3v3.1M8 11.6h.01" /></svg>);
export const IconRetry = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M13.2 8A5.2 5.2 0 1 1 11.6 4.3" /><path d="M12.2 1.9v2.8H9.4" /></svg>);
export const IconBan = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="8" cy="8" r="6.2" /><path d="m3.7 3.7 8.6 8.6" /></svg>);
export const IconError = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><circle cx="8" cy="8" r="6.2" /><path d="M8 4.7v4.1M8 11.2h.01" /></svg>);
export const IconCompress = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M8 1.8v4M5.9 3.9 8 6l2.1-2.1M8 14.2v-4M5.9 12.1 8 10l2.1 2.1M2.6 8h10.8" /></svg>);
export const IconMemory = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M3 3.3c0-.8.7-1.5 1.5-1.5H13v10.4H4.5c-.8 0-1.5.7-1.5 1.5z" /><path d="M3 13.7c0 .8.7 1.5 1.5 1.5H13v-3M6 5h4" /></svg>);
export const IconPuzzle = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M2.8 5.2h2.6a1.6 1.6 0 1 1 3.2 0h2.6v2.6a1.6 1.6 0 1 1 0 3.2v2.6H2.8z" /></svg>);
export const IconHook = ({ size, ...p }: P) => (<svg {...base(size)} {...p}><path d="M10.6 1.8v7.6a3.3 3.3 0 0 1-6.6 0V8" /><path d="M2.4 9.6 4 8l1.6 1.6" /></svg>);

/** Claude's working mark: an eight-ray spark. It turns only while Claude works (still under reduced motion). */
export const IconSpark = ({ size, ...p }: P) => (
  <svg {...base(size)} {...p}>
    <path d="M8 1.6v4M8 10.4v4M1.6 8h4M10.4 8h4M3.5 3.5l2.8 2.8M9.7 9.7l2.8 2.8M12.5 3.5 9.7 6.3M6.3 9.7l-2.8 2.8" strokeWidth={1.7} />
  </svg>
);
