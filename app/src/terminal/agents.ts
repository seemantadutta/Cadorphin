/**
 * Well-known agent CLIs. Each entry only builds the command typed into a normal terminal;
 * Cadorphin works the same with any agent (or none). Add entries here, or use "Custom command…".
 *
 * `start` begins a new conversation and `resume` continues the previous one in the project folder.
 * Only Claude Code lets us choose the session id up front, so it is the only one that stores an
 * id; the others resume their latest session for the folder they are started in.
 */
export interface AgentDef {
  id: string;
  label: string;
  /** The command as shown in menus. */
  command: string;
  start(): { command: string; sessionId?: string };
  resume(sessionId?: string): string;
}

export const KNOWN_AGENTS: AgentDef[] = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    start() {
      const sessionId = crypto.randomUUID();
      return { command: `claude --session-id ${sessionId}`, sessionId };
    },
    resume: (sessionId) => (sessionId ? `claude --resume ${sessionId}` : "claude --continue"),
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    start: () => ({ command: "codex" }),
    resume: () => "codex resume --last", // latest session started in this folder
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    command: "gemini",
    start: () => ({ command: "gemini" }),
    resume: () => "gemini --resume latest", // sessions are kept per project folder
  },
  {
    id: "aider",
    label: "Aider",
    // Aider doesn't load an instructions file by itself; --read gives it the project's rules and brief.
    command: "aider --read AGENTS.md",
    start: () => ({ command: "aider --read AGENTS.md" }),
    resume: () => "aider --read AGENTS.md --restore-chat-history",
  },
];

export function findAgent(id: string): AgentDef | undefined {
  return KNOWN_AGENTS.find((a) => a.id === id);
}

/** A custom command: started the same way every time, with no session handling. */
export function customAgent(command: string): AgentDef {
  return {
    id: `custom:${command}`,
    label: command.split(/\s+/)[0],
    command,
    start: () => ({ command }),
    resume: () => command,
  };
}

export function agentFor(id: string): AgentDef | undefined {
  return id.startsWith("custom:") ? customAgent(id.slice("custom:".length)) : findAgent(id);
}
