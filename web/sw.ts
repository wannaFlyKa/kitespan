// R130: the service worker's entry, built to /sw.js as one classic script (server/http/worker.ts): the two handlers of
// web/sw-worker.ts on the worker's own scope, and nothing else.

import { installWorker, type WorkerScope } from "./sw-worker";

installWorker(self as unknown as WorkerScope);
