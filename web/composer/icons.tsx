// The composer's own marks, in the 16 px stroke style of ui/icons.tsx.
import type { SVGProps } from "react";

/** Five rising bars; the first `level` are filled, so the model button shows the effort level at a glance. */
export function EffortBars({ level, size = 14, ...p }: SVGProps<SVGSVGElement> & { level: number; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" {...p}>
      {[0, 1, 2, 3, 4].map((i) => {
        const h = 3 + i * 2.6;
        return <rect key={i} x={0.6 + i * 3.05} y={14.5 - h} width={2.4} height={h} rx={0.7} fill="currentColor" opacity={i < level ? 1 : 0.2} />;
      })}
    </svg>
  );
}
