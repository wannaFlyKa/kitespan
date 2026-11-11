// The allow-list of the shared browser's debugging connection (DESIGN-B1 2.7, 2.7.1, 2.7.2). The pane never names a
// method: the relay maps each of its frames to fixed calls. This file is the last check on every call the server
// sends, whatever path asked for it: a method outside the two lists, or an argument that 2.7.2 forbids, throws before a
// byte goes to Chrome. Runtime.callFunctionOn carries only the fixed scripts of scripts.ts.

import { FIXED_SCRIPT_TEXTS } from "./scripts";

/** The calls that a pane frame maps to (DESIGN-B1 2.7's table). */
export const FRAME_METHODS: ReadonlySet<string> = new Set([
  "Target.createTarget",
  "Target.closeTarget",
  "Target.activateTarget",
  "Target.attachToTarget",
  "Target.detachFromTarget",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.clearDeviceMetricsOverride",
  "Emulation.setTouchEmulationEnabled",
  "Page.navigate",
  "Page.getNavigationHistory",
  "Page.navigateToHistoryEntry",
  "Page.reload",
  "Page.stopLoading",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Page.screencastFrameAck",
  "Page.handleJavaScriptDialog",
  "Input.dispatchMouseEvent",
  "Input.dispatchTouchEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
  "Runtime.callFunctionOn",
  "Runtime.releaseObject",
  "DOM.setFileInputFiles",
  "Browser.cancelDownload",
]);

/** The calls the server makes for itself, never because a frame named them (DESIGN-B1 2.7.1). */
export const SERVER_METHODS: ReadonlySet<string> = new Set([
  "Target.setDiscoverTargets",
  "Target.setAutoAttach",
  "Target.getTargets",
  "Browser.getVersion",
  "Browser.getWindowForTarget",
  "Browser.setWindowBounds",
  "Browser.setDownloadBehavior",
  "Browser.close",
  "SystemInfo.getProcessInfo",
  "Page.enable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.createIsolatedWorld",
  "Page.setInterceptFileChooserDialog",
  "Fetch.enable",
  "Fetch.failRequest",
  "Fetch.continueRequest",
  "Runtime.runIfWaitingForDebugger",
  "DOM.resolveNode",
]);

export const CDP_METHODS: ReadonlySet<string> = new Set([...FRAME_METHODS, ...SERVER_METHODS]);

/**
 * Never, from any path (DESIGN-B1 2.7.2). The domains in NEVER_DOMAINS are refused whole; these are named so the tests
 * show each one refused.
 */
export const NEVER_METHODS: readonly string[] = [
  "Runtime.evaluate",
  "Runtime.compileScript",
  "Runtime.runScript",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.setBypassCSP",
  "Page.captureScreenshot",
  "Page.printToPDF",
  "Page.startScreenRecording",
  "Target.exposeDevToolsProtocol",
  "Target.createBrowserContext",
  "Target.attachToBrowserTarget",
  "Browser.grantPermissions",
  "Browser.setPermission",
  "Browser.crash",
  "Network.getCookies",
  "Network.getAllCookies",
  "Network.setCookie",
  "Network.setExtraHTTPHeaders",
  "Storage.getCookies",
  "Security.setIgnoreCertificateErrors",
  "DOM.getDocument",
  "DOM.querySelector",
  "DOM.getOuterHTML",
  "DOM.setAttributeValue",
  "Input.dispatchDragEvent",
  "Emulation.setUserAgentOverride",
  "IO.read",
  "Tracing.start",
  "Debugger.enable",
  "HeapProfiler.takeHeapSnapshot",
  "Profiler.start",
];

export class CallRefused extends Error {
  override readonly name = "CallRefused";
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Throws CallRefused for a call that the allow-list does not hold, or for one whose arguments 2.7.2 forbids: a script
 * that is not one of the fixed texts, a reload with a script, a key with editor commands, an attach that is not flat,
 * a navigation or a new tab to any scheme but http, https or about:blank.
 */
export function guardCall(method: string, params: Record<string, unknown>): void {
  if (!CDP_METHODS.has(method)) throw new CallRefused(`${method}: not on the allow-list`);
  if (!isObj(params)) throw new CallRefused(`${method}: no parameters object`);
  switch (method) {
    case "Runtime.callFunctionOn":
      if (typeof params.functionDeclaration !== "string" || !FIXED_SCRIPT_TEXTS.has(params.functionDeclaration)) throw new CallRefused("Runtime.callFunctionOn: not a fixed script");
      if ("expression" in params) throw new CallRefused("Runtime.callFunctionOn: an expression");
      break;
    case "Page.reload":
      if ("scriptToEvaluateOnLoad" in params) throw new CallRefused("Page.reload: a script on load");
      break;
    case "Input.dispatchKeyEvent":
      if ("commands" in params) throw new CallRefused("Input.dispatchKeyEvent: editor commands");
      break;
    case "Target.attachToTarget":
    case "Target.setAutoAttach":
      if (params.flatten !== true) throw new CallRefused(`${method}: not a flat session`);
      break;
    case "Target.createTarget":
    case "Page.navigate": {
      const url = params.url;
      if (typeof url !== "string" || !(url === "about:blank" || /^https?:\/\//i.test(url))) throw new CallRefused(`${method}: not an http, https or about:blank address`);
      if (method === "Target.createTarget" && ("browserContextId" in params || "forTab" in params)) throw new CallRefused("Target.createTarget: another context");
      break;
    }
    case "DOM.resolveNode":
      if (typeof params.backendNodeId !== "number" || typeof params.executionContextId !== "number" || "nodeId" in params || !("objectGroup" in params)) {
        throw new CallRefused("DOM.resolveNode: only a chooser's node, in kitespan's world");
      }
      break;
    case "DOM.setFileInputFiles":
      if (!Array.isArray(params.files) || typeof params.backendNodeId !== "number" || "nodeId" in params || "objectId" in params) throw new CallRefused("DOM.setFileInputFiles: only a chooser's node");
      break;
    case "Browser.setDownloadBehavior":
      if (params.behavior !== "allowAndName" || params.eventsEnabled !== true) throw new CallRefused("Browser.setDownloadBehavior: only kitespan's own folder");
      break;
    case "Page.createIsolatedWorld":
      if (params.grantUniveralAccess === true || "grantUniversalAccess" in params) throw new CallRefused("Page.createIsolatedWorld: universal access");
      break;
  }
}
