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
const STRING_ARG_COMMANDS: ReadonlySet<CommandType> = new Set(["AUDIO_SPEAK"]);

const MAX_INSTRUCTIONS_PER_TURN = 12;
const MAX_WAIT_MS = 5000;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function sanitizeArg(command: CommandType, rawArg: string | undefined): number | string | undefined {
  if (rawArg === undefined) return undefined;

  if (STRING_ARG_COMMANDS.has(command)) {
    // Strip surrounding quotes and hard-cap length so a runaway LLM reply
    // can't turn into an enormous speech-bubble string.
    const text = rawArg.replace(/^"|"$/g, "").trim();
    return text.slice(0, 200) || undefined;
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
      if (!isCommandType(commandRaw)) return ""; // not on the safelist — dropped

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

// Order matters — first match wins, so more specific phrases (e.g. the
// emergency stop) are listed before the generic ones they could overlap with.
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
    test: /^(stop|stop dancing|stop moving|stop walking|halt|freeze|stand still)$/,
    reply: "Stopping.",
    instructions: [{ op: "EXEC", command: "WALK_STOP" }],
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

/**
 * Fast path: phrases that start with the wake word "Vision" and match a
 * known imperative are handled instantly, with no round trip to an LLM at
 * all — e.g. "Vision, dance" or "Vision turn left".
 * Returns null if the phrase doesn't start with the wake word, or doesn't
 * match anything, so the caller can fall through to the LLM.
 */
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

export function describeCommandsForPrompt(): string {
  return COMMAND_TYPES.join(", ");
}
