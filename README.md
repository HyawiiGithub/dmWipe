# dmWipe

Bulk-delete every message in a Discord DM or group DM — from the channel context menu or a
`/wipe` command. Self-throttles when Discord pushes back and automatically restarts until the
channel is genuinely empty.

Written for Vencord Plugins

## Features

- Deletes **every** message in a DM, at any age — yours or the other person's this is upto you.
- Works in group DMs as well as 1:1 DMs.
- **Auto-throttling.** Learns your account's real delete ceiling instead of guessing, and honours
  Discord's own `retry_after` on every 429.
- **Restart-forever supervisor.** A failed request can never end the run. It keeps sweeping until a
  full pass deletes nothing.
- Confirmation modal, progress toasts, and a full run report at the end.
- Cancellable mid-run via the context menu or by running `/wipe` again.
- Optional: keep pinned messages, or only delete your own.
- Individual REST deletes, so the 14-day bulk-delete limit doesn't apply.

## Install

1. Clone Vencord and install dependencies:

   ```sh
   git clone https://github.com/Vendicated/Vencord
   cd Vencord
   pnpm install
   pnpm inject
