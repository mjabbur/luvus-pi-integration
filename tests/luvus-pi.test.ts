import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import luvusPi from "../src/luvus-pi.ts";

type Handler = (event: unknown, ctx: any) => unknown;
type Call = { command: string; args: string[]; options: { timeout: number } };
const original = {
  env: { ...process.env },
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};

afterEach(() => {
  process.env = { ...original.env };
  globalThis.setInterval = original.setInterval;
  globalThis.clearInterval = original.clearInterval;
});

function harness(opts: { mode?: string; idle?: boolean; enabled?: boolean; exec?: (call: Call) => Promise<any> } = {}) {
  process.env.LUVUS_ENV = opts.enabled === false ? "0" : "1";
  process.env.LUVUS_PANE_ID = "pane-1";
  process.env.LUVUS_SOCKET_PATH = "socket";
  process.env.LUVUS_BIN_PATH = "luvus-test";
  const handlers = new Map<string, Handler>();
  const calls: Call[] = [];
  const intervals = new Map<number, () => void>();
  let nextTimer = 1;
  globalThis.setInterval = ((fn: () => void, ms: number) => {
    assert.equal(ms, 60_000);
    const id = nextTimer++;
    intervals.set(id, fn);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: number) => { intervals.delete(id); }) as typeof clearInterval;
  const ctx = {
    mode: opts.mode ?? "tui",
    isIdle: () => opts.idle ?? true,
    sessionManager: { getSessionId: () => "session-1" },
  };
  const pi = {
    on: (event: string, handler: Handler) => { handlers.set(event, handler); return () => handlers.delete(event); },
    exec: async (command: string, args: string[], options: { timeout: number }) => {
      const call = { command, args, options };
      calls.push(call);
      return opts.exec?.(call) ?? { code: 0, killed: false, stdout: "", stderr: "" };
    },
  };
  luvusPi(pi as any);
  async function emit(name: string) {
    const response = handlers.get(name)?.({ type: name }, ctx);
    await response;
    await flush();
  }
  function tick() { for (const cb of intervals.values()) cb(); }
  return { calls, handlers, intervals, ctx, emit, tick };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
const statuses = (calls: Call[]) => calls.filter(c => c.args[1] === "report").map(c => c.args[c.args.indexOf("--status") + 1]);

test("gating and no factory timer/process", async () => {
  const off = harness({ enabled: false });
  assert.equal(off.handlers.size, 0);
  assert.equal(off.intervals.size, 0);
  const rpc = harness({ mode: "rpc" });
  await rpc.emit("session_start");
  await rpc.emit("agent_start");
  assert.equal(rpc.calls.length, 0);
  assert.equal(rpc.intervals.size, 0);
});

test("initial idle, working, done only at settlement; CLI protocol", async () => {
  const h = harness();
  assert.equal(h.intervals.size, 0);
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("agent_end");
  await h.emit("agent_settled");
  assert.deepEqual(statuses(h.calls), ["idle", "working", "done"]);
  const call = h.calls[0];
  assert.equal(call.command, "luvus-test");
  assert.deepEqual(call.args.slice(0, 4), ["agent", "report", "pane-1", "--source"]);
  assert.equal(call.args[call.args.indexOf("--session") + 1], "session-1");
  assert.equal(call.args[call.args.indexOf("--ttl") + 1], "300");
  assert.equal(call.options.timeout, 5_000);
  const seq = h.calls.map(c => Number(c.args[c.args.indexOf("--sequence") + 1]));
  assert.ok(seq[0] < seq[1] && seq[1] < seq[2]);
  await h.emit("session_shutdown");
});

test("reloading active session starts working and releases last", async () => {
  const h = harness({ idle: false });
  await h.emit("session_start");
  assert.deepEqual(statuses(h.calls), ["working"]);
  await h.emit("session_shutdown");
  await h.emit("session_shutdown");
  assert.equal(h.calls.filter(c => c.args[1] === "release").length, 1);
  assert.equal(h.intervals.size, 0);
  h.tick();
  assert.equal(h.calls.at(-1)?.args[1], "release");
});

test("overlapping UI prompts restore working then done", async () => {
  const h = harness();
  await h.emit("session_start");
  await h.emit("agent_start");
  await h.emit("ui_prompt_start");
  await h.emit("ui_prompt_start");
  await h.emit("agent_settled");
  await h.emit("ui_prompt_end");
  await h.emit("ui_prompt_end");
  assert.deepEqual(statuses(h.calls), ["idle", "working", "blocked", "done"]);
  await h.emit("session_shutdown");
});

test("failure is retryable; heartbeat renews unchanged status", async () => {
  let attempt = 0;
  const h = harness({ exec: async () => ({ code: ++attempt === 1 ? 1 : 0, killed: false }) });
  const error = console.error;
  console.error = () => {};
  try {
    await h.emit("session_start");
    h.tick();
    await flush();
    h.tick();
    await flush();
    assert.deepEqual(statuses(h.calls), ["idle", "idle", "idle"]);
    await h.emit("session_shutdown");
  } finally { console.error = error; }
});

test("report timeout is retried at the next heartbeat", async () => {
  let attempt = 0;
  const h = harness({ exec: async () => {
    if (++attempt === 1) throw new Error("simulated timeout");
    return { code: 0, killed: false };
  } });
  const error = console.error;
  console.error = () => {};
  try {
    await h.emit("session_start");
    h.tick();
    await flush();
    assert.deepEqual(statuses(h.calls), ["idle", "idle"]);
    await h.emit("session_shutdown");
  } finally { console.error = error; }
});

test("session restart updates session ID and can reconstruct running state", async () => {
  const h = harness({ idle: false });
  await h.emit("session_start");
  await h.emit("session_shutdown");
  h.ctx.sessionManager.getSessionId = () => "session-2";
  await h.emit("session_start");
  assert.deepEqual(statuses(h.calls), ["working", "working"]);
  assert.equal(h.calls[2].args[h.calls[2].args.indexOf("--session") + 1], "session-2");
  assert.equal(h.intervals.size, 1);
  await h.emit("session_shutdown");
});

test("release retries once on failure and shutdown remains bounded", async () => {
  let releases = 0;
  const h = harness({ exec: async call => ({
    code: call.args[1] === "release" && ++releases === 1 ? 1 : 0,
    killed: false,
  }) });
  await h.emit("session_start");
  await h.emit("session_shutdown");
  assert.equal(releases, 2);
  assert.deepEqual(h.calls.map(c => c.args[1]), ["report", "release", "release"]);
});

test("queued report cannot overtake release; no resurrection after shutdown", async () => {
  let resolve!: (value: any) => void;
  const pending = new Promise<any>(r => { resolve = r; });
  const h = harness({ exec: call => call.args[1] === "report" ? pending : Promise.resolve({ code: 0 }) });
  await h.emit("session_start");
  await h.emit("agent_start");
  const shutdown = h.emit("session_shutdown");
  await flush();
  assert.equal(h.calls.length, 1);
  resolve({ code: 0 });
  await shutdown;
  assert.deepEqual(h.calls.map(c => c.args[1]), ["report", "release"]);
  await h.emit("agent_start");
  assert.equal(h.calls.length, 2);
});
