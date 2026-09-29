import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

// Records input/finish timestamps and total duration for each settled exchange.
// Adds total/activity timers to Pi's Working indicator and persists one message
// so the final timing appears in the TUI transcript and `/export` / `/share`.
//
// The injected messages are stripped from the LLM context (via the `context`
// event) so they never pollute the conversation the model sees.
//
// `agent_end` can be followed by retries/recovery/continuations. Keep one
// start time until `agent_settled`, then explicitly send without a new turn.

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
  let lastActivityAt: number | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

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

  // Live clocks use whole seconds, unlike the more precise persisted duration.
  const fmtElapsed = (ms: number) => {
    const seconds = Math.floor(Math.max(0, ms) / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    let elapsed = `${seconds % 60}s`;
    if (minutes > 0 || hours > 0) elapsed = `${minutes}m ${elapsed}`;
    if (hours > 0) elapsed = `${hours}h ${elapsed}`;
    return elapsed;
  };

  const reset = (ctx: ExtensionContext) => {
    humanAt = null;
    turnStart = null;
    lastActivityAt = null;
    if (refreshTimer !== undefined) {
      clearInterval(refreshTimer);
      refreshTimer = undefined;
      ctx.ui.setWorkingMessage();
    }
  };

  // Track agent/tool events, not redraws or our own custom timing messages.
  // Only record the time here: the 1Hz refresh avoids repainting for every token.
  const markActivity = () => {
    if (turnStart !== null) lastActivityAt = Date.now();
  };
  const markAssistantActivity = (event: { message: { role: string } }) => {
    if (event.message.role === "assistant") markActivity();
  };
  pi.on("message_start", markAssistantActivity);
  pi.on("message_update", markAssistantActivity);
  pi.on("message_end", markAssistantActivity);
  pi.on("tool_execution_start", markActivity);
  pi.on("tool_execution_update", markActivity);
  pi.on("tool_execution_end", markActivity);

  // Queued/steering input must not replace the original exchange's timestamp.
  pi.on("input", async (event) => {
    if (event.source !== "extension" && turnStart === null) humanAt = Date.now();
    return { action: "continue" };
  });

  pi.on("agent_start", async (_event, ctx) => {
    // Automatic retries and continuations can start multiple low-level runs.
    if (turnStart !== null) return;
    turnStart = Date.now();
    lastActivityAt = turnStart;
    humanAt ??= turnStart;
    if (ctx.mode !== "tui") return;

    // Only customize the label; Pi owns the spinner, layout, and redraws.
    // Retry/compaction indicators retain their own labels while this counts on.
    const updateWorkingMessage = () => {
      if (turnStart === null) return;
      const now = Date.now();
      const elapsed = fmtElapsed(now - turnStart);
      const quiet = fmtElapsed(now - (lastActivityAt ?? turnStart));
      ctx.ui.setWorkingMessage(`Working… · ${elapsed} total · last activity ${quiet} ago`);
    };
    updateWorkingMessage();
    refreshTimer = setInterval(updateWorkingMessage, 1000);
    refreshTimer.unref();
  });

  // This is the final boundary, after automatic retries/recovery/queued work.
  pi.on("agent_settled", async (_event, ctx) => {
    if (turnStart === null) return;
    const llmAt = Date.now();
    const details: TimingDetails = {
      humanAt: humanAt ?? turnStart,
      llmAt,
      turnMs: Math.max(0, llmAt - turnStart),
    };
    reset(ctx);
    pi.sendMessage(
      {
        customType: CUSTOM_TYPE,
        content: `${fmtStamp(details.humanAt)} → LLM ${fmtStamp(llmAt)} · turn took ${fmtDuration(details.turnMs)}`,
        display: true,
        details,
      },
      { triggerTurn: false },
    );
  });

  // Never carry timing state or a refresh timer across sessions/reloads.
  pi.on("session_start", async (_event, ctx) => reset(ctx));
  pi.on("session_shutdown", async (_event, ctx) => reset(ctx));

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
