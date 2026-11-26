import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Tauri expects a fixed dev port and serves the built files from dist/.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    // Rust build output changes constantly and locks files on Windows; never watch it.
    watch: { ignored: ["**/src-tauri/**"] },
  },
  // A desktop app loads from disk, so one ~700 kB bundle (mostly three.js) is fine.
  build: { outDir: "dist", target: "es2020", chunkSizeWarningLimit: 1500 },
});
