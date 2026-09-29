import assert from "node:assert/strict";
import { test } from "node:test";
import timestampLogger from "../extensions/timestamp-logger.ts";

const START = Date.parse("2026-09-26T17:20:39Z");

function setup(t, mode = "tui") {
  let now = START;
  let workingMessage;
  const workingUpdates = [];
  const intervals = new Set();
  const handlers = new Map();
  const messages = [];
  const renderers = new Map();
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "setInterval", (callback, ms) => {
    assert.equal(ms, 1000);
    const timer = { callback, unref() { return this; } };
    intervals.add(timer);
    return timer;
  });
  t.mock.method(globalThis, "clearInterval", (timer) => intervals.delete(timer));
  const ctx = {
    mode,
    ui: {
      setWorkingMessage(message) {
        assert.equal(mode, "tui", "working label must not be customized in other modes");
        workingMessage = message;
        workingUpdates.push(message);
      },
    },
  };
  timestampLogger({
    on: (event, handler) => handlers.set(event, handler),
    sendMessage: (message, options) => messages.push({ ...message, options }),
    registerMessageRenderer: (type, renderer) => renderers.set(type, renderer),
  });
  return {
    emit: (type, data = {}) => handlers.get(type)?.({ type, ...data }, ctx),
    advance(ms) {
      now += ms;
      for (const timer of intervals) timer.callback();
    },
    get workingMessage() { return workingMessage; },
    workingUpdates,
    intervals,
    messages,
    renderers,
  };
}

test("one settled timestamp spans multiple failed runs and retry delays", async (t) => {
  const h = setup(t);
  await h.emit("input", { source: "interactive" });
  h.advance(100);
  await h.emit("agent_start");
  for (let i = 0; i < 4; i++) {
    h.advance(30_000);
    await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "error" }] });
    h.advance(2_000); // backoff remains part of the same exchange
    await h.emit("agent_start");
  }
  assert.equal(h.messages.length, 0);
  assert.equal(h.intervals.size, 1);
  assert.match(h.workingMessage, /2m 8s/);
  h.advance(10_000);
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] });
  await h.emit("agent_settled");
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0].details, {
    humanAt: START, llmAt: START + 138_100, turnMs: 138_000,
  });
  assert.deepEqual(h.messages[0].options, { triggerTurn: false });
  assert.equal(h.messages[0].display, true);
  assert.match(h.messages[0].content, /turn took 2m 18s$/);
  assert.equal(h.workingMessage, undefined);
  assert.equal(h.intervals.size, 0);
  await h.emit("agent_settled");
  assert.equal(h.messages.length, 1, "duplicate settlement is harmless");
});

test("live timer updates the Working label and restores the default on settlement", async (t) => {
  const h = setup(t);
  await h.emit("agent_start");
  assert.equal(h.workingMessage, "Working… · 0s total · last activity 0s ago");
  h.advance(1_000);
  assert.equal(h.workingUpdates.length, 2);
  assert.equal(h.workingMessage, "Working… · 1s total · last activity 1s ago");
  h.advance(82_000);
  assert.equal(h.workingMessage, "Working… · 1m 23s total · last activity 1m 23s ago");
  h.advance(3_600_000);
  assert.equal(h.workingMessage, "Working… · 1h 1m 23s total · last activity 1h 1m 23s ago");
  await h.emit("agent_settled");
  assert.equal(h.workingMessage, undefined);
  const updates = h.workingUpdates.length;
  h.advance(5_000);
  assert.equal(h.workingUpdates.length, updates, "settlement stops refreshes");
});

const activityEvents = [
  ["message_start", { message: { role: "assistant" } }],
  ...["text_delta", "thinking_delta", "toolcall_delta"].map((type) => [
    "message_update", {
      message: { role: "assistant" },
      assistantMessageEvent: { type, delta: "new output" },
    },
  ]),
  ["message_end", { message: { role: "assistant" } }],
  ["tool_execution_start", { toolCallId: "a", toolName: "bash" }],
  ["tool_execution_update", { toolCallId: "a", toolName: "bash", partialResult: {} }],
  ["tool_execution_end", { toolCallId: "a", toolName: "bash", result: {}, isError: false }],
];

for (const [event, data] of activityEvents) {
  test(`${data.assistantMessageEvent?.type ?? event} resets activity, not total elapsed time`, async (t) => {
    const h = setup(t);
    await h.emit("agent_start");
    h.advance(65_000);
    const updates = h.workingUpdates.length;
    await h.emit(event, data);
    assert.equal(h.workingUpdates.length, updates, "activity does not repaint per token");
    h.advance(0); // next refresh, without advancing the clock
    assert.equal(h.workingMessage, "Working… · 1m 5s total · last activity 0s ago");
    h.advance(5_000);
    assert.equal(h.workingMessage, "Working… · 1m 10s total · last activity 5s ago");
    await h.emit("agent_settled");
    assert.equal(h.messages[0].details.turnMs, 70_000);
  });
}

test("timer ticks, custom messages, input, and retry starts do not manufacture activity", async (t) => {
  const h = setup(t);
  await h.emit("agent_start");
  h.advance(10_000);
  await h.emit("message_update", { message: { role: "assistant" } });
  h.advance(10_000);
  await h.emit("input", { source: "interactive" });
  for (const role of ["user", "custom"]) {
    for (const event of ["message_start", "message_update", "message_end"]) {
      await h.emit(event, { message: { role, customType: "timestamp" } });
    }
  }
  await h.emit("agent_end");
  h.advance(2_000);
  await h.emit("agent_start");
  h.advance(3_000);
  assert.equal(h.workingMessage, "Working… · 25s total · last activity 15s ago");
  assert.equal(h.intervals.size, 1);
  await h.emit("agent_settled");
});

test("parallel tool activity uses the most recent update from any tool", async (t) => {
  const h = setup(t);
  await h.emit("agent_start");
  await h.emit("tool_execution_start", { toolCallId: "a" });
  h.advance(5_000);
  await h.emit("tool_execution_start", { toolCallId: "b" });
  h.advance(5_000);
  await h.emit("tool_execution_update", { toolCallId: "a" });
  h.advance(5_000);
  assert.equal(h.workingMessage, "Working… · 15s total · last activity 5s ago");
  await h.emit("tool_execution_end", { toolCallId: "b" });
  h.advance(1_000);
  assert.equal(h.workingMessage, "Working… · 16s total · last activity 1s ago");
  await h.emit("agent_settled");
});

test("activity outside an exchange is ignored and a new exchange starts fresh", async (t) => {
  const h = setup(t);
  for (const [event, data] of activityEvents) await h.emit(event, data);
  assert.deepEqual(h.workingUpdates, []);
  await h.emit("agent_start");
  h.advance(20_000);
  await h.emit("agent_settled");
  const updates = h.workingUpdates.length;
  for (const [event, data] of activityEvents) await h.emit(event, data);
  h.advance(60_000);
  assert.equal(h.workingUpdates.length, updates);
  await h.emit("agent_start");
  assert.equal(h.workingMessage, "Working… · 0s total · last activity 0s ago");
  h.advance(1_000);
  assert.equal(h.workingMessage, "Working… · 1s total · last activity 1s ago");
  await h.emit("agent_settled");
});

test("idle lifecycle events do not reset another extension's Working label", async (t) => {
  const h = setup(t);
  await h.emit("session_start");
  await h.emit("agent_settled");
  await h.emit("session_shutdown");
  assert.deepEqual(h.workingUpdates, []);
});

test("separate exchanges start fresh; queued input preserves the first timestamp", async (t) => {
  const h = setup(t);
  await h.emit("input", { source: "interactive" });
  await h.emit("agent_start");
  h.advance(5_000);
  await h.emit("input", { source: "interactive" });
  await h.emit("agent_start");
  h.advance(5_000);
  await h.emit("agent_settled");
  assert.equal(h.messages[0].details.humanAt, START);
  h.advance(1_000);
  await h.emit("input", { source: "interactive" });
  await h.emit("agent_start");
  h.advance(850);
  await h.emit("agent_settled");
  assert.deepEqual(h.messages[1].details, {
    humanAt: START + 11_000, llmAt: START + 11_850, turnMs: 850,
  });
  assert.match(h.messages[1].content, /850ms$/);
});

test("extension-triggered runs use the start time rather than the finish time", async (t) => {
  const h = setup(t);
  await h.emit("input", { source: "extension" });
  h.advance(1_000);
  await h.emit("agent_start");
  h.advance(5_100);
  await h.emit("agent_settled");
  assert.deepEqual(h.messages[0].details, {
    humanAt: START + 1_000, llmAt: START + 6_100, turnMs: 5_100,
  });
});

for (const mode of ["print", "json", "rpc"]) {
  test(`${mode} mode persists the final timestamp without creating UI timers`, async (t) => {
    const h = setup(t, mode);
    await h.emit("session_start");
    await h.emit("agent_start");
    h.advance(1_000);
    for (const [event, data] of activityEvents) await h.emit(event, data);
    await h.emit("agent_end");
    await h.emit("agent_settled");
    await h.emit("session_shutdown");
    assert.equal(h.messages.length, 1);
    assert.equal(h.intervals.size, 0);
    assert.equal(h.workingUpdates.length, 0);
  });
}

for (const event of ["session_start", "session_shutdown"]) {
  test(`${event} clears old state and disposes refresh timers idempotently`, async (t) => {
    const h = setup(t);
    await h.emit("agent_start");
    h.advance(10_000);
    await h.emit(event);
    await h.emit(event);
    assert.equal(h.workingMessage, undefined);
    assert.equal(h.intervals.size, 0);
    const updates = h.workingUpdates.length;
    h.advance(1_000);
    assert.equal(h.workingUpdates.length, updates, "reset stops refreshes");
    await h.emit("agent_settled");
    assert.equal(h.messages.length, 0);
    await h.emit("agent_start");
    h.advance(1_000);
    await h.emit("agent_settled");
    assert.equal(h.messages[0].details.turnMs, 1_000);
    assert.equal(h.messages[0].details.humanAt, START + 11_000);
  });
}

test("an aborted run still produces exactly one timestamp when settled", async (t) => {
  const h = setup(t);
  await h.emit("agent_start");
  h.advance(3_000);
  await h.emit("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] });
  await h.emit("agent_settled");
  await h.emit("session_shutdown");
  assert.equal(h.messages.length, 1);
  assert.equal(h.intervals.size, 0);
});

test("timing messages remain excluded from model context", async (t) => {
  const h = setup(t);
  const user = { role: "user", content: "hello" };
  const other = { role: "custom", customType: "other", content: "keep" };
  const result = await h.emit("context", { messages: [
    user, { role: "custom", customType: "timestamp", content: "timing" }, other,
  ] });
  assert.deepEqual(result.messages, [user, other]);
  assert.ok(h.renderers.has("timestamp"));
});
