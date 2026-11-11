// The words of Settings > Notifications (owner rows 128 and 130; DESIGN-R130 sections 4.5 and 8). Desktop names its
// control "Notifications"; the rest is kitespan's own, in Claude Code's form. One line per state, and the titles line,
// which keeps the user safe (6.8 allows a clause that keeps the user safe on the row). The unsupported line names
// Safari: the phone's company browser, where that line shows most, has no Add to Home Screen (DESIGN 7.9).
export const NOTIFY_WORDS = {
  section: "Notifications",
  thisDevice: "Notifications on this device",
  titles: "Show chat titles",
  titlesLine: "Encrypted end to end, so the push service cannot read them, but the lock screen shows them.",
  devices: "Devices",
  you: "This device",
  turnOff: "Turn off",
  failing: "The last notification did not go through.",
  insecure: "Notifications need kitespan on HTTPS, or at 127.0.0.1 or localhost.",
  unsupported: "This browser cannot get notifications. On an iPhone or iPad, add kitespan to the Home Screen from Safari and turn them on there.",
  denied: "Notifications from kitespan are blocked here. Allow them in this browser's or this device's settings.",
  unreached: "This browser could not reach its push service. Try again later.",
  offList: "kitespan does not send to this browser's push service.",
  /** A link's Save on the first row: the user's own tap, which asks the browser (the risky Save's form, 6.8). */
  turnOn: "Turn on notifications",
  turnOffAll: "Turn off notifications",
  rename: (name: string) => `Rename ${name}`,
  turnOffName: (name: string) => `Turn off ${name}`,
  /** /settings/notifications/device/<device> for a device the list does not have. */
  deviceGone: "That device does not get notifications any more.",
} as const;
