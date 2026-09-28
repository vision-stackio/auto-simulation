import "./src/env";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { handleChat } from "./src/chat";
import { PersonScraper } from "./src/chat";
import { llmSummary, summarizePersonInfo } from "./src/llm";
import { ChatRequestBody, IdentifyRequestBody, IdentifyResponseBody } from "./src/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 8787;
const CLIENT_ROOT = path.resolve(__dirname, "../client");
const MAX_BODY_BYTES = 8 * 1024; // a spoken/typed message is short; refuse anything absurd
const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 6 MB — enough for any reasonable photo in base64

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".obj": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
};

function send(res: http.ServerResponse, status: number, body: string | Buffer, contentType: string) {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-cache" });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}

/** Serves a file from client/, refusing anything that resolves outside it. */
function serveStatic(urlPath: string, res: http.ServerResponse) {
  const relative = urlPath === "/" ? "/index.html" : decodeURIComponent(urlPath);
  const resolved = path.resolve(CLIENT_ROOT, "." + relative);

  if (!resolved.startsWith(CLIENT_ROOT)) {
    return send(res, 403, "Forbidden", "text/plain");
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      return send(res, 404, "Not found", "text/plain");
    }
    const ext = path.extname(resolved).toLowerCase();
    send(res, 200, data, MIME[ext] || "application/octet-stream");
  });
}

function readJsonBody<T>(req: http.IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<T> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : ({} as T));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, llm: llmSummary() });
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    try {
      const body = await readJsonBody<ChatRequestBody>(req);
      const result = await handleChat(body.message, body.history);
      return sendJson(res, 200, result);
    } catch (err: any) {
      console.error("[api/chat] bad request:", err?.message || err);
      return sendJson(res, 400, { error: err?.message || "Bad request" });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/identify") {
    let tmpPath: string | null = null;
    try {
      const body = await readJsonBody<IdentifyRequestBody>(req, MAX_IMAGE_BYTES);
      if (!body.imageBase64 || typeof body.imageBase64 !== "string") {
        return sendJson(res, 400, { error: "Missing imageBase64 field" });
      }

      // Determine extension from mime type, defaulting to .jpg
      const ext = (body.mimeType || "image/jpeg").split("/")[1]?.replace("jpeg", "jpg") || "jpg";
      tmpPath = path.join(os.tmpdir(), `vision-identify-${Date.now()}.${ext}`);
      await fs.promises.writeFile(tmpPath, Buffer.from(body.imageBase64, "base64"));

      const scraper = new PersonScraper();
      const result = await scraper.scrape(tmpPath);

      let summary: string | undefined;
      if (result.success && result.name && result.info && result.info.length > 0) {
        console.log(`[api/identify] Generating summary for: ${result.name}`);
        summary = await summarizePersonInfo(result.name, result.info);
        console.log(`[api/identify] Generated summary: "${summary}"`);
      }

      const response: IdentifyResponseBody = result.success
        ? { name: result.name, info: result.info, summary, source: "scraper" }
        : { error: result.error || "Could not identify person", source: "scraper" };

      return sendJson(res, 200, response);
    } catch (err: any) {
      console.error("[api/identify] error:", err?.message || err);
      return sendJson(res, 500, { error: err?.message || "Server error", source: "scraper" });
    } finally {
      // Clean up the temp file even if something threw
      if (tmpPath) {
        fs.promises.unlink(tmpPath).catch(() => {});
      }
    }
  }

  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(url.pathname, res);
  }

  send(res, 405, "Method not allowed", "text/plain");
});

server.listen(PORT, () => {
  console.log(`Vision Auto-Simulation server listening on http://localhost:${PORT}`);
  const { provider, model, configured } = llmSummary();
  console.log(configured ? `LLM: ${provider} (${model})` : "LLM: not configured — set LLM_API_KEY in .env to enable real replies");
});
