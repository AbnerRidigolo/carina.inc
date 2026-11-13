import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Em desenvolvimento o Vite faz o papel do nginx da imagem: `/api` (REST) e `/ws` (WebSocket do
// chat) vão para a API. Mesma origem no browser: sem CORS e sem a chave em URL.
const API_TARGET = process.env["VITE_API_TARGET"] ?? "http://localhost:3000";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: API_TARGET },
      "/ws": { target: API_TARGET, ws: true },
    },
  },
  build: { sourcemap: false },
});
