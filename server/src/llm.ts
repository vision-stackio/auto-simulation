import { ChatTurn } from "./types";
import { describeCommandsForPrompt } from "./commands";

const PROVIDER = (process.env.LLM_PROVIDER || "openai").toLowerCase();
const API_KEY = process.env.LLM_API_KEY || "";
const MODEL = process.env.LLM_MODEL || (PROVIDER === "anthropic" ? "claude-sonnet-4-6" : "gpt-4o-mini");
const API_URL =
  process.env.LLM_API_URL || (PROVIDER === "anthropic" ? "https://api.anthropic.com/v1/messages" : "https://api.openai.com/v1/chat/completions");
const REQUEST_TIMEOUT_MS = 18000;

export function isLlmConfigured(): boolean {
  return API_KEY.length > 0;
}

export function llmSummary() {
  return { provider: PROVIDER, model: MODEL, configured: isLlmConfigured() };
}

function systemPrompt(): string {
  return [
    "You are Vision, a small talking robot with a 3D body that a person can see and hear.",
    "Reply the way you'd actually speak out loud: short, warm, conversational — a sentence or two, not a lecture.",
    "You have a person identification system via an image upload panel on the right. If the user asks whether you can identify or recognize any person, or asks who someone is, answer enthusiastically that you can identify people if they upload a photo in the panel on the right. Always include [[ACTION:OPEN_IDENTIFY]] in your reply so the panel opens automatically for them.",
    "You may make your body move by embedding tags anywhere in your reply, on their own or mixed into a sentence:",
    `  [[CMD:NAME]] or [[CMD:NAME arg]] — NAME must be one of: ${describeCommandsForPrompt()}.`,
    "  [[WAIT:milliseconds]] — a pause between actions (max 5000).",
    "Examples: [[CMD:DANCE 2500]], [[CMD:TURN_LEFT 600]], [[CMD:EYE_SET 40]], [[CMD:AUDIO_SPEAK \"Hi!\"]].",
    "Only use a movement tag when it actually fits what you're saying (e.g. someone asks you to dance, look somewhere, walk, or you want to react physically) — most replies need none at all.",
    "Tags are invisible to the person; they never appear in what gets spoken, so don't describe them in words too.",
    "Never invent a command name that isn't in the list above.",
  ].join("\n");
}

interface LlmResult {
  ok: boolean;
  text: string;
}

async function callOpenAiCompatible(message: string, history: ChatTurn[]): Promise<LlmResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPrompt() },
          ...history.map((h) => ({ role: h.role, content: h.content })),
          { role: "user", content: message },
        ],
        max_tokens: 300,
        temperature: 0.7,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[LLM]", `Endpoint returned ${res.status}: ${body.slice(0, 200)}`);

      let userMsg = "Sorry, I'm having trouble connecting to my brain.";
      if (res.status === 401) {
        userMsg = "My API key seems to be invalid or expired. Please check my configuration.";
      } else if (res.status === 429) {
        userMsg = "I'm receiving too many requests right now. Please wait a moment.";
      }

      return { ok: false, text: userMsg };
    }
    const data: any = await res.json();
    const text = data?.choices?.[0]?.message?.content ?? "";
    return { ok: true, text };
  } catch (err: any) {
    const msg = err?.name === "AbortError"
      ? "Hmm, I didn't quite catch that — could you say it again?"
      : "Sorry, I'm having a little trouble thinking right now. Could you try again?";
    console.error("[LLM]", msg);
    return { ok: false, text: msg };
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropic(message: string, history: ChatTurn[]): Promise<LlmResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 300,
        system: systemPrompt(),
        messages: [...history.map((h) => ({ role: h.role, content: h.content })), { role: "user", content: message }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[LLM]", `Endpoint returned ${res.status}: ${body.slice(0, 200)}`);

      let userMsg = "Sorry, I'm having trouble connecting to my brain.";
      if (res.status === 401) {
        userMsg = "My API key seems to be invalid or expired. Please check my configuration.";
      } else if (res.status === 429) {
        userMsg = "I'm receiving too many requests right now. Please wait a moment.";
      }

      return { ok: false, text: userMsg };
    }
    const data: any = await res.json();
    const text = (data?.content || []).map((b: any) => (b.type === "text" ? b.text : "")).join("");
    return { ok: true, text };
  } catch (err: any) {
    const msg = err?.name === "AbortError"
      ? "Hmm, I didn't quite catch that — could you say it again?"
      : "Sorry, I'm having a little trouble thinking right now. Could you try again?";
    console.error("[LLM]", msg);
    return { ok: false, text: msg };
  } finally {
    clearTimeout(timer);
  }
}

export async function askLlm(message: string, history: ChatTurn[]): Promise<LlmResult> {
  if (!isLlmConfigured()) {
    return {
      ok: false,
      text: "Hmm, my thinking module isn't set up yet — ask the team to plug in an LLM API key!",
    };
  }
  return PROVIDER === "anthropic" ? callAnthropic(message, history) : callOpenAiCompatible(message, history);
}

async function callOpenAiDirect(systemPromptText: string, userMessage: string, maxTokens = 350): Promise<LlmResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: systemPromptText },
          { role: "user", content: userMessage },
        ],
        max_tokens: maxTokens,
        temperature: 0.6,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[LLM Direct]", `Endpoint returned ${res.status}: ${body.slice(0, 200)}`);
      return { ok: false, text: "LLM endpoint error" };
    }
    const data: any = await res.json();
    let text = (data?.choices?.[0]?.message?.content ?? "")
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .trim();
    return { ok: true, text };
  } catch (err: any) {
    console.error("[LLM Direct]", err?.message || err);
    return { ok: false, text: "LLM request error" };
  } finally {
    clearTimeout(timer);
  }
}

async function callAnthropicDirect(systemPromptText: string, userMessage: string, maxTokens = 200): Promise<LlmResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        system: systemPromptText,
        messages: [{ role: "user", content: userMessage }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error("[LLM Direct]", `Endpoint returned ${res.status}: ${body.slice(0, 200)}`);
      return { ok: false, text: "LLM endpoint error" };
    }
    const data: any = await res.json();
    const text = (data?.content || []).map((b: any) => (b.type === "text" ? b.text : "")).join("");
    return { ok: true, text };
  } catch (err: any) {
    console.error("[LLM Direct]", err?.message || err);
    return { ok: false, text: "LLM request error" };
  } finally {
    clearTimeout(timer);
  }
}

export function cleanSnippetText(raw: string): string {
  if (!raw) return "";
  return raw
    // Remove date/time prefixes e.g. "Jan 15, 2024 ... " or "15 Jan 2024 — "
    .replace(/^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}\s*[—–\-·….]\s*/i, "")
    .replace(/^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\s*[—–\-·….]\s*/i, "")
    .replace(/^\d+\s+(hours?|days?|months?|years?|mins?|minutes?)\s+ago\s*[—–\-·….]\s*/i, "")
    // Remove phonetic guides like (/ˈiːlɒn/; ... ) or (/ˈiːlɒn/)
    .replace(/\s*\(\s*\/[^)]+\/\s*[;,]?\s*/gi, " (")
    // Remove post-nominal letters like FRS, KBE, etc.
    .replace(/\b(FRS|KBE|OBE|CBE|MBE)\b/g, "")
    // Remove birth/death parentheticals like (born June 28, 1971) or (born 1971)
    .replace(/\s*\([^)]*\b(?:born|died|pronounced|née)\b[^)]*\)/gi, "")
    // Remove empty parentheses left over
    .replace(/\s*\(\s*\)/g, "")
    // Remove Wikipedia citations [1], [2]
    .replace(/\[\d+\]/g, "")
    // Remove ellipses
    .replace(/\.{2,}/g, ".")
    // Clean multiple spaces
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Intelligent local fallback summarizer for person information points.
 * Cleans search metadata, removes birth dates and citations, and generates
 * a complete, grammatically sound, informative summary sentence.
 */
export function generateFallbackSummary(name: string, infoPoints: string[]): string {
  const safeName = name ? name.replace(/\s*[-–—|•·].*$/, "").trim() : "this person";
  if (!infoPoints || infoPoints.length === 0) {
    return `I think this is ${safeName}.`;
  }

  const cleaned = infoPoints.map(cleanSnippetText).filter((s) => s.length > 20);
  if (cleaned.length === 0) {
    return `I identified this person as ${safeName}.`;
  }

  // Find the primary identity sentence (e.g. "is a businessman...", "is the CEO of...")
  let identitySentence = "";
  for (const item of cleaned) {
    const sentences = item.split(/(?<=[.!?])\s+/);
    for (const s of sentences) {
      if (
        /\b(?:is|was)\s+(?:an?|the)\b/i.test(s) &&
        /\b(?:businessman|entrepreneur|investor|executive|founder|ceo|scientist|engineer|artist|politician|leader|author|actor|director|researcher)\b/i.test(s)
      ) {
        identitySentence = s.trim();
        break;
      }
    }
    if (identitySentence) break;
  }

  if (!identitySentence) {
    for (const item of cleaned) {
      const sentences = item.split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (/\b(?:is|was)\s+(?:an?|the)\b/i.test(s) || /\b(?:known for|leads|founded|created)\b/i.test(s)) {
          identitySentence = s.trim();
          break;
        }
      }
      if (identitySentence) break;
    }
  }

  if (!identitySentence) {
    identitySentence = cleaned[0].split(/(?<=[.!?])\s+/)[0] || cleaned[0];
  }

  let sentence = identitySentence;

  // Transform "[Full Name] is a..." -> "This is [safeName], a..."
  const fullIdentityRegex = new RegExp(`^[A-Z][a-zA-Z\\s.']+\\s+(?:is|was)\\s+(an?\\s+.+)$`, "i");
  const match = sentence.match(fullIdentityRegex);
  if (match) {
    sentence = `This is ${safeName}, ${match[1]}`;
  } else if (!sentence.toLowerCase().includes(safeName.toLowerCase())) {
    sentence = `This is ${safeName}. ${sentence}`;
  }

  // Strip any trailing dangling words (never end on 'and', 'the', 'of', etc.)
  sentence = sentence
    .replace(/\s+(?:and|the|of|in|for|with|that|to|a|an|as|or|by)[.,\s]*$/i, "")
    .replace(/[,\s;:-]+$/, "")
    .trim();

  if (!/[.!?]$/.test(sentence)) {
    sentence += ".";
  }

  return sentence;
}

function isValidCompleteSummary(text: string): boolean {
  if (!text || text.length < 25) return false;
  const trimmed = text.trim();
  if (!/[.!?]$/.test(trimmed)) return false;
  if (/\b(and|the|or|of|in|to|with|for|a|an|that|as)\s*[.!?]$/i.test(trimmed)) return false;
  if (/^(user )?safety:\s*(safe|unsafe)/i.test(trimmed)) return false;
  if (trimmed.toLowerCase().startsWith("here's a thinking")) return false;
  return true;
}

/**
 * Summarizes the person's identified identity and information points into
 * a conversational 1-2 sentence spoken summary rich with information.
 */
export async function summarizePersonInfo(name: string, infoPoints: string[]): Promise<string> {
  const safeName = name ? name.replace(/\s*[-–—|•·].*$/, "").trim() : "this person";
  if (!infoPoints || infoPoints.length === 0) {
    return `I think this is ${safeName}.`;
  }

  if (isLlmConfigured()) {
    try {
      const systemPromptText = [
        "You are Vision, a knowledgeable, friendly voice robot assistant.",
        "Your task is to provide an informative, complete, 1 to 2 sentence spoken introduction about the identified person.",
        "Rules:",
        "- State who they are (their profession/title) and their most notable companies, accomplishments, or contributions.",
        "- Must be a complete, grammatically correct sentence ending with a period.",
        "- Do NOT end mid-sentence or trail off with 'and' or 'the'.",
        "- Speak naturally: e.g., 'This is Elon Musk, the visionary entrepreneur and CEO of Tesla and SpaceX known for revolutionizing electric vehicles and private space exploration.'",
        "- Do NOT include birth dates in parentheses, citations, or metadata.",
        "- Return ONLY the final spoken summary text without quotes or markdown.",
      ].join("\n");

      const userPrompt = [
        `Person Name: ${safeName}`,
        `Gathered Information Points:`,
        ...infoPoints.slice(0, 5).map((pt, i) => `${i + 1}. ${cleanSnippetText(pt)}`),
      ].join("\n");

      const res = PROVIDER === "anthropic"
        ? await callAnthropicDirect(systemPromptText, userPrompt, 350)
        : await callOpenAiDirect(systemPromptText, userPrompt, 350);

      if (res.ok && res.text.trim()) {
        let cleaned = res.text.trim().replace(/^["']|["']$/g, "").trim();

        // If it ended with a dangling preposition/conjunction, clean it
        cleaned = cleaned
          .replace(/\s+(?:and|the|of|in|for|with|that|to|a|an|as|or|by)[.,\s]*$/i, "")
          .replace(/[,\s;:-]+$/, "");

        if (!/[.!?]$/.test(cleaned)) {
          cleaned += ".";
        }

        if (isValidCompleteSummary(cleaned)) {
          return cleaned;
        }
      }
    } catch (err) {
      console.warn("[summarizePersonInfo] LLM summarization error:", err);
    }
  }

  return generateFallbackSummary(safeName, infoPoints);
}
