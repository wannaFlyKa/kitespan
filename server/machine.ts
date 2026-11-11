// The machine's own name (D54): the page names the machine by it ("New environment", the Environment card), never by
// the browser's address, which may be the name of a forward or a proxy. Read from the system at run time; never stored.

import { hostname } from "node:os";
import { CONTROL_CHARS } from "../shared/protocol";

/** A DNS label's limit. */
export const MACHINE_NAME_MAX = 63;

/**
 * The hostname's first label (an IPv4 address stays whole), at most 63 characters; null when the name is empty or
 * holds a control character.
 */
export function machineName(raw: string = hostname()): string | null {
  if (typeof raw !== "string" || CONTROL_CHARS.test(raw)) return null;
  const name = raw.trim();
  const label = /^\d{1,3}(\.\d{1,3}){3}$/.test(name) ? name : (name.split(".")[0] ?? "");
  return label ? [...label].slice(0, MACHINE_NAME_MAX).join("") : null;
}
