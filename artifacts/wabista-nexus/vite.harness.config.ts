// Vite config for the V2-04 render harness (test/harness). Not part of the
// product build. Usage: HARNESS_OUT=<dir> pnpm exec vite build --config vite.harness.config.ts
import path from "path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [react(), tailwindcss({ optimize: false })],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") }, dedupe: ["react", "react-dom"] },
  root: path.resolve(import.meta.dirname, "test/harness"),
  build: { outDir: process.env.HARNESS_OUT ?? path.resolve(import.meta.dirname, "test/harness/dist"), emptyOutDir: true },
  logLevel: "warn",
});
