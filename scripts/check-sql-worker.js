// Runs one file's worth of pg-query-emscripten parsing in an isolated worker
// thread so the main process (scripts/check-sql.js) can bound how long it
// waits and forcibly reclaim everything — including a WASM instance that
// never returns — by terminating this thread. See check-sql.js for why that
// termination path exists.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const mod = require('pg-query-emscripten');

(async () => {
  try {
    const pg = await mod.default();
    const parsed = pg.parse(workerData.sql);
    // Reported eagerly, before the (slower, riskier) plpgsql pass below, so
    // the parent still knows the base SQL parsed even if this worker is
    // killed for taking too long on the next step.
    parentPort.postMessage({ type: 'parsed', parsed });

    if (parsed.error) {
      parentPort.postMessage({ type: 'done', parsed, plpgsql: null });
      return;
    }

    // A fresh second instance for parsePlpgsql — reusing one instance for
    // both calls corrupts parser state (commit 734f37f). Still true here;
    // this file just also isolates both calls from the parent process.
    const pg2 = await mod.default();
    const plpgsql = pg2.parsePlpgsql(workerData.sql);
    parentPort.postMessage({ type: 'done', parsed, plpgsql });
  } catch (err) {
    parentPort.postMessage({ type: 'crash', message: err && err.message });
  }
})();
