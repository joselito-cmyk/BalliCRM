import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // Dummy secrets — encryption.ts / webhook-signature.ts read these
    // at module load. Tests never hit a real Meta/Supabase service, so
    // any 32-byte hex / non-empty string will do; keep them lexically
    // identical to the CI build env so behaviour matches.
    //
    // TZ pins Date/Intl.DateTimeFormat's timezone resolution so tests
    // are deterministic regardless of the machine running them. Without
    // it, `new Date("YYYY-MM-DD")` (parsed as UTC midnight per spec)
    // read back through a local-timezone getter like `getDay()` shifts
    // by a calendar day on any machine west of UTC — verified this is
    // what broke date-utils.test.ts's mondayIndex tests on a
    // UTC-3 (America/Sao_Paulo) machine. UTC has zero offset, so
    // UTC-parsed input and local-timezone reads always agree.
    env: {
      ENCRYPTION_KEY:
        "0000000000000000000000000000000000000000000000000000000000000000",
      META_APP_SECRET: "test-meta-app-secret",
      UAZAPI_ENDPOINT: "https://uazapi.test",
      UAZAPI_TOKEN: "test-uazapi-token",
      TZ: "UTC",
    },
    clearMocks: true,
  },
});
