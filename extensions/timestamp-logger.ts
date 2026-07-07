import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

// Records a timestamp for each human message and each LLM response, plus how
// long the LLM turn took. After every exchange it injects an inline custom
// message into the session so the timing shows in the TUI transcript AND in
// `/export` / `/share` output.
//
// The injected messages are stripped from the LLM context (via the `context`
// event) so they never pollute the conversation the model sees.
//
// Delivery detail: `pi.sendMessage()` only persists a display-only block
// (without triggering another LLM turn) when the agent is idle. During
// `agent_end` the session is still "streaming", so injecting there would take
// the steer/follow-up path and loop forever. We therefore queue the block and
// flush it once the agent is idle (deferred tick, next `input`, or shutdown).

const CUSTOM_TYPE = "timestamp";

// Timezone used for DISPLAY only. Times are always stored as UTC epoch ms
// (timezone-agnostic). Configure the display zone via the PI_TIMESTAMP_TZ env
// var (IANA name like "America/New_York" or "UTC"). Unset or "local" uses the
// system timezone.
const rawTz = (process.env.PI_TIMESTAMP_TZ ?? "").trim();
const DISPLAY_TZ =
  rawTz === "" || rawTz.toLowerCase() === "local" ? undefined : rawTz;

const makeFormatter = (timeZone: string | undefined) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });

// Fall back to the system timezone if PI_TIMESTAMP_TZ is not a valid IANA name.
const stampFormatter = (() => {
  try {
    return makeFormatter(DISPLAY_TZ);
  } catch {
    return makeFormatter(undefined);
  }
})();

// e.g. "2026-07-07 06:55:10 PDT" — full date + time + timezone abbreviation.
const fmtStamp = (ms: number) => {
  const p = Object.fromEntries(
    stampFormatter.formatToParts(ms).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} ${p.timeZoneName}`;
};

type TimingDetails = {
  humanAt: number; // epoch ms (UTC) the human message was received
  llmAt: number; // epoch ms (UTC) the LLM finished responding
  turnMs: number; // duration of the LLM turn
};

export default function (pi: ExtensionAPI) {
  // Markers for the exchange currently in flight.
  let humanAt: number | null = null;
  let turnStart: number | null = null;

  // Timing blocks waiting to be persisted once the agent is idle.
  const pending: TimingDetails[] = [];

  // Human-friendly duration: ms, s, "Xm Ys", or "Xh Ym Zs".
  const fmtDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`;

    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    // Under a minute: keep one decimal for a little more precision.
    return `${(ms / 1000).toFixed(1)}s`;
  };

  // Persist any queued blocks, but only while idle so we never re-trigger the
  // agent loop.
  const flush = (ctx: ExtensionContext) => {
    if (pending.length === 0 || !ctx.isIdle()) return;
    for (const d of pending.splice(0)) {
      pi.sendMessage({
        customType: CUSTOM_TYPE,
        content: `${fmtStamp(d.humanAt)} → LLM ${fmtStamp(
          d.llmAt,
        )} · turn took ${fmtDuration(d.turnMs)}`,
        display: true,
        details: d,
      });
    }
  };

  // A human sent a message — remember when, and flush any leftover blocks from
  // the previous exchange (we're idle here, before the new turn starts).
  pi.on("input", async (event, ctx) => {
    if (event.source !== "extension") humanAt = Date.now();
    flush(ctx);
    return { action: "continue" };
  });

  // Mark the start of the LLM's work for duration measurement.
  pi.on("agent_start", async () => {
    turnStart = Date.now();
  });

  // The LLM finished — queue a timing block, then flush once idle.
  pi.on("agent_end", async (_event, ctx) => {
    const llmAt = Date.now();
    const turnMs = turnStart != null ? llmAt - turnStart : 0;
    pending.push({ humanAt: humanAt ?? llmAt, llmAt, turnMs });
    humanAt = null;
    turnStart = null;
    // Defer past the current streaming turn so sendMessage takes the
    // idle/no-trigger path and persists without looping.
    setTimeout(() => flush(ctx), 0);
  });

  // Ensure the final exchange's block is persisted before exit (covers `-p`).
  pi.on("session_shutdown", async (_event, ctx) => {
    flush(ctx);
  });

  // Keep our timing messages out of what the model sees.
  pi.on("context", async (event) => {
    const messages = event.messages.filter(
      (m) => !(m.role === "custom" && m.customType === CUSTOM_TYPE),
    );
    return { messages };
  });

  // Render the inline block nicely in the TUI (and it carries into exports).
  pi.registerMessageRenderer(CUSTOM_TYPE, (message, { expanded }, theme) => {
    const details = message.details as TimingDetails | undefined;
    let text = theme.fg("accent", "⏱ ") + message.content;

    if (expanded && details) {
      text +=
        "\n" +
        theme.fg(
          "dim",
          `  utc in:  ${new Date(details.humanAt).toISOString()}\n` +
            `  utc out: ${new Date(details.llmAt).toISOString()}\n` +
            `  turn:    ${details.turnMs}ms`,
        );
    }

    const box = new Box(0, 1, (t) => theme.bg("customMessageBg", t));
    box.addChild(new Text(text, 0, 0));
    return box;
  });
}
