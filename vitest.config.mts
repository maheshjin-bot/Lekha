import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Asia/Kolkata is the only timezone this product is used in, and several of the
// date bugs it must not have are only reachable from a UTC+05:30 clock (a date
// built from local getters and formatted with UTC getters disagrees for the
// first 5.5 hours of every day). Running the suite in UTC would hide them.
// Set before the worker pool forks so children inherit it.
process.env.TZ = "Asia/Kolkata";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: { TZ: "Asia/Kolkata" },
  },
  resolve: {
    alias: {
      // Mirrors the `@/*` -> `./*` mapping in tsconfig.json.
      "@": fileURLToPath(new URL("./", import.meta.url)),
    },
  },
});
