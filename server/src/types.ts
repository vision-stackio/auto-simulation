/**
 * Shared types for the Vision Auto-Simulation server.
 */

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
  "PLAY_MUSIC",
  "STOP_MUSIC",
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
  source: "direct" | "llm" | "fallback" | "music";
}
