/**
 * Shortcuts in the terminal "+" menu. Each one only opens a normal terminal and types the command;
 * Cadorphin works the same with any agent (or none). Add entries here, or use "Custom command…".
 */
export const KNOWN_AGENTS: { label: string; command: string }[] = [
  { label: "Claude Code", command: "claude" },
  { label: "Codex", command: "codex" },
  { label: "Gemini CLI", command: "gemini" },
  { label: "Aider", command: "aider" },
];
