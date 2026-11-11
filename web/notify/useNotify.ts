// Settings > Notifications' state (DESIGN-R130 4.5): what this browser can do (gate.ts), the server's key and devices
// (GET /api/push, which makes nothing), and this browser's own subscription (read, never made, here). The section
// draws no control until both reads are in. Where this browser cannot get notifications but could be a device (a
// blocked permission, an insecure origin) the server's list is read alone, so the other devices can be turned off. Every change is the user's own press: the switch (device.ts's order, with
// the permission prompt first inside the tap), Show chat titles, a device's name, and Turn off on another device's row.
// After each, the server's list is read again. Nothing is asked at page load or on a navigation.
import { useCallback, useEffect, useRef, useState } from "react";
import { pushApi, type PushApi, type PushRead } from "./api";
import { readThisDevice, realBrowser, turnOffThis, turnOn, type PushBrowser } from "./device";
import { gateOf, listsDevices, readEnv, type NotifyGate } from "./gate";
import { cleanName, defaultName } from "./names";
import type { SizeClass } from "../layout/size";

export interface NotifyModel {
  gate: NotifyGate;
  /** The server's key and devices, with this browser's own device id when the server lists it; null while reading. */
  read: (PushRead & { mine: string | null }) | null;
  /** A change this page made is on its way (the switch shows its new value, busy). */
  busy: "on" | "off" | null;
  /** The first row's line after a turn-on or turn-off that did not go through. */
  line: string | null;
}

export interface NotifyActions {
  /** The switch, or the link's Save: on runs the permission prompt first, so call it inside the tap. */
  setThisDevice(on: boolean): void;
  setTitles(on: boolean): void;
  rename(id: string, name: string): Promise<boolean>;
  /** Turn off another device: the server's remove only (that browser keeps a dead subscription). */
  remove(id: string): void;
}

/**
 * The section's read for a gate: null where it lists no devices (gate.ts listsDevices); else the server's key and
 * devices, with this browser's own device id only where this browser can get notifications (elsewhere its
 * subscription is not read, and every device row has Turn off).
 */
export async function readSection(gate: NotifyGate, api: PushApi, browser: () => PushBrowser): Promise<NotifyModel["read"]> {
  if (!listsDevices(gate)) return null;
  const [server, mine] = await Promise.all([api.read(), gate === "ok" ? readThisDevice(browser()) : Promise.resolve({ id: null })]);
  return { ...server, mine: mine.id && server.devices.some((d) => d.id === mine.id) ? mine.id : null };
}

export function useNotify(size: SizeClass, touch: boolean, deps: { browser?: PushBrowser; api?: PushApi } = {}): { model: NotifyModel; actions: NotifyActions } {
  const [gate, setGateState] = useState<NotifyGate>(() => gateOf(readEnv()));
  // The reads take the gate as it is now (a turn-on that the user blocked changes it).
  const gateNow = useRef(gate);
  const setGate = (g: NotifyGate) => {
    gateNow.current = g;
    setGateState(g);
  };
  const [read, setRead] = useState<NotifyModel["read"]>(null);
  const [busy, setBusy] = useState<NotifyModel["busy"]>(null);
  const [line, setLine] = useState<string | null>(null);
  const live = useRef(true);
  const browser = useRef<PushBrowser | null>(deps.browser ?? null);
  const api = deps.api ?? pushApi;
  const getBrowser = () => (browser.current ??= realBrowser());

  const reread = useCallback(async () => {
    const next = await readSection(gateNow.current, api, getBrowser);
    if (!live.current) return null;
    setRead(next);
    return next;
    // The api and the browser are fixed for the section's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    live.current = true;
    if (listsDevices(gate)) void reread().catch(() => live.current && setRead({ key: null, devices: [], mine: null }));
    return () => {
      live.current = false;
    };
    // Once, as the section opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setThisDevice = (on: boolean) => {
    if (busy || !read || gate !== "ok") return;
    setLine(null);
    if (on) {
      const taken = read.devices.map((d) => d.name);
      // The prompt goes first, inside this tap (turnOn calls it before it awaits anything).
      const going = turnOn({ browser: getBrowser(), api, key: read.key, name: (endpoint) => cleanName(defaultName(endpoint, size, touch, taken)) });
      setBusy("on");
      void going.then(async (r) => {
        if (!live.current) return;
        if (!r.ok) {
          if (r.why === "denied") setGate("denied");
          setLine(r.line);
        }
        await reread().catch(() => {});
        if (live.current) setBusy(null);
      });
      return;
    }
    setBusy("off");
    void turnOffThis({ browser: getBrowser(), api, id: read.mine }).then(async (failed) => {
      if (!live.current) return;
      setLine(failed);
      await reread().catch(() => {});
      if (live.current) setBusy(null);
    });
  };

  const setTitles = (on: boolean) => {
    const mine = read?.mine;
    if (!mine || !read) return;
    // Shown at once; the server's list says it again.
    setRead({ ...read, devices: read.devices.map((d) => (d.id === mine ? { ...d, titles: on } : d)) });
    void api
      .change(mine, { titles: on })
      .catch(() => {})
      .then(() => reread().catch(() => {}));
  };

  const rename = async (id: string, name: string): Promise<boolean> => {
    const clean = cleanName(name);
    if (!clean) return false;
    try {
      await api.change(id, { name: clean });
    } catch {
      return false;
    }
    await reread().catch(() => {});
    return true;
  };

  const remove = (id: string) => {
    void api
      .remove(id)
      .catch(() => {})
      .then(() => reread().catch(() => {}));
  };

  return { model: { gate, read, busy, line }, actions: { setThisDevice, setTitles, rename, remove } };
}
