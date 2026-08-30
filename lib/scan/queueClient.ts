/**
 * The one queue this handset has, built lazily and exactly once.
 *
 * Separate from offlineQueue.ts on purpose: that file is pure and has no idea
 * what Supabase is, which is what lets the drain loop be tested in Node against
 * an in-memory store and a fake transport. This file is the wiring, and it is
 * the only part that must never run on the server.
 */

"use client";

import { createClient } from "@/lib/supabase/client";
import { createHttpTransport } from "./uploadQueue";
import {
  createIndexedDbQueueStore,
  createMemoryQueueStore,
  supportsIndexedDb,
} from "./queueStore";
import { createScanQueue, type ScanQueueController } from "./offlineQueue";

let queue: ScanQueueController | null = null;

export function getScanQueue(): ScanQueueController {
  // A "use client" module still EXECUTES during server rendering, and a
  // module-level singleton on the server is one shared by every request the
  // Node process handles. Nothing would actually write to it — the drain only
  // ever starts from an effect, and useSyncExternalStore reads
  // getServerSnapshot on the server — but a process-wide queue of photographed
  // documents in a multi-tenant accounting app is not a thing to leave lying
  // around on the strength of "nothing writes to it today". On the server every
  // call gets its own inert instance instead, and nothing is remembered.
  if (typeof window === "undefined") {
    return createScanQueue({
      store: createMemoryQueueStore(),
      transport: () => {
        throw new Error("The scan queue never sends from the server.");
      },
    });
  }
  if (!queue) {
    queue = createScanQueue({
      // A private window or a locked-down WebView has no IndexedDB. Falling
      // back to memory keeps the whole feature working for the life of the tab
      // rather than turning the shutter into an error — and the UI still says
      // truthfully that nothing has been sent yet.
      store: supportsIndexedDb() ? createIndexedDbQueueStore() : createMemoryQueueStore(),
      transport: () => createHttpTransport(createClient()),
    });
  }
  return queue;
}
