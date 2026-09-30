import YouTube from "youtube-sr";
import youtubedl from "youtube-dl-exec";
import path from "path";
import fs from "fs";
import ffmpegPath from "ffmpeg-static";

const ffmpegDir = path.dirname(ffmpegPath as string);

// Path to custom yt-dlp binary if manually downloaded
const YT_DLP_PATH = process.env.YT_DLP_PATH || "C:\\yt-dlp\\yt-dlp.exe";

export interface DownloadResult {
  title: string;
  youtubeUrl: string;
  fileName: string;
  fileUrl: string;
  filePath: string;
}

export async function downloadSong(songName: string): Promise<DownloadResult> {
  console.log(`\n🔍 Searching for: "${songName}"...`);

  const results = await YouTube.search(songName, { limit: 5, type: "video" });

  if (!results.length) {
    throw new Error("No YouTube results found for that search query.");
  }

  const video = results[0];
  console.log(`✅ Selected: ${video.title}`);

  const downloadDir = path.join(process.cwd(), "downloads");
  if (!fs.existsSync(downloadDir)) {
    fs.mkdirSync(downloadDir, { recursive: true });
  }

  // Clean filename (remove invalid characters)
  const safeTitle = video.title
    .replace(/[<>:"/\\|?*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .substring(0, 80);

  const outputFile = path.join(downloadDir, `${safeTitle}.mp3`);

  console.log("⬇ Downloading & converting to MP3...");

  const options: any = {
    extractAudio: true,
    audioFormat: "mp3",
    audioQuality: 0, // Best quality
    output: outputFile,
    noCheckCertificates: true,
    noWarnings: true,
    preferFreeFormats: true,
    ffmpegLocation: ffmpegDir,
    addHeader: ["referer:youtube.com", "user-agent:Mozilla/5.0"],
  };

  if (fs.existsSync(YT_DLP_PATH)) {
    options.binaryPath = YT_DLP_PATH;
    console.log("Using custom yt-dlp binary");
  }

  await youtubedl(video.url, options);

  // Verify resulting MP3 file
  let finalPath = outputFile;
  if (!fs.existsSync(outputFile)) {
    const files = fs
      .readdirSync(downloadDir)
      .filter((f) => f.toLowerCase().endsWith(".mp3"))
      .map((f) => ({
        name: f,
        time: fs.statSync(path.join(downloadDir, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.time - a.time);

    if (!files.length) {
      throw new Error("MP3 file was not found after download completion.");
    }
    finalPath = path.join(downloadDir, files[0].name);
  }

  const fileName = path.basename(finalPath);

  return {
    title: video.title,
    youtubeUrl: video.url,
    fileName,
    filePath: finalPath,
    fileUrl: `/downloads/${encodeURIComponent(fileName)}`,
  };
}
