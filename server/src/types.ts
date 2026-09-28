/**
 * Shared types for the Vision Auto-Simulation server.
 *
 * Mirrors the spirit of the sibling `compiler` project's IR (EXEC / SLEEP),
 * but instructions here are produced live — either matched instantly from a
 * wake-word phrase, or parsed out of an LLM's reply — rather than compiled
 * ahead of time from a script file. There is no compiler in this project by
 * design; instead, every instruction is validated against a fixed safelist
 * (see commands.ts) before it is ever sent to the browser.
 */

/** The only commands the 3D rig knows how to animate. Anything else is
 *  rejected before it reaches the client. Kept in sync with the rig's
 *  `apply()` switch in client/js/rig.js. */
export const COMMAND_TYPES = [
  "EYE_CENTER",
  "EYE_SET",
  "EYE_LEFT",
  "EYE_RIGHT",
  "TURN_LEFT",
  "TURN_RIGHT",
  "WALK_FORWARD",
  "WALK_BACKWARD",
  "WALK_STOP",
  "DANCE",
  "EMERGENCY_STOP",
  "EMERGENCY_CLEAR",
  "AUDIO_SPEAK",
] as const;

export type CommandType = (typeof COMMAND_TYPES)[number];

export function isCommandType(value: string): value is CommandType {
  return (COMMAND_TYPES as readonly string[]).includes(value);
}

export type Instruction =
  | { op: "EXEC"; command: CommandType; arg?: number | string }
  | { op: "SLEEP"; ms: number };

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequestBody {
  message: string;
  history?: ChatTurn[];
}

export interface ChatResponseBody {
  reply: string;
  instructions: Instruction[];
  source: "direct" | "llm" | "fallback" | "scraper";
  action?: "open_identify";
}

/** Body sent by the client for the /api/identify endpoint.
 *  imageBase64 is the raw base64 string (no data-URI prefix). */
export interface IdentifyRequestBody {
  imageBase64: string;
  mimeType: string;
}

export interface IdentifyResponseBody {
  name?: string;
  info?: string[];
  summary?: string;
  error?: string;
  source: "scraper";
}
