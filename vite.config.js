import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/nhl-api": {
        target: "https://api-web.nhle.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/nhl-api/, ""),
      },
      "/api": {
        target: "http://127.0.0.1:4242",
        changeOrigin: true,
      },
    },
  },
});
