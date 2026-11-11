// The home folder by both its names: os.homedir(), and its real path when that differs (a /home link to another
// disk, for example). R127: a folder that kitespan asks Claude Code to trust is never one of them, nor one that holds
// one; the registry's check and the trust start's own check both read it here.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";

export function homeFolders(): string[] {
  const home = homedir();
  try {
    const real = realpathSync(home);
    return real === home ? [home] : [home, real];
  } catch {
    return [home];
  }
}
