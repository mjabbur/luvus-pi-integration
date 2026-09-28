# Pi → Luvus state integration

Experimental, independent [Pi](https://github.com/earendil-works/pi) extension that reports the state of an interactive Pi session to [Luvus](https://github.com/RizRiyz/luvus). It does not change Luvus or Pi itself and is not an official upstream integration.

Validated locally with Pi **0.87.1**, Luvus **0.14.2** and Node.js **24** on Windows. Other versions and platforms have not been verified.

## Behavior

The extension reports `idle`, `working`, `blocked` (while waiting on a Pi extension UI prompt), and `done` (only after `agent_settled`). It sends ordered, leased reports through `pi.exec()` to the Luvus CLI, renews the lease every 60 seconds (TTL 300 seconds), and releases its source on session shutdown. Failed reports are retried at the next event or heartbeat; shutdown release has one bounded retry.

Reporting is enabled only when **all** of these conditions hold:

- `LUVUS_ENV=1`
- nonempty `LUVUS_PANE_ID` and `LUVUS_SOCKET_PATH`
- Pi runs in TUI mode (`ctx.mode === "tui"`)

The CLI executable is `LUVUS_BIN_PATH` if set, otherwise `luvus`. Reports use source `pi/extension`, kind `pi`, a monotonic sequence, and a session ID when available. No prompt or transcript is sent in state reports. The Luvus CLI inherits its environment; the extension does not open the socket directly.

`done` describes Pi's lifecycle; it does **not** prove that another agent received or acted on a message. Check the recipient's actual response separately. Forced termination or prolonged CLI failures can leave a lease in place until its TTL expires.

## Try it without installing

From this repository, start Pi inside a Luvus-managed terminal pane with:

```text
pi --extension ./src/luvus-pi.ts
```

Start a **new** Pi session; adding an extension file does not retroactively load it into an already-running session. The Luvus-managed pane must supply the required environment variables. See the [Pi extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md) for extension loading.

To enable automatic loading for future Pi sessions, review the code, then copy `src/luvus-pi.ts` to your Pi user extensions directory (`~/.pi/agent/extensions/`). Do not overwrite an existing file without backing it up. This is optional; it does not replace any other integration.

## Tests

Install **development** dependencies locally (review the lockfile before installing):

```text
npm ci --ignore-scripts
npm run typecheck
npm test
```

The tests simulate `pi.exec` and time: no Luvus server or pane is required. Coverage includes disabled/headless mode, working/done, UI prompts, retries, heartbeat, shutdown/release and ordered commands. A manual check on Pi 0.87.1 / Luvus 0.14.2 also observed `idle` → `working` → `done` alongside the actual model response; a separate no-model test confirmed `blocked`, heartbeat while blocked, return to `idle`, and release. Real network/CLI failure recovery has not been tested in a live pane.

## License

MIT; see [LICENSE](LICENSE).
