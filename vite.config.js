import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.VITE_BASE_PATH || "/",
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/myeonn.js',
        chunkFileNames: 'assets/chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  }
});
