# pi-timestamp

A [pi](https://github.com/earendil-works/pi) package (single extension) that
records, for each exchange, when the message was sent, when the LLM finished
responding, and how long the LLM turn took — as an inline block in the
conversation.

## What it does

- On each incoming message (`input` event) it records the send time.
- On each LLM response it measures the turn duration (`agent_start` →
  `agent_end`).
- It injects an inline **custom message** into the session after every
  exchange, e.g.:

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

## How it stays loop-free

`pi.sendMessage()` only persists a display-only block *without* triggering a new
LLM turn when the agent is idle. During `agent_end` the session is still
streaming, so the extension **queues** each block and flushes it once the agent
is idle — on a deferred tick, at the next `input`, and at `session_shutdown`
(which covers the final turn and `-p` single-shot runs).

## Layout

```
package.json                     # pi package manifest (pi.extensions -> ./extensions)
extensions/timestamp-logger.ts   # the extension
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
