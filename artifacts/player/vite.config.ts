import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const port = Number(process.env.PORT ?? "5173");
// Default `./` so bundled assets work in Capacitor (WKWebView). Absolute `/assets/...`
// resolves to the wrong origin path and yields a blank white screen. Override with
// BASE_PATH=/ or BASE_PATH=/subdir/ for static web hosting if needed.
const basePath = process.env.BASE_PATH ?? "./";

const defaultApiOrigin = "http://134.199.172.228:3001";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(import.meta.dirname), "");
  const apiOrigin = (env.VITE_SPEED_API_ORIGIN || defaultApiOrigin).replace(/\/+$/, "");
  const proxyTarget = env.VITE_API_URL || apiOrigin;

  return {
    base: basePath,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "src"),
      },
      dedupe: ["react", "react-dom"],
    },
    root: path.resolve(import.meta.dirname),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist"),
      emptyOutDir: true,
    },
    server: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
      proxy: {
        "/api": {
          target: proxyTarget,
          secure: proxyTarget.startsWith("https://"),
          changeOrigin: true,
        },
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
      allowedHosts: true,
    },
  };
});
