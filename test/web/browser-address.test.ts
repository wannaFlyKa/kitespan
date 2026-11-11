// The address field (PAGE-B1 3.2, DESIGN-B1 2.7.2): typed text to an address (http for loopback and a bare host:port
// or IP address, https otherwise, no search engine), its lines, the shared URL rule's refusals, and the field's
// picture at rest (the host, then the rest).
import { describe, expect, test } from "bun:test";
import { ADDRESS_LINES, addressShown, escapeAddress, typedAddress } from "../../web/browser/address";
import { PREFILL_REFUSED, prefillOf } from "../../web/browser/nav";

const REFUSED = { origins: ["http://127.0.0.1:7948"], loopbackPorts: [7948, 9340] };

describe("typedAddress", () => {
  test("loopback, a bare host:port and an IP address get http", () => {
    expect(typedAddress("localhost:3000", REFUSED)).toEqual({ url: "http://localhost:3000/" });
    expect(typedAddress("localhost", REFUSED)).toEqual({ url: "http://localhost/" });
    expect(typedAddress("app.localhost:5173/x?y=1", REFUSED)).toEqual({ url: "http://app.localhost:5173/x?y=1" });
    expect(typedAddress("127.0.0.1:8080", REFUSED)).toEqual({ url: "http://127.0.0.1:8080/" });
    expect(typedAddress("[::1]:3000", REFUSED)).toEqual({ url: "http://[::1]:3000/" });
    expect(typedAddress("192.168.1.5", REFUSED)).toEqual({ url: "http://192.168.1.5/" });
    expect(typedAddress("devbox:8000/path", REFUSED)).toEqual({ url: "http://devbox:8000/path" });
  });
  test("a name with a dot gets https", () => {
    expect(typedAddress("example.com", REFUSED)).toEqual({ url: "https://example.com/" });
    expect(typedAddress("  docs.example.org/api/http  ", REFUSED)).toEqual({ url: "https://docs.example.org/api/http" });
  });
  test("an http or https address stays as typed (the parser's spelling)", () => {
    expect(typedAddress("HTTP://Example.COM/A", REFUSED)).toEqual({ url: "http://example.com/A" });
    expect(typedAddress("https://u@example.com/", REFUSED)).toEqual({ url: "https://u@example.com/" });
    expect(typedAddress("about:blank", REFUSED)).toEqual({ url: "about:blank" });
  });
  test("no search engine: text that is no address gets its line", () => {
    expect(typedAddress("how to book a walk", REFUSED)).toEqual({ problem: ADDRESS_LINES.notAddress });
    expect(typedAddress("example", REFUSED)).toEqual({ problem: ADDRESS_LINES.notAddress });
    expect(ADDRESS_LINES.notAddress).toBe("Type a web address, such as localhost:3000 or example.com.");
  });
  test("another scheme gets its line", () => {
    for (const t of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "chrome://settings", "ftp://example.com/"]) expect(typedAddress(t, REFUSED)).toEqual({ problem: ADDRESS_LINES.scheme });
    expect(ADDRESS_LINES.scheme).toBe("Only http and https addresses open here.");
  });
  test("kitespan's own page and the debugging port are refused (the shared rule)", () => {
    expect(typedAddress("127.0.0.1:7948", REFUSED)).toEqual({ problem: ADDRESS_LINES.refused });
    expect(typedAddress("http://localhost:9340/json", REFUSED)).toEqual({ problem: ADDRESS_LINES.refused });
    expect(ADDRESS_LINES.refused).toBe("That address cannot open in the browser pane.");
  });
  test("empty text is nothing to open", () => {
    expect(typedAddress("   ", REFUSED)).toBeNull();
  });
});

describe("addressShown", () => {
  test("http and https: the host, then the rest, with no scheme", () => {
    expect(addressShown("http://localhost:3000/book")).toEqual({ host: "localhost:3000", rest: "/book" });
    expect(addressShown("https://docs.example.org/api/http?q=1#a")).toEqual({ host: "docs.example.org", rest: "/api/http?q=1#a" });
    expect(addressShown("https://example.com/")).toEqual({ host: "example.com", rest: "" });
  });
  test("a blank tab shows nothing; any other address shows whole", () => {
    expect(addressShown("about:blank")).toEqual({ host: "", rest: "" });
    expect(addressShown("")).toEqual({ host: "", rest: "" });
    expect(addressShown("data:text/html,hello")).toEqual({ host: "", rest: "data:text/html,hello" });
  });
});

describe("Esc in the address field (PAGE-B1 17)", () => {
  test("puts the tab's address back while the field holds other text; a blank tab's address is the empty field", () => {
    expect(escapeAddress("abc", "about:blank")).toBe("");
    expect(escapeAddress("abc", "http://localhost:3000/book")).toBe("http://localhost:3000/book");
    expect(escapeAddress("abc", null)).toBe("");
  });
  test("is nothing of the field's while it already shows the tab's address (over the chat, the layer's Esc then closes it)", () => {
    expect(escapeAddress("", "about:blank")).toBeNull();
    expect(escapeAddress("http://localhost:3000/book", "http://localhost:3000/book")).toBeNull();
    expect(escapeAddress("", null)).toBeNull();
  });
});

describe("a route's url pre-fill (PAGE-B1 2.1, DESIGN-B1 4.1)", () => {
  test("an http or https address fills a new tab's field", () => {
    expect(prefillOf("http://127.0.0.1:37459/plain?t=linked")).toEqual({ url: "http://127.0.0.1:37459/plain?t=linked" });
    expect(prefillOf("https://example.com/a")).toEqual({ url: "https://example.com/a" });
  });
  test("any other scheme, or no address, fills nothing and gets 5.4's line", () => {
    for (const raw of ["javascript:alert(1)", "ftp://example.com/", "file:///etc/passwd", "data:text/html,hi", "about:blank", "example.com", "http://", "http://a b/"]) expect([raw, prefillOf(raw)]).toEqual([raw, { refused: true }]);
    expect(PREFILL_REFUSED).toBe("That address cannot open here.");
  });
  test("no pre-fill is nothing", () => {
    expect(prefillOf(null)).toBeNull();
  });
});
