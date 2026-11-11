// A preload for test/web/mac-keys.test.ts: the page's platform check (navigator.platform, web/ui/shortcuts.ts IS_MAC)
// reads macOS's value, so the tests that it runs see the page's Mac words and keys on any system.
Object.defineProperty(globalThis.navigator, "platform", { value: "MacIntel", configurable: true });
