import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const SOURCE = "pi/extension";
const TTL_SECONDS = 300;
const HEARTBEAT_MS = 60_000;
const COMMAND_TIMEOUT_MS = 5_000;
type Status = "idle" | "working" | "blocked" | "done";

/** The CLI inherits LUVUS_SOCKET_PATH; nothing in the agent transcript is sent. */
export default function luvusPi(pi: ExtensionAPI): void {
  const pane = process.env.LUVUS_PANE_ID?.trim();
  if (process.env.LUVUS_ENV !== "1" || !pane || !process.env.LUVUS_SOCKET_PATH?.trim()) return;
  const binary = process.env.LUVUS_BIN_PATH?.trim() || "luvus";
  let active = false;
  let running = false;
  let hasRun = false;
  let prompts = 0;
  let session: string | undefined;
  let sequence = Date.now() * 1000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let queue: Promise<void> = Promise.resolve();
  let lastSuccessful: string | undefined;

  function status(): Status {
    return prompts > 0 ? "blocked" : running ? "working" : hasRun ? "done" : "idle";
  }

  function diagnostic(action: string): void {
    // Never log CLI output: it could contain a path, token, or user content.
    console.error(`[luvus-pi] ${action} failed`);
  }

  function report(force = false): void {
    if (!active) return;
    const current = status();
    const id = session;
    const key = `${current}\0${id ?? ""}`;
    // Serialize both the state decision and the CLI call; failed sends are retryable.
    queue = queue.then(async () => {
      if (!active || (!force && lastSuccessful === key)) return;
      const args = ["agent", "report", pane!, "--source", SOURCE, "--kind", "pi", "--status", current,
        "--sequence", String(++sequence), "--ttl", String(TTL_SECONDS)];
      if (id) args.push("--session", id);
      try {
        const result = await pi.exec(binary, args, { timeout: COMMAND_TIMEOUT_MS });
        if (result.code === 0 && !result.killed) lastSuccessful = key;
        else diagnostic("report");
      } catch {
        diagnostic("report");
      }
    });
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    active = true;
    running = !ctx.isIdle();
    hasRun = running;
    prompts = 0;
    const id = ctx.sessionManager.getSessionId();
    session = id && id.length <= 512 ? id : undefined;
    lastSuccessful = undefined;
    report();
    if (!timer) timer = setInterval(() => report(true), HEARTBEAT_MS);
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!active || ctx.mode !== "tui") return;
    running = true;
    hasRun = true;
    report();
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (!active || ctx.mode !== "tui") return;
    running = false;
    report();
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    if (!active || ctx.mode !== "tui") return;
    prompts++;
    report();
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    if (!active || ctx.mode !== "tui") return;
    prompts = Math.max(0, prompts - 1);
    report();
  });
  pi.on("session_shutdown", async () => {
    if (!active) return;
    active = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    // Already queued reports must finish before release; never enqueue a report after this point.
    queue = queue.then(async () => {
      // Release is idempotent; one bounded retry covers transient CLI failures.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await pi.exec(binary, ["agent", "release", pane!, "--source", SOURCE],
            { timeout: COMMAND_TIMEOUT_MS });
          if (result.code === 0 && !result.killed) return;
        } catch {
          // Report only after retries; never print the CLI's output or exception.
        }
      }
      diagnostic("release");
    });
    await queue;
  });
}
