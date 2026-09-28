import { ChatResponseBody, ChatTurn } from "./types";
import { matchDirectCommand, extractCommands } from "./commands";
import { askLlm, summarizePersonInfo } from "./llm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import axios from "axios";
import FormData from "form-data";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../../../information-scrapper/.env") });

export interface ScraperResult {
  success: boolean;
  name?: string;
  info?: string[];
  error?: string;
}

export function cleanPersonName(raw: string): string {
  if (!raw) return "";
  let name = raw.trim();

  // Strip common website suffixes and descriptors
  // e.g. "Elon Musk – Wikipedia", "Elon Musk | Britannica", "Elon Musk - Forbes"
  name = name.replace(/\s*[-–—|•·]\s*(?:Wikipedia|Britannica|Forbes|LinkedIn|IMDb|Twitter|X|Biography|Bio|News|Profile|Instagram|Facebook|YouTube|Official).*$/i, "");

  // Strip trailing " - Site" or " | Site"
  name = name.replace(/\s*[-–—|]\s*[A-Z][a-zA-Z0-9\s.]+$/, "");

  // Strip social handles like (@elonmusk)
  name = name.replace(/\s*\(@[A-Za-z0-9_]+\).*$/, "");

  // Strip trailing descriptors like "photo", "image", "wallpaper", "picture"
  name = name.replace(/\s+(?:photo|image|picture|wallpaper|hd|portrait|look)$/i, "");

  return name.trim() || raw.trim();
}

/**
 * Returns true if the string looks like a real person name
 * (2–4 words, starts with capital, no digits, not a date/event phrase).
 */
function looksLikePersonName(name: string): boolean {
  if (!name || name.length < 4) return false;
  // Reject if it contains digits (e.g. "April 3, 1984", "Soyuz T-11")
  if (/\d/.test(name)) return false;
  // Reject obvious date/event words
  if (/\b(january|february|march|april|may|june|july|august|september|october|november|december|monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|history|events?|day|year|week|month)\b/i.test(name)) return false;
  // Must have at least two capitalised words (First Last)
  const words = name.trim().split(/\s+/);
  if (words.length < 2 || words.length > 5) return false;
  const capitalised = words.filter((w) => /^[A-Z]/.test(w));
  return capitalised.length >= 2;
}

/**
 * Scan the Google Lens visual_matches array and return the best candidate
 * person name — skipping event/date/article titles.
 */
export function extractPersonNameFromMatches(visualMatches: any[]): string | null {
  for (const match of visualMatches.slice(0, 10)) {
    const raw = match.title || match.source || "";
    const cleaned = cleanPersonName(raw);
    if (looksLikePersonName(cleaned)) {
      return cleaned;
    }
  }
  return null;
}

export class PersonScraper {
  private async uploadToImgBB(imagePath: string): Promise<string> {
    const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
    if (!IMGBB_API_KEY) {
      throw new Error('IMGBB_API_KEY is missing in .env file');
    }

    try {
      const formData = new FormData();
      formData.append('image', fs.createReadStream(imagePath));

      const response = await axios.post(`https://api.imgbb.com/1/upload`, formData, {
        params: {
          key: IMGBB_API_KEY,
        },
        headers: {
          ...formData.getHeaders(),
        },
      });

      if (response.data.success) {
        return response.data.data.url;
      } else {
        throw new Error(`ImgBB upload failed: ${JSON.stringify(response.data.error)}`);
      }
    } catch (error: any) {
      if (error.response && error.response.data) {
        throw new Error(`ImgBB API Error: ${JSON.stringify(error.response.data.error)}`);
      }
      throw new Error(`ImgBB upload error: ${error.message}`);
    }
  }

  async scrape(imagePath: string): Promise<ScraperResult> {
    try {
      const SERPAPI_KEY = process.env.SERPAPI_KEY;
      if (!SERPAPI_KEY) {
        throw new Error('SERPAPI_KEY is missing in .env file');
      }

      // 1. Handle Image Hosting
      let imageURL: string;
      if (imagePath.startsWith('http')) {
        imageURL = imagePath;
      } else {
        console.log(`Uploading local image to ImgBB...`);
        imageURL = await this.uploadToImgBB(imagePath);
        console.log(`Image uploaded successfully: ${imageURL}`);
      }

      // 2. Identify the person using Google Lens via SerpApi
      console.log(`Searching Google Lens for identity...`);
      const lensParams = {
        engine: 'google_lens',
        api_key: SERPAPI_KEY,
        url: imageURL,
      };

      const lensResponse = await axios.get('https://serpapi.com/search', { params: lensParams });
      const visualMatches = lensResponse.data.visual_matches;

      if (!visualMatches || visualMatches.length === 0) {
        return { success: false, error: "Can't find the person in the internet" };
      }

      // BUG FIX: Scan up to 10 visual matches for a real person name.
      // The first match is often an article/date title (e.g. "April 3, 1984 – On This Day")
      // rather than the person's name. We skip those and look for a proper "First Last" name.
      const personName = extractPersonNameFromMatches(visualMatches);
      if (!personName) {
        const fallbackRaw = visualMatches[0]?.title || visualMatches[0]?.source || "";
        console.warn(`[scraper] No clean person name found in visual matches. Fallback raw: "${fallbackRaw}"`);
        return { success: false, error: "Could not identify the person from the image" };
      }
      console.log(`Identified as: "${personName}"`);

      // 3. Gather information using the identified name.
      // BUG FIX: Search specifically for the person by name so results don't
      // mix in unrelated people who share a date/event (e.g. Gorbachev appearing
      // when the image was tagged with "April 3, 1984").
      console.log(`Gathering detailed biographical information for "${personName}"...`);
      const firstName = personName.split(/\s+/)[0];
      const searchParams = {
        engine: 'google',
        api_key: SERPAPI_KEY,
        q: `"${personName}" biography career achievements`,
      };

      const searchResponse = await axios.get('https://serpapi.com/search', { params: searchParams });
      const infoPoints: string[] = [];

      // Check for Knowledge Graph description (most reliable source of identity)
      const kg = searchResponse.data.knowledge_graph;
      if (kg) {
        if (kg.description) {
          infoPoints.push(kg.description);
        }
        if (kg.type) {
          infoPoints.push(`${personName} is known as: ${kg.type}.`);
        }
      }

      // BUG FIX: Only include snippets that actually mention the person's name
      // (first name at minimum) so unrelated results (e.g. Gorbachev's bio
      // appearing in a 1984-events search) are filtered out.
      const organicResults = searchResponse.data.organic_results;
      if (Array.isArray(organicResults)) {
        organicResults.slice(0, 8).forEach((result: any) => {
          const snippet: string = result.snippet || "";
          const title: string = result.title || "";
          const combined = `${title} ${snippet}`;
          // Accept snippet only if it mentions the person's first name
          if (
            snippet &&
            !infoPoints.includes(snippet) &&
            combined.toLowerCase().includes(firstName.toLowerCase())
          ) {
            infoPoints.push(snippet);
          }
        });
      }

      if (infoPoints.length === 0) {
        return { success: false, error: "Could not gather information from browser" };
      }

      return {
        success: true,
        name: personName,
        info: infoPoints,
      };

    } catch (error: any) {
      console.error('Error during scraping:', error.message);
      return { success: false, error: error.message };
    }
  }
}

const MAX_MESSAGE_LEN = 500;
const MAX_HISTORY_TURNS = 8;

export function isIdentifyIntent(text: string): boolean {
  if (!text) return false;
  return (
    /\b(identif[ty]+|identifying)\b.*\b(persons?|people|someone|anyone|human|individual|faces?|him|her|them|who|image|photo|picture)\b/i.test(text) ||
    /\b(who\s+is\s+(this|that|he|she))\b/i.test(text) ||
    /\b(recogni[sz]e|recogni[sz]ing)\b.*\b(persons?|people|someone|anyone|faces?|him|her|them|this|that)\b/i.test(text) ||
    /\b(do\s+you\s+know\s+(who|him|her|them|this\s+person))\b/i.test(text) ||
    /\b(facial\s+recognition|face\s+id)\b/i.test(text) ||
    /\b(open|show)\s+(the\s+)?(identify|upload|photo|image|face)\s*(panel|box|input)?\b/i.test(text) ||
    /\b(upload\s+(a\s+)?(photo|image|picture))\b/i.test(text)
  );
}

export async function handleChat(rawMessage: string, rawHistory: ChatTurn[] | undefined): Promise<ChatResponseBody> {
  const message = (rawMessage || "").trim().slice(0, MAX_MESSAGE_LEN);
  const history = Array.isArray(rawHistory) ? rawHistory.slice(-MAX_HISTORY_TURNS) : [];

  if (!message) {
    return { reply: "Sorry, could you say that again? I didn't quite catch it.", instructions: [], source: "fallback" };
  }

  // Reject echo if the incoming message matches the previous assistant response in history
  if (history.length > 0) {
    const lastAssistant = [...history].reverse().find((turn) => turn.role === "assistant");
    if (lastAssistant && lastAssistant.content) {
      const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
      const cleanMsg = normalize(message);
      const cleanPrev = normalize(lastAssistant.content);
      if (cleanMsg.length >= 6 && (cleanMsg === cleanPrev || cleanPrev.includes(cleanMsg))) {
        console.warn(`[chat] Rejected self-echo: "${message}" matches previous assistant reply.`);
        return { reply: "", instructions: [], source: "fallback" };
      }
    }
  }

  // 1. Instant, no-LLM fast path for wake-word imperatives ("Vision, dance").
  const direct = matchDirectCommand(message);
  if (direct) {
    return { reply: direct.reply, instructions: direct.instructions, source: "direct" };
  }

  // 2. Identify-person intent — open the panel and prompt for a photo
  if (isIdentifyIntent(message)) {
    return {
      reply: "Sure! Drop or upload a photo into the panel on the right and I'll tell you who it is.",
      instructions: [],
      source: "direct",
      action: "open_identify",
    };
  }

  // 3. Custom command: "scrape" – run the information‑scraper on all images.
  if (/^scrape$/i.test(message)) {
    try {
      const imagesDir = path.resolve(__dirname, "../../../information-scrapper/images");
      const files = await fs.promises.readdir(imagesDir);
      const imageFiles = files.filter((f) => /\.(jpg|jpeg|png)$/i.test(f));
      if (imageFiles.length === 0) {
        return { reply: "No images found in the information‑scraper images folder.", instructions: [], source: "scraper" };
      }
      const scraper = new PersonScraper();
      const results: string[] = [];
      for (const file of imageFiles) {
        const imagePath = path.join(imagesDir, file);
        const res = await scraper.scrape(imagePath);
        if (res.success) {
          const summary = res.name && res.info && res.info.length > 0 ? await summarizePersonInfo(res.name, res.info) : "";
          results.push(`🖼️ ${file}: ${res.name}${summary ? `\nSummary: ${summary}` : ""}\n${res.info?.map((p, i) => `${i + 1}. ${p}`).join("\n")}`);
        } else {
          results.push(`🖼️ ${file}: ${res.error}`);
        }
      }
      const reply = results.join("\n\n");
      return { reply, instructions: [], source: "scraper" };
    } catch (e: any) {
      console.error("[scraper] error", e);
      return { reply: "Sorry, I ran into an error while trying to identify those images.", instructions: [], source: "scraper" };
    }
  }

  // 4. Otherwise, hand it to the configured LLM and pull any command tags
  //    it chose to embed out of the reply, validating each one.
  console.log(`[chat] LLM request: "${message.slice(0, 80)}${message.length > 80 ? "…" : ""}"`);
  const result = await askLlm(message, history);
  if (!result.ok) {
    console.error(`[chat] LLM failed → ${result.text}`);
    return { reply: result.text, instructions: [], source: "fallback" };
  }

  const { text, instructions, action: parsedAction } = extractCommands(result.text);
  const action =
    parsedAction ||
    (/\b(panel|upload (a |an )?(photo|image|picture)|drop (a |an )?(photo|image))\b/i.test(text)
      ? "open_identify"
      : undefined);

  console.log(`[chat] LLM ok (${instructions.length} cmd(s)): "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);
  return { reply: text || "…", instructions, source: "llm", ...(action ? { action } : {}) };
}
