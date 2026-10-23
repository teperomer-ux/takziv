import express from "express";
import cors from "cors";
import { sendError } from "./errors.js";
import { scrapeRouter } from "./scrapeRoute.js";
import { SCRAPE_TIMEOUT_MS } from "./scrapeRunner.js";
const PORT = Number(process.env.PORT ?? 8080);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://localhost:5174")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: allowedOrigins, methods: ["POST"], allowedHeaders: ["Authorization", "Content-Type"] }));
app.use(express.json({ limit: "10kb" }));
app.get(["/health", "/healthz"], (_req, res) => {
    res.send("ok");
});
app.use(scrapeRouter);
// Body-parser errors carry the raw body on `err.body`; never log or echo it.
app.use((err, _req, res, _next) => {
    const type = err?.type;
    if (type === "entity.parse.failed" || type === "entity.too.large") {
        return sendError(res, "INVALID_REQUEST");
    }
    console.error(JSON.stringify({ event: "unhandled_error", name: err?.name }));
    sendError(res, "INTERNAL_ERROR");
});
const server = app.listen(PORT, () => {
    console.info(`takziv-server listening on :${PORT}`);
});
// Must exceed the scrape timeout so the connection outlives the scrape.
server.requestTimeout = SCRAPE_TIMEOUT_MS + 60_000;
