import { ChatResponseBody, ChatTurn, Instruction } from "./types";
import { matchDirectCommand, extractCommands, matchMusicRequest } from "./commands";
import { askLlm } from "./llm";
import { downloadSong } from "./music_responce";

const MAX_MESSAGE_LEN = 500;
const MAX_HISTORY_TURNS = 8;

export async function handleChat(rawMessage: string, rawHistory: ChatTurn[] | undefined): Promise<ChatResponseBody> {
  const message = (rawMessage || "").trim().slice(0, MAX_MESSAGE_LEN);
  const history = Array.isArray(rawHistory) ? rawHistory.slice(-MAX_HISTORY_TURNS) : [];

  if (!message) {
    return { reply: "I didn't catch that — try again?", instructions: [], source: "fallback" };
  }

  // 1. Instant, no-LLM fast path for wake-word imperatives ("Vision, dance").
  const direct = matchDirectCommand(message);
  if (direct) {
    return { reply: direct.reply, instructions: direct.instructions, source: "direct" };
  }

  // 1b. Allow "stop" / "stop music" without wake word (typed or speech that skipped the prefix)
  {
    const lower = message.toLowerCase().replace(/[.!?]+$/, "").trim();
    if (/^(stop music|stop the music|stop song|stop the song)$/.test(lower)) {
      return {
        reply: "Stopping the music.",
        instructions: [
          { op: "EXEC", command: "STOP_MUSIC" },
          { op: "EXEC", command: "WALK_STOP" },
        ],
        source: "direct",
      };
    }
    if (/^(stop|stop dancing|stop moving|halt|freeze)$/.test(lower)) {
      return {
        reply: "Stopping.",
        instructions: [
          { op: "EXEC", command: "STOP_MUSIC" },
          { op: "EXEC", command: "WALK_STOP" },
        ],
        source: "direct",
      };
    }
  }

  // 2. Music requests: "play X", "play X and dance", "Vision play X" ...
  const music = matchMusicRequest(message);
  if (music) {
    console.log(`[chat] Music request: "${music.song}" (dance=${music.dance})`);
    try {
      const result = await downloadSong(music.song);
      const instructions: Instruction[] = [
        { op: "EXEC", command: "PLAY_MUSIC", arg: result.fileUrl },
      ];
      if (music.dance) {
        instructions.push({ op: "EXEC", command: "DANCE" });
      }
      const reply = music.dance
        ? `Playing "${result.title}" — let's dance!`
        : `Playing "${result.title}".`;
      return { reply, instructions, source: "music" };
    } catch (err: any) {
      console.error("[chat] Music download failed:", err?.message || err);
      return {
        reply: `Sorry, I couldn't find or download that song. (${err?.message || "error"})`,
        instructions: [],
        source: "fallback",
      };
    }
  }

  // 3. Otherwise, hand it to the configured LLM and pull any command tags
  //    it chose to embed out of the reply, validating each one.
  console.log(`[chat] LLM request: "${message.slice(0, 80)}${message.length > 80 ? "…" : ""}"`);
  const result = await askLlm(message, history);
  if (!result.ok) {
    console.error(`[chat] LLM failed → ${result.text}`);
    return { reply: result.text, instructions: [], source: "fallback" };
  }

  const { text, instructions } = extractCommands(result.text);
  console.log(`[chat] LLM ok (${instructions.length} cmd(s)): "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);
  return { reply: text || "…", instructions, source: "llm" };
}
