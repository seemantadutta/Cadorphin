import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";

import { useBackend } from "../backend/context";
import type { TerminalId } from "../backend/types";

interface Props {
  /** Typed into the shell once it starts (the "+" menu's agent shortcuts). */
  command?: string;
  active: boolean;
  theme: "light" | "dark";
  onReady: (id: TerminalId) => void;
  onExit: (code: number | null) => void;
  /** Called once, on the user's first keystroke. */
  onFirstInput?: () => void;
  /** The terminal got keyboard focus (the user clicked into it or switched to its tab). */
  onFocus?: () => void;
  /** Receives a function that pastes text into the terminal as if the user pasted it, or null when it closes. */
  registerPaste?: (paste: ((text: string) => void) | null) => void;
  onError: (message: string) => void;
}

/** Control Sequence Introducer: how xterm's automatic replies to terminal queries begin. */
const CSI = "\x1b[";

function xtermTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (n: string) => css.getPropertyValue(n).trim();
  const dark = document.documentElement.dataset.theme !== "light";
  return {
    background: v("--bottom"),
    foreground: v("--fg-2"),
    cursor: v("--fg-2"),
    cursorAccent: v("--bottom"),
    selectionBackground: dark ? "#2a3a3f" : "#cdeee6",
    black: dark ? "#1b1f26" : "#3a3f48",
    brightBlack: dark ? "#5b6475" : "#6b7280",
    red: dark ? "#f87171" : "#c62828",
    green: dark ? "#34d399" : "#0f8f78",
    yellow: dark ? "#fbbf24" : "#b45309",
    blue: dark ? "#60a5fa" : "#1d4ed8",
    magenta: dark ? "#c084fc" : "#7e22ce",
    cyan: dark ? "#7dd3c0" : "#0e7490",
    white: dark ? "#c9cdd4" : "#d0d4db",
    brightWhite: dark ? "#e6e8ec" : "#ffffff",
  };
}

/** One terminal tab: xterm.js wired to a backend PTY running the user's shell. */
export function TerminalView({ command, active, theme, onReady, onExit, onFirstInput, onFocus, registerPaste, onError }: Props) {
  const backend = useBackend();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const termId = useRef<TerminalId | null>(null);
  const callbacks = useRef({ onReady, onExit, onFirstInput, onFocus, registerPaste, onError });
  callbacks.current = { onReady, onExit, onFirstInput, onFocus, registerPaste, onError };

  useEffect(() => {
    const t = new Terminal({
      fontFamily: '"JetBrains Mono", "Cascadia Mono", Consolas, ui-monospace, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: xtermTheme(),
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    try {
      f.fit();
    } catch {
      /* not visible yet */
    }

    let disposed = false;
    const unsubs: (() => void)[] = [];
    backend
      .openTerminal({ command, cols: t.cols, rows: t.rows })
      .then((id) => {
        if (disposed) {
          void backend.closeTerminal(id);
          return;
        }
        termId.current = id;
        unsubs.push(backend.onTerminalData(id, (d) => t.write(d)));
        unsubs.push(
          backend.onTerminalExit(id, (code) => {
            t.write(`\r\n\x1b[2m[process exited${code === null ? "" : ` with code ${code}`}]\x1b[0m\r\n`);
            callbacks.current.onExit(code);
          }),
        );
        let typed = false;
        const input = t.onData((d) => {
          backend.writeTerminal(id, d);
          // xterm answers terminal queries (e.g. the cursor position) through onData too; only count
          // real typing, which starts with a printable key, Enter, or a control key.
          if (!typed && !d.startsWith(CSI)) {
            typed = true;
            callbacks.current.onFirstInput?.();
          }
        });
        const resize = t.onResize(({ cols, rows }) => backend.resizeTerminal(id, cols, rows));
        unsubs.push(() => input.dispose(), () => resize.dispose());
        backend.resizeTerminal(id, t.cols, t.rows);
        // xterm wraps pasted text in bracketed-paste markers when the program asked for them, so an
        // agent's prompt treats it as typed input, not as keystrokes to act on.
        callbacks.current.registerPaste?.((text) => t.paste(text));
        callbacks.current.onReady(id);
      })
      .catch((e) => {
        t.write(`\x1b[31m${String(e)}\x1b[0m\r\n`);
        callbacks.current.onError(String(e));
      });

    const onFocusIn = () => callbacks.current.onFocus?.();
    t.textarea?.addEventListener("focus", onFocusIn);

    const ro = new ResizeObserver(() => {
      if (host.current && host.current.offsetParent !== null) {
        try {
          f.fit();
        } catch {
          /* ignore transient zero sizes */
        }
      }
    });
    ro.observe(host.current!);

    return () => {
      disposed = true;
      ro.disconnect();
      t.textarea?.removeEventListener("focus", onFocusIn);
      callbacks.current.registerPaste?.(null);
      unsubs.forEach((u) => u());
      if (termId.current) void backend.closeTerminal(termId.current);
      t.dispose();
    };
    // A terminal is created once per tab; command is fixed for its lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend]);

  useEffect(() => {
    if (!active) return;
    requestAnimationFrame(() => {
      try {
        fit.current?.fit();
      } catch {
        /* ignore */
      }
      term.current?.focus();
    });
  }, [active]);

  useEffect(() => {
    requestAnimationFrame(() => {
      if (term.current) term.current.options.theme = xtermTheme();
    });
  }, [theme]);

  return <div className="terminal-host" ref={host} style={{ display: active ? "block" : "none" }} />;
}
