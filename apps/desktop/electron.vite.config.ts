import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        external: ["better-sqlite3", /^better-sqlite3\/.+/, "@napi-rs/canvas", /^@napi-rs\/canvas\/.+/],
        input: `${root}/electron/main.ts`,
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: `${root}/electron/preload.ts`,
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    root,
    plugins: [react()],
    build: {
      rollupOptions: {
        input: `${root}/index.html`,
      },
    },
  },
});
