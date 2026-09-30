import "./src/env";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleChat } from "./src/chat";
import { llmSummary } from "./src/llm";
import { downloadSong } from "./src/music_responce";
import { ChatRequestBody } from "./src/types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 8787;
const CLIENT_ROOT = path.resolve(__dirname, "../client");
const DOWNLOADS_ROOT = path.resolve(process.cwd(), "downloads");
const MAX_BODY_BYTES = 8 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".obj": "text/plain; charset=utf-8",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
};

function send(res: http.ServerResponse, status: number, body: string | Buffer, contentType: string) {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-cache" });
  res.end(body);
}

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  send(res, status, JSON.stringify(data), "application/json; charset=utf-8");
}

/** Serves static files from client/ directory */
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

/** Serves downloaded MP3 files from downloads/ directory */
function serveDownloads(urlPath: string, res: http.ServerResponse) {
  const relative = decodeURIComponent(urlPath.replace(/^\/downloads/, ""));
  const resolved = path.resolve(DOWNLOADS_ROOT, "." + relative);

  if (!resolved.startsWith(DOWNLOADS_ROOT)) {
    return send(res, 403, "Forbidden", "text/plain");
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      return send(res, 404, "Audio file not found", "text/plain");
    }
    const ext = path.extname(resolved).toLowerCase();
    send(res, 200, data, MIME[ext] || "audio/mpeg");
  });
}

function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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

  // Health check
  if (req.method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, llm: llmSummary() });
  }

  // Chat endpoint
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

  // Music download endpoint
  if (req.method === "POST" && url.pathname === "/api/music_responce") {
    try {
      const body = await readJsonBody<{ songName: string }>(req);

      if (!body.songName || typeof body.songName !== "string") {
        return sendJson(res, 400, { error: "Missing or invalid 'songName' field." });
      }

      const musicResult = await downloadSong(body.songName);
      return sendJson(res, 200, { ok: true, data: musicResult });
    } catch (err: any) {
      console.error("[api/music] error:", err?.message || err);
      return sendJson(res, 500, { error: err?.message || "Failed to process song request" });
    }
  }

  // Serve MP3 downloads
  if ((req.method === "GET" || req.method === "HEAD") && url.pathname.startsWith("/downloads/")) {
    return serveDownloads(url.pathname, res);
  }

  // Serve Client UI
  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(url.pathname, res);
  }

  send(res, 405, "Method not allowed", "text/plain");
});

server.listen(PORT, () => {
  console.log(`Vision Auto-Simulation server listening on http://localhost:${PORT}`);
});
