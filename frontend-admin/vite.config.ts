import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  base: "/admin/ui/",
  server: {
    host: true,
    port: 5174,
    proxy: {
      "/admin/api": {
        target: process.env.VITE_ADMIN_API_PROXY_TARGET || "http://localhost:8000",
        changeOrigin: true
      }
    }
  },
});
