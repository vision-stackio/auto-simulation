import { YouTube } from "youtube-sr";
import path from "path";
import fs from "fs";
import { spawn, execFileSync } from "child_process";
import https from "https";
import http from "http";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";

export interface DownloadResult {
  title: string;
  youtubeUrl: string;
  fileName: string;
  fileUrl: string;
  filePath: string;
}

const IS_WIN = process.platform === "win32";
const BIN_DIR = path.join(process.cwd(), "bin");

function existsFile(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function whichQuiet(cmd: string): string | null {
  try {
    // Use where/which but swallow stderr (Windows "INFO: Could not find...")
    const out = execFileSync(IS_WIN ? "where" : "which", [cmd], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    return out && existsFile(out) ? out : null;
  } catch {
    return null;
  }
}

function findYtDlp(): string | null {
  if (process.env.YT_DLP_PATH && existsFile(process.env.YT_DLP_PATH)) {
    return process.env.YT_DLP_PATH;
  }
  const local = path.join(BIN_DIR, IS_WIN ? "yt-dlp.exe" : "yt-dlp");
  if (existsFile(local)) return local;

  for (const name of IS_WIN ? ["yt-dlp.exe", "yt-dlp"] : ["yt-dlp"]) {
    const w = whichQuiet(name);
    if (w) return w;
  }

  if (IS_WIN) {
    const guesses = [
      "C:\\yt-dlp\\yt-dlp.exe",
      path.join(process.env.LOCALAPPDATA || "", "yt-dlp", "yt-dlp.exe"),
      path.join(process.env.USERPROFILE || "", "yt-dlp", "yt-dlp.exe"),
    ];
    for (const g of guesses) if (existsFile(g)) return g;
  } else {
    for (const g of ["/usr/local/bin/yt-dlp", "/usr/bin/yt-dlp", path.join(process.env.HOME || "", ".local", "bin", "yt-dlp")]) {
      if (existsFile(g)) return g;
    }
  }
  return null;
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const getter = url.startsWith("https") ? https : http;
    const req = getter.get(url, { headers: { "User-Agent": "vision-auto-sim" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try {
          fs.unlinkSync(dest);
        } catch {
          /* ignore */
        }
        downloadFile(res.headers.location, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`Download failed HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      pipeline(res, file).then(resolve, reject);
    });
    req.on("error", reject);
  });
}

async function ensureYtDlp(): Promise<string> {
  const existing = findYtDlp();
  if (existing) return existing;

  if (!fs.existsSync(BIN_DIR)) fs.mkdirSync(BIN_DIR, { recursive: true });
  const dest = path.join(BIN_DIR, IS_WIN ? "yt-dlp.exe" : "yt-dlp");
  const url = IS_WIN
    ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    : process.platform === "darwin"
      ? "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
      : "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp";

  console.log("⬇ yt-dlp not found — downloading into ./bin ...");
  await downloadFile(url, dest);
  if (!IS_WIN) fs.chmodSync(dest, 0o755);
  if (!existsFile(dest)) throw new Error("yt-dlp download failed");
  console.log(`yt-dlp at ${dest}`);
  return dest;
}

function runCmd(cmd: string, args: string[], cwd?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        reject(new Error(`Cannot run "${cmd}". Set YT_DLP_PATH in .env or install yt-dlp.`));
      } else reject(err);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function safeName(title: string, fallback: string): string {
  return (title || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 80) || "track";
}

export async function downloadSong(songName: string): Promise<DownloadResult> {
  console.log(`\n Searching for: "${songName}"...`);

  const results = await YouTube.search(songName, { limit: 5, type: "video" });
  if (!results.length) throw new Error("No YouTube results found for that search query.");

  const video = results[0];
  const youtubeUrl = video.url || `https://www.youtube.com/watch?v=${(video as any).id}`;
  console.log(`Selected: ${video.title}`);

  const downloadDir = path.join(process.cwd(), "downloads");
  if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });

  const base = safeName(video.title || songName, songName);

  // Cache
  const cached = fs
    .readdirSync(downloadDir)
    .filter((f) => {
      const l = f.toLowerCase();
      return (
        f.startsWith(base) &&
        (l.endsWith(".m4a") || l.endsWith(".webm") || l.endsWith(".mp3") || l.endsWith(".opus") || l.endsWith(".mp4"))
      );
    })
    .map((f) => {
      const p = path.join(downloadDir, f);
      const st = fs.statSync(p);
      return { name: f, size: st.size, time: st.mtime.getTime() };
    })
    .filter((f) => f.size > 20_000)
    .sort((a, b) => b.time - a.time);

  if (cached.length) {
    console.log("♻ Reusing cached audio");
    const fileName = cached[0].name;
    return {
      title: video.title || songName,
      youtubeUrl,
      fileName,
      filePath: path.join(downloadDir, fileName),
      fileUrl: `/downloads/${encodeURIComponent(fileName)}`,
    };
  }

  const ytDlp = await ensureYtDlp();

  // IMPORTANT: no -x / no --audio-format → no ffmpeg needed
  // Download best audio stream as-is (.m4a or .webm)
  const outTemplate = path.join(downloadDir, `${base}.%(ext)s`);

  console.log(`⬇ Downloading best audio (no conversion, no ffmpeg) via yt-dlp...`);

  const args = [
    "-f",
    "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
    "-o",
    outTemplate,
    "--no-playlist",
    "--no-warnings",
    "--no-check-certificates",
    "--geo-bypass",
    "--user-agent",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "--extractor-args",
    "youtube:player_client=android,web",
    "--",
    youtubeUrl,
  ];

  const result = await runCmd(ytDlp, args, downloadDir);
  if (result.code !== 0) {
    console.error("[yt-dlp stderr]", result.stderr.slice(-1000));
    throw new Error(`yt-dlp failed: ${(result.stderr || result.stdout).slice(-400)}`);
  }

  // Find the file we just wrote
  const audioExts = [".m4a", ".webm", ".opus", ".mp3", ".mp4", ".ogg"];
  const files = fs
    .readdirSync(downloadDir)
    .filter((f) => f.startsWith(base) && audioExts.some((e) => f.toLowerCase().endsWith(e)))
    .map((f) => ({
      name: f,
      time: fs.statSync(path.join(downloadDir, f)).mtime.getTime(),
      size: fs.statSync(path.join(downloadDir, f)).size,
    }))
    .filter((f) => f.size > 10_000)
    .sort((a, b) => b.time - a.time);

  if (!files.length) {
    throw new Error("Download finished but no audio file was found in downloads/.");
  }

  const fileName = files[0].name;
  const filePath = path.join(downloadDir, fileName);
  console.log(`Ready: ${fileName} (${Math.round(files[0].size / 1024)} KB)`);

  return {
    title: video.title || songName,
    youtubeUrl,
    fileName,
    filePath,
    fileUrl: `/downloads/${encodeURIComponent(fileName)}`,
  };
}
