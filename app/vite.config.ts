import react from "@vitejs/plugin-react";
import process from "node:process";
import { defineConfig } from "vitest/config";

const host = process.env.TAURI_DEV_HOST;
// scripts/dev-app picks a free port and passes it here; 1440 otherwise, clear
// of Uta's 1420. Keep it in step with devUrl in src-tauri/tauri.conf.json.
const port = Number(process.env.DEADWAX_DEV_PORT ?? 1440);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],

  // Vite options tailored for Tauri, applied in `tauri dev` and `tauri build`:
  // 1. don't hide Rust errors
  clearScreen: false,
  // 2. Tauri expects a fixed port, so fail if it's taken
  server: {
    port,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: port + 1,
        }
      : undefined,
    watch: {
      // 3. don't watch the Rust side
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
  },
});
