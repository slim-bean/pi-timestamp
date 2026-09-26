# pi-timestamp

A [pi](https://github.com/earendil-works/pi) package (single extension) that
records, for each exchange, when the message was sent, when the LLM finished
responding, and how long the LLM turn took — as an inline block in the
conversation.

## What it does

- Records the incoming message time and measures the full exchange from the
  first `agent_start` to `agent_settled`, including retries, recovery, and
  automatic continuations. Queued/steering input does not reset the clock.
- While running in the TUI, adds an increasing timer to Pi's **Working
  indicator**: `Working… · 1m 23s`, keeping the normal animated spinner.
  It refreshes once per second and restores the default label when the exchange
  settles. No extra widget or footer line is added.
  Retry/compaction indicators keep their own labels; elapsed time continues
  counting and reappears when Pi returns to Working.
- Injects one inline **custom message** into the session after the whole
  exchange settles (including stopped/failed exchanges), e.g.:

  ```
  ⏱ 2026-07-07 07:03:25 EDT → LLM 2026-07-07 07:03:30 EDT · turn took 4.8s
  ```

- Because it's a real session entry, the timing:
  - shows in the TUI transcript (with a custom renderer; expand it to see the
    UTC ISO timestamps and exact millisecond duration), and
  - is included in `/export` (HTML) and `/share` output.
- The timing blocks are stripped from the LLM context (via the `context` event),
  so they never pollute the conversation the model sees.

Duration formatting rolls up by magnitude: `850ms`, `5.1s`, `1m 30s`, or
`2h 2m 5s`.

## Timezones

Times are **always stored as UTC** (epoch milliseconds, timezone-agnostic). Only
the *display* is localized.

Configure the display timezone with the `PI_TIMESTAMP_TZ` environment variable:

| Value | Effect |
|-------|--------|
| unset or `local` | system timezone (default) |
| `UTC` | UTC |
| any IANA name, e.g. `America/Los_Angeles`, `Asia/Tokyo` | that zone |

An unrecognized value falls back to the system timezone.

```bash
PI_TIMESTAMP_TZ=UTC pi
```

## Lifecycle and compatibility

Uses Pi's `agent_settled` event, not `agent_end`: the latter can fire multiple
times during one exchange as Pi retries errors. The final block is sent with
`{ triggerTurn: false }`, so it cannot start another LLM turn. Requires Pi with
`agent_settled` support; developed and tested against Pi 0.87.1.

Print (`-p`), JSON, and RPC modes still record the final timestamp, without
customizing the Working indicator. Refresh timers and timing state are cleared
on session changes, reload, and shutdown. The live timer itself is not persisted.

The live timer uses `ctx.ui.setWorkingMessage()`, a shared label rather than an
append-only slot. Other extensions customizing this label can conflict.

## Layout

```
package.json                    # pi package manifest (pi.extensions -> ./extensions)
extensions/timestamp-logger.ts   # the extension
tests/timestamp-logger.test.mjs   # lifecycle and live-timer regression tests
```

## Development

With Node.js 22.19+ (native TypeScript support):

```bash
npm install
npm test
npm run typecheck
```

## Install / use

Install as a pi package (global or project-local):

```bash
pi install /Users/ewelch/projects/pi-timestamp        # global
pi install -l /Users/ewelch/projects/pi-timestamp     # project-local
```

Or reference the folder directly for a single run:

```bash
pi -e /Users/ewelch/projects/pi-timestamp
```

> Note: because this is a package, do not also drop the file in a project's
> `.pi/extensions/` — that would load it twice and produce duplicate blocks.
