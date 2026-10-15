import { defineConfig, loadEnv } from "vite";
import path from "node:path";

export default defineConfig(({ mode }) => ({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { env: loadEnv(mode, process.cwd(), ""), include: ["tests/**/*.test.ts"], testTimeout: 30000, hookTimeout: 30000, fileParallelism: false },
}));
