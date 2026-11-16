import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { sendError } from "./errors.js";
import { scrapeRouter } from "./scrapeRoute.js";
import { connectionsRouter } from "./connectionsRoute.js";
import { aiRouter } from "./aiRoute.js";
import { browserSlotStats } from "./syncSupport.js";

const PORT = Number(process.env.PORT ?? 8080);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: allowedOrigins, methods: ["GET", "POST", "PATCH", "DELETE"], allowedHeaders: ["Authorization", "Content-Type"] }));
// The assistant receives the recent conversation, so it gets a larger body limit.
app.use("/api/ai", express.json({ limit: "100kb" }));
app.use(express.json({ limit: "10kb" }));

app.get("/healthz", (_req, res) => {
  res.send("ok");
});
app.use(scrapeRouter);
app.use(connectionsRouter);
app.use(aiRouter);

// Body-parser errors carry the raw body on `err.body`; never log or echo it.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const type = (err as { type?: string })?.type;
  if (type === "entity.parse.failed" || type === "entity.too.large") {
    return sendError(res, "INVALID_REQUEST");
  }
  console.error(JSON.stringify({ event: "unhandled_error", name: (err as Error)?.name }));
  sendError(res, "INTERNAL_ERROR");
});

const server = app.listen(PORT, () => {
  console.info(`takziv-server listening on :${PORT}`);
});
// Must exceed the queue wait (QUEUE_WAIT_MS, 60s) plus the 180s scrape
// timeout (SCRAPE_TIMEOUT_MS) so the connection outlives a queued scrape.
// Cloud Run's own --timeout (deploy-api.sh) is 300s.
server.requestTimeout = 290_000;

// Cloud Run sends SIGTERM before stopping an instance (scale-in, new
// revision) and allows ~10s: stop taking requests and let short ones finish.
// Chromium children are killed with the process group by dumb-init.
process.once("SIGTERM", () => {
  console.info(JSON.stringify({ event: "shutdown", ...browserSlotStats() }));
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8_000).unref();
});
