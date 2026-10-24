import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

const BRAND_COLOR = "#0f766e"; // --color-primary (teal-700), the header colour

export default defineConfig({
  server: {
    // Used when VITE_API_BASE_URL is empty (npm run dev:lan): the app calls
    // /api on its own origin, so a phone on the LAN reaches the sync server
    // through Vite instead of its own "localhost".
    proxy: { "/api": "http://localhost:8080" },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "autoUpdate",
      // Registered explicitly in src/main.tsx via virtual:pwa-register.
      injectRegister: false,
      // Icons are already matched by globPatterns below.
      includeManifestIcons: false,
      manifest: {
        id: "/",
        name: "תקציב — ניהול תקציב חכם",
        short_name: "תקציב",
        description: "אפליקציה לניהול תקציב, מעקב הוצאות וסנכרון חשבונות בנק",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        dir: "rtl",
        lang: "he",
        background_color: BRAND_COLOR,
        theme_color: BRAND_COLOR,
        categories: ["finance", "productivity"],
        icons: [
          { src: "pwa-64x64.png", sizes: "64x64", type: "image/png" },
          { src: "pwa-192x192.png", sizes: "192x192", type: "image/png" },
          { src: "pwa-512x512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "pwa-512x512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "favicon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        // Precache the app shell only. Firestore, Firebase Auth and the sync
        // server's API are network-only: they're never matched below, and
        // POSTs are never cached by the service worker anyway.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff,woff2}"],
        navigateFallback: "index.html",
        // Same-origin paths that must reach the network, not the SPA shell:
        // the sync API, its health check, and Firebase's reserved /__/ paths
        // (auth handler, hosting init) if the app is served from Firebase Hosting.
        navigateFallbackDenylist: [/^\/api\//, /^\/healthz/, /^\/__\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === "https://fonts.googleapis.com",
            handler: "StaleWhileRevalidate",
            options: { cacheName: "google-fonts-stylesheets" },
          },
          {
            urlPattern: ({ url }) => url.origin === "https://fonts.gstatic.com",
            handler: "CacheFirst",
            options: {
              cacheName: "google-fonts-webfonts",
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
});
