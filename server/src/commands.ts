import { COMMAND_TYPES, CommandType, Instruction, isCommandType } from "./types";

/** Safety clamps per command. Kept intentionally tight — this is a demo
 *  robot in a browser, not a real actuator, but the clamping habit is the
 *  point: nothing from an LLM (or a spoken phrase) reaches the rig without
 *  its numeric argument being bounds-checked first. */
const ARG_BOUNDS: Partial<Record<CommandType, [number, number]>> = {
  EYE_SET: [0, 180],
  EYE_LEFT: [1, 90],
  EYE_RIGHT: [1, 90],
  TURN_LEFT: [150, 4000],
  TURN_RIGHT: [150, 4000],
  WALK_FORWARD: [200, 6000],
  WALK_BACKWARD: [200, 6000],
  DANCE: [400, 8000],
};

/** Commands that take a free-text string argument instead of a number. */
const STRING_ARG_COMMANDS: ReadonlySet<CommandType> = new Set(["AUDIO_SPEAK", "PLAY_MUSIC"]);

const MAX_INSTRUCTIONS_PER_TURN = 12;
const MAX_WAIT_MS = 5000;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function sanitizeArg(command: CommandType, rawArg: string | undefined): number | string | undefined {
  if (rawArg === undefined) return undefined;

  if (STRING_ARG_COMMANDS.has(command)) {
    const text = rawArg.replace(/^"|"$/g, "").trim();
    const maxLen = command === "PLAY_MUSIC" ? 400 : 200;
    return text.slice(0, maxLen) || undefined;
  }

  const n = Number(rawArg);
  if (Number.isNaN(n)) return undefined;

  const bounds = ARG_BOUNDS[command];
  return bounds ? clamp(n, bounds[0], bounds[1]) : n;
}

/**
 * Pulls `[[CMD:NAME arg]]` and `[[WAIT:ms]]` tags out of raw LLM text.
 * Anything that isn't on the COMMAND_TYPES safelist, or that fails to
 * parse, is silently dropped — never surfaced to the rig, never left
 * dangling in the spoken reply either.
 */
export function extractCommands(raw: string): { text: string; instructions: Instruction[] } {
  const instructions: Instruction[] = [];

  const cleaned = raw
    .replace(/\[\[(CMD|WAIT):([^\]]*)\]\]/gi, (_match, kind: string, body: string) => {
      if (instructions.length >= MAX_INSTRUCTIONS_PER_TURN) return "";

      if (kind.toUpperCase() === "WAIT") {
        const ms = clamp(parseInt(body.trim(), 10) || 0, 0, MAX_WAIT_MS);
        if (ms > 0) instructions.push({ op: "SLEEP", ms });
        return "";
      }

      const parts = body.trim().split(/\s+/);
      const commandRaw = (parts.shift() || "").toUpperCase();
      if (!isCommandType(commandRaw)) return "";

      const arg = sanitizeArg(commandRaw, parts.length ? parts.join(" ") : undefined);
      instructions.push(arg === undefined ? { op: "EXEC", command: commandRaw } : { op: "EXEC", command: commandRaw, arg });
      return "";
    })
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text: cleaned, instructions };
}

interface DirectMatch {
  test: RegExp;
  reply: string;
  instructions: Instruction[];
}

const DIRECT_COMMANDS: DirectMatch[] = [
  {
    test: /^emergency stop$/,
    reply: "Emergency stop engaged.",
    instructions: [{ op: "EXEC", command: "EMERGENCY_STOP" }],
  },
  {
    test: /^(clear|resume|release)( the)? (e-?stop|emergency)$/,
    reply: "Emergency stop cleared.",
    instructions: [{ op: "EXEC", command: "EMERGENCY_CLEAR" }],
  },
  {
    test: /^dance( for me)?!?$/,
    reply: "Let's dance! Say Vision, stop when you want me to halt.",
    instructions: [{ op: "EXEC", command: "DANCE" }],
  },
  {
    test: /^(stop music|stop the music|stop song|stop the song)$/,
    reply: "Stopping the music.",
    instructions: [{ op: "EXEC", command: "STOP_MUSIC" }, { op: "EXEC", command: "WALK_STOP" }],
  },
  {
    test: /^(stop|stop dancing|stop moving|stop walking|halt|freeze|stand still)$/,
    reply: "Stopping.",
    instructions: [{ op: "EXEC", command: "STOP_MUSIC" }, { op: "EXEC", command: "WALK_STOP" }],
  },
  {
    test: /^(walk|go|move)(\s+)?(forward|straight|ahead)$/,
    reply: "Walking forward. Say Vision, stop when you want me to halt.",
    instructions: [{ op: "EXEC", command: "WALK_FORWARD" }],
  },
  {
    test: /^(walk|go|move)(\s+)?(backward|back|backwards)$/,
    reply: "Walking backward. Say Vision, stop when you want me to halt.",
    instructions: [{ op: "EXEC", command: "WALK_BACKWARD" }],
  },
  {
    test: /^(turn|rotate|spin)?\s*left$/,
    reply: "Turning left.",
    instructions: [{ op: "EXEC", command: "TURN_LEFT", arg: 600 }],
  },
  {
    test: /^(turn|rotate|spin)?\s*right$/,
    reply: "Turning right.",
    instructions: [{ op: "EXEC", command: "TURN_RIGHT", arg: 600 }],
  },
  {
    test: /^look left$/,
    reply: "Looking left.",
    instructions: [{ op: "EXEC", command: "EYE_LEFT", arg: 35 }],
  },
  {
    test: /^look right$/,
    reply: "Looking right.",
    instructions: [{ op: "EXEC", command: "EYE_RIGHT", arg: 35 }],
  },
  {
    test: /^(look|center|face)( straight)?( ahead| forward| center)?$/,
    reply: "Centering.",
    instructions: [{ op: "EXEC", command: "EYE_CENTER" }],
  },
  {
    test: /^(wave|say hi|say hello)$/,
    reply: "Hello there!",
    instructions: [
      { op: "EXEC", command: "AUDIO_SPEAK", arg: "Hello there!" },
      { op: "EXEC", command: "TURN_LEFT", arg: 300 },
      { op: "SLEEP", ms: 300 },
      { op: "EXEC", command: "TURN_RIGHT", arg: 300 },
    ],
  },
];

const WAKE_WORD = /^\s*vision[,!.]?\s+/i;

export function matchDirectCommand(message: string): { reply: string; instructions: Instruction[] } | null {
  if (!WAKE_WORD.test(message)) return null;
  const rest = message.replace(WAKE_WORD, "").trim().toLowerCase().replace(/[.!?]+$/, "");
  for (const candidate of DIRECT_COMMANDS) {
    if (candidate.test.test(rest)) {
      return { reply: candidate.reply, instructions: candidate.instructions };
    }
  }
  return null;
}

/**
 * Detect "play <song>" / "play <song> and dance" (with or without wake word).
 */
export function matchMusicRequest(message: string): { song: string; dance: boolean } | null {
  let text = message.trim();
  text = text.replace(WAKE_WORD, "").trim();

  const danceSuffix = /\s+(and|then|&)\s+dance(\s+for\s+me)?\s*[.!?]*$/i;
  let dance = false;
  if (danceSuffix.test(text)) {
    dance = true;
    text = text.replace(danceSuffix, "").trim();
  }

  const dancePrefix = /^(play\s+and\s+dance(\s+to)?|dance\s+to)\s+/i;
  if (dancePrefix.test(text)) {
    dance = true;
    text = text.replace(dancePrefix, "").trim();
  }

  const playMatch = text.match(/^(?:play(?:\s+me)?(?:\s+the)?(?:\s+song)?)\s+(.+)$/i);
  if (playMatch) {
    let song = playMatch[1].trim().replace(/[.!?]+$/, "").trim();
    song = song.replace(/\s+song$/i, "").trim();
    if (song.length >= 1) return { song, dance };
  }

  if (dance && text.length >= 1 && !/^(play|stop)/i.test(text)) {
    return { song: text.replace(/[.!?]+$/, "").trim(), dance: true };
  }

  return null;
}

export function describeCommandsForPrompt(): string {
  return COMMAND_TYPES.join(", ");
}
