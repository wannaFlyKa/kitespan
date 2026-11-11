// Motion that the page drives from script (row 79's text reveal): one animation-frame loop that every reveal on the
// page shares, which runs only while one of them has something left to show, and Reduce motion as script sees it
// (Settings > Appearance > Reduce motion, or the system's setting when that one follows the system). CSS has its own
// rules for the same two settings (tokens.css, base.css).
import { useSyncExternalStore } from "react";
import { useStore } from "../state/store";

/** Motion is reduced: Settings says On, or it follows the system and the system asks for less motion. */
export function reducedMotion(setting: "system" | "on", system: boolean): boolean {
  return setting === "on" || system;
}

const QUERY = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
}

function subscribeSystem(cb: () => void): () => void {
  const m = media();
  if (!m) return () => {};
  m.addEventListener("change", cb);
  return () => m.removeEventListener("change", cb);
}

const systemReduced = () => media()?.matches ?? false;

/** Reduce motion as the page wears it now; it follows a change of either setting. */
export function useReducedMotion(): boolean {
  const setting = useStore((s) => s.settings.reduceMotion);
  const system = useSyncExternalStore(subscribeSystem, systemReduced, () => false);
  return reducedMotion(setting, system);
}

/** The page's clock for motion (the animation frames' clock). */
export function motionNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

const frameSubs = new Set<(now: number) => void>();
let frameId = 0;

function frame(now: number) {
  frameId = 0;
  for (const cb of [...frameSubs]) cb(now);
  if (frameSubs.size && typeof requestAnimationFrame === "function") frameId = requestAnimationFrame(frame);
}

/**
 * Call `cb` once per animation frame until the returned function is called. Every caller shares one loop, and the loop
 * stops when nobody listens; without animation frames (a server render, a test) nothing is called.
 */
export function onFrames(cb: (now: number) => void): () => void {
  frameSubs.add(cb);
  if (!frameId && typeof requestAnimationFrame === "function") frameId = requestAnimationFrame(frame);
  return () => {
    frameSubs.delete(cb);
    if (!frameSubs.size && frameId && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(frameId);
      frameId = 0;
    }
  };
}
