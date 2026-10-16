import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { sendError } from "./errors.js";
import { scrapeRouter } from "./scrapeRoute.js";

const PORT = Number(process.env.PORT ?? 8080);
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: allowedOrigins, methods: ["POST"], allowedHeaders: ["Authorization", "Content-Type"] }));
app.use(express.json({ limit: "10kb" }));

app.get("/healthz", (_req, res) => {
  res.send("ok");
});
app.use(scrapeRouter);

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
// Must exceed the 120s scrape timeout so the connection outlives the scrape.
server.requestTimeout = 180_000;
