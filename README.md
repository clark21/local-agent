# Telegram Codex Agent

A local NestJS service that receives tasks through Telegram and runs them with
Codex inside explicitly allowlisted project directories. It is intended for
small, trusted internal teams and personal development machines.

The Telegram bot is only the remote control. The service, Codex process,
project files, commands, and SQLite database all remain on the machine running
this application.

## Features

- Telegram numeric user-ID allowlist
- Explicit repository allowlist
- Persistent Codex conversation per Telegram chat and repository
- `workspace-write` filesystem sandbox
- Telegram approve/reject controls for Codex approval requests
- Approval timeout with fail-closed rejection
- Codex network access disabled by default
- One active task per chat
- Task timeout and cancellation
- Progress updates and chunked final responses
- Local SQLite task audit log
- Native Node.js and Docker startup options

## How it works

```text
Telegram user
    |
    v
Telegram Bot API (long polling)
    |
    v
NestJS service on the local machine
    |-- verifies the Telegram numeric user ID
    |-- selects an allowlisted repository
    |-- restores the chat's saved Codex thread
    v
Codex app-server -> local Codex process -> selected workspace
    |
    v
Progress and final response returned to Telegram
```

The service uses long polling, so it does not require a public HTTP endpoint,
port forwarding, or a webhook.

## Security warning

This application provides remote code execution by design. A stolen bot token,
an incorrectly configured allowlist, or an unsafe project can expose the host
machine.

Before distributing or running it:

- Create a separate Telegram bot for each installation or trusted team.
- Add only verified numeric Telegram user IDs.
- Never commit `.env`, the SQLite database, or Codex credentials.
- Allowlist only the project directories the bot genuinely needs.
- Prefer a dedicated operating-system account, VM, or container.
- Do not mount a home directory or other broad filesystem location as a project.
- Review local project instructions and scripts before allowing Codex to run them.

Codex runs with `workspace-write`, the `untrusted` approval policy, and agent
network access disabled by default. When Codex app-server requests approval for a command
or file change, the bot pauses the turn and shows Approve once, Approve session,
Reject, and Cancel action buttons. An unanswered prompt is rejected after the
configured timeout.

Approval prompts are not a secret-file boundary. Ordinary reads inside an
allowlisted repository may not trigger an approval, including reads of `.env`
files. Keep production secrets outside agent-accessible workspaces. The service
filters its child-process environment so its Telegram token and application
configuration are not inherited by Codex. It instructs Codex not to access
secret files, but that instruction is defense in depth rather than a hard
per-file control. The runtime's `workspace-write` policy does not
provide per-file read exclusions; keep sensitive files outside allowlisted
repositories.

## Prerequisites

- Linux, macOS, or Windows with a supported Node.js environment
- Node.js 20 or newer
- npm 10 or newer
- A Telegram account
- A Telegram bot token created by the official `@BotFather`
- A working Codex authentication session on the host
- At least one local project directory

Check the local tools:

```bash
node --version
npm --version
```

The project includes the official Codex CLI package and uses its app-server
protocol for interactive approvals.

## 1. Download and install

Clone or copy this repository onto the machine that will execute the tasks:

```bash
git clone <your-internal-repository-url>
cd telegram-codex-agent
npm ci
npx codex --version
```

Use `npm install` instead of `npm ci` only when intentionally updating the
dependency lockfile.

## 2. Create a Telegram bot

1. Open Telegram and start a conversation with the official `@BotFather`.
2. Send `/newbot`.
3. Choose a display name and a unique username ending in `bot`.
4. Copy the token returned by BotFather.
5. Treat the token like a password. Do not send it in chat or commit it.

A token generally resembles this shape:

```text
1234567890:AAExampleOnlyDoNotUse
```

If a token is exposed, revoke it with BotFather and generate a replacement.

## 3. Find the permitted Telegram user IDs

The allowlist uses immutable numeric Telegram user IDs, not `@usernames`.

One method that uses Telegram's own Bot API is:

1. Send any message to the newly created bot.
2. Temporarily set the bot token in the current terminal:

   ```bash
   export TELEGRAM_BOT_TOKEN='paste-token-here'
   ```

3. Request the bot's pending updates:

   ```bash
   curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates"
   ```

4. Find `message.from.id` in the JSON response. That integer is the sender's
   numeric user ID.
5. Repeat for each coworker who should have access.
6. Clear the temporary shell variable:

   ```bash
   unset TELEGRAM_BOT_TOKEN
   ```

Verify every ID with its owner before adding it. Avoid relying only on a
display name or username.

## 4. Authenticate Codex

Sign in on the same operating-system account that will run this service:

```bash
npx codex login
```

Confirm that Codex can access a test repository before starting the Telegram
service:

```bash
cd /absolute/path/to/a/test-project
npx codex
```

Exit after a simple read-only test. Authentication belongs to the local OS
account; do not copy another employee's credential directory into a shared
machine without an approved credential-management process.

## 5. Configure the application

Create the local environment file:

```bash
cp .env.example .env
chmod 600 .env
```

Edit `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=1234567890:replace-with-real-token
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
REPOSITORIES_JSON={"web-app":"/home/alice/projects/web-app","api":"/home/alice/projects/api"}
DEFAULT_REPOSITORY=web-app
DATABASE_PATH=./data/agent.db
CODEX_MODEL=
CODEX_PATH=codex
CODEX_NETWORK_ACCESS=false
CODEX_SANDBOX_MODE=workspace-write
CODEX_APPROVAL_POLICY=untrusted
TASK_TIMEOUT_MS=1800000
APPROVAL_TIMEOUT_MS=300000
MAX_MESSAGE_LENGTH=12000
```

### Environment variable reference

| Variable | Required | Meaning |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Yes | Secret token issued by BotFather. |
| `TELEGRAM_ALLOWED_USER_IDS` | Yes | Comma-separated numeric Telegram user IDs. |
| `REPOSITORIES_JSON` | Yes | JSON object mapping short names to absolute project paths. |
| `DEFAULT_REPOSITORY` | No | Initial repository; defaults to the first configured entry. |
| `DATABASE_PATH` | No | SQLite file; defaults to `./data/agent.db`. |
| `CODEX_MODEL` | No | Explicit Codex model. Empty uses the local Codex default. |
| `CODEX_PATH` | No | Codex CLI executable; defaults to `codex`. |
| `CODEX_NETWORK_ACCESS` | No | Set to `true` to allow outbound network access for Codex turns; missing or invalid values fall back to `false`. |
| `CODEX_SANDBOX_MODE` | No | Codex filesystem sandbox: `read-only`, `workspace-write`, or `danger-full-access`; missing or invalid values fall back to `read-only`. |
| `CODEX_APPROVAL_POLICY` | No | Codex approval policy: `untrusted`, `on-request`, or `never`; missing or invalid values fall back to `untrusted`. |
| `TASK_TIMEOUT_MS` | No | Maximum turn duration; defaults to 30 minutes. |
| `APPROVAL_TIMEOUT_MS` | No | Approval lifetime; defaults to 5 minutes, then rejects. |
| `MAX_MESSAGE_LENGTH` | No | Maximum accepted prompt length; defaults to 12,000 characters. |

Repository keys may contain letters, numbers, `_`, and `-`. Every repository
path must be absolute. Telegram users can select only keys present in this map.

JSON must remain valid and normally fits on one line. For example:

```dotenv
REPOSITORIES_JSON={"agent":"/home/alice/projects/agent"}
```

On Windows, escape backslashes inside JSON or use forward slashes:

```dotenv
REPOSITORIES_JSON={"agent":"C:/Users/Alice/Projects/agent"}
```

## 6. Build and verify

Run all local checks:

```bash
npm run lint
npm run typecheck
npm test -- --runInBand
npm run build
```

All commands should exit successfully before deployment.

## 7. Start the agent

Start the compiled service:

```bash
npm start
```

The expected startup messages include:

```text
Telegram long polling started
Telegram Codex agent is running
```

Open the bot in Telegram and send:

```text
/status
```

Then try a low-risk task:

```text
Inspect this repository and summarize its purpose. Do not modify files.
```

For an approval-flow test, ask Codex to run a command that requires approval.
The Telegram prompt shows the exact command, working directory, and Codex reason
when available. Only the Telegram user who started the task can press its
buttons. Every decision is written to the `approval_audit` SQLite table.

Stop the foreground service with `Ctrl+C`.

For local development with automatic rebuilds:

```bash
npm run start:dev
```

Do not run the development and production processes simultaneously with the
same bot token; Telegram updates may be consumed by either process.

## Telegram commands

| Command | Behavior |
| --- | --- |
| `/repo` | Lists allowlisted repositories and shows the selected one. |
| `/repo <name>` | Selects a repository and starts a fresh Codex thread. |
| `/threads` | Lists recent threads for the selected repository with resume buttons. |
| `/new` | Clears the saved thread for a fresh conversation. |
| `/status` | Shows the current repository and active task state. |
| `/cancel` | Requests cancellation of the active Codex turn. |
| `/help` | Displays command help. |
| Plain text | Runs the message as a Codex task. |

While a task is running, meaningful progress updates are appended to the chat.
Only the newest progress message includes a **✕ Cancel task** button, keeping
the active control at the bottom of the conversation. The button is removed
from the previous update before the next one is sent. Only the user who started
the task can use it. The button requests the same cancellation as `/cancel` and
disappears when the task ends.

Thread IDs are stored in SQLite. Follow-up messages continue the same Codex
conversation, including after a service restart, until `/new` is used or the
repository is changed. `/threads` queries Codex's local history, filters it to
the selected repository, and displays up to ten recent threads. Only the user
who requested that list may select one, and its buttons expire after the
configured approval timeout.

## Telegram Bot API limits

Telegram applies several limits that affect this service:

| Limit                                                   | Effect on this service                                                                                                                                                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4,096 characters per text message                       | Final Codex responses are already split into chunks of at most 4,000 characters. A prompt typed directly in Telegram is also practically limited to one Telegram message, even if `MAX_MESSAGE_LENGTH` is higher. |
| About 1 outgoing message per second in one private chat | Short bursts may succeed, but sustained faster delivery can return HTTP `429 Too Many Requests`.                                                                                                                  |
| 20 outgoing messages per minute in one group            | Progress messages can currently be created every 2.5 seconds, which could reach 24 messages per minute and exceed this limit.                                                                                     |
| About 30 outgoing messages per second across the bot    | Several active chats or a broadcast can exceed the free global rate. Paid broadcasts can raise the broadcast limit, but are unnecessary for normal small-team use.                                                |
| One active Codex task per chat in this application      | This is an application safeguard, not a Telegram limit. Different chats can still run concurrently and contribute to the bot-wide rate.                                                                           |

When a rate limit is exceeded, Telegram normally returns a `429` response with
a `retry_after` value. The current implementation does not have a shared
outgoing queue or automatic retry policy, so a throttled progress update or
response chunk may fail.

For the intended personal or small trusted-team deployment, these limits are
unlikely to matter during ordinary private-chat use. They become more relevant
in busy groups or with many simultaneous users. See Telegram's official
[Bots FAQ](https://core.telegram.org/bots/faq) and
[Bot API documentation](https://core.telegram.org/bots/api) for the current
limits.

## Running continuously with systemd

For a Linux workstation or always-on internal machine, create a service file at
`/etc/systemd/system/telegram-codex-agent.service`:

```ini
[Unit]
Description=Telegram Codex Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=codex-agent
WorkingDirectory=/opt/telegram-codex-agent
EnvironmentFile=/opt/telegram-codex-agent/.env
ExecStart=/usr/bin/node /opt/telegram-codex-agent/dist/main.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Adjust the user, directory, and Node.js path for the installation. The service
user must own or have the intended write permissions on each configured
repository and must have its own Codex authentication.

When systemd starts `node` directly, set `CODEX_PATH` in `.env` to the absolute
local executable if `codex` is not on the service user's PATH:

```dotenv
CODEX_PATH=/opt/telegram-codex-agent/node_modules/.bin/codex
```

After reviewing the service file:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now telegram-codex-agent
sudo systemctl status telegram-codex-agent
```

View logs with:

```bash
journalctl -u telegram-codex-agent -f
```

## Docker

Docker is optional. Native host execution is simpler because Codex needs access
to both the selected workspaces and its authentication state.

Before using Docker:

1. Mount every project at the same container path used by
   `REPOSITORIES_JSON`.
2. Make Codex authentication available to the container's `node` user.
3. Never mount an entire home directory as writable.
4. Review the commented examples in `docker-compose.yml`.

Example environment value for a container mount:

```dotenv
REPOSITORIES_JSON={"web-app":"/workspaces/web-app"}
```

Start and inspect the container:

```bash
docker compose up --build -d
docker compose logs -f agent
```

Stop it with:

```bash
docker compose down
```

## Data and backups

Runtime state is stored under `data/` by default:

- `agent.db` contains selected repositories, Codex thread IDs, prompts, task
  statuses, truncated results, and approval decisions.
- SQLite may create `agent.db-wal` and `agent.db-shm` while running.

The database may contain source-related or confidential prompt content. Protect
it accordingly. Stop the service before copying the database for a simple
backup, or use a SQLite-aware backup process.

To intentionally reset all conversation and audit state, stop the service and
move the database files to a protected backup location. Do not delete them while
the service is running.

## Updating

After pulling a reviewed version:

```bash
npm ci
npm run lint
npm run typecheck
npm test -- --runInBand
npm run build
```

Restart the process manager or systemd unit afterward. Review dependency,
configuration, and sandbox changes before deploying an update.

## Troubleshooting

### The bot does not reply

- Confirm the process is running and has internet access to Telegram.
- Confirm the token came from the correct BotFather bot.
- Confirm the sender's numeric ID is in `TELEGRAM_ALLOWED_USER_IDS`.
- Ensure another process is not polling the same bot token.
- Inspect application logs for `Rejected Telegram user` or Telegram API errors.

### Startup reports a missing environment variable

Confirm `.env` exists in the application working directory. Check that
`REPOSITORIES_JSON` is valid JSON and that every path is absolute.

### Codex authentication fails

- Run `npx codex login` as the same OS user that runs the service.
- Test Codex interactively from one configured repository.
- Under systemd or Docker, verify that the runtime user receives the intended
  credential state and environment.

### A task cannot install dependencies or use the internet

Codex agent network access is disabled unless `CODEX_NETWORK_ACCESS=true`.
Approving a command does not automatically grant network access. Enable it only
after reviewing the security impact.

### An approval button says it expired

Approval prompts expire after `APPROVAL_TIMEOUT_MS`, are cleared when a task
ends, and do not survive a bot restart. All of these cases reject the action.
Only the Telegram user who initiated that task can answer its prompt.

### A task cannot access another directory

This is expected unless the directory is inside the selected repository. Add a
new, narrowly scoped repository entry only after reviewing the security impact.

### `/cancel` takes time

Cancellation requests abort the Codex turn, but a child process may require a
short period to exit. Check `/status` and the local service logs.

### SQLite cannot open the database

Ensure the service user can create and write the configured database directory.
For Docker, verify ownership and permissions of the `./data` bind mount.

## Development commands

```bash
npm run start:dev     # watch mode
npm run lint          # ESLint
npm run typecheck     # TypeScript without emitting files
npm test              # Jest tests
npm run build         # production build
npm start             # run compiled application
```

## MVP limitations

- Telegram text messages only; files, images, voice notes, and replies are not
  passed to Codex.
- Command and file-change approvals are supported; network access is configured
  globally for agent turns rather than granted per command.
- One application process; active-task coordination is in memory.
- No per-user role system beyond the global Telegram user-ID allowlist.
- Prompts and results are stored locally without application-level encryption.
- Telegram is the only messaging adapter.

## TODO

- [ ] Throttle final-response chunks instead of sending them in an immediate
      burst.
- [ ] Honor Telegram `429` responses and retry after the provided `retry_after`
      delay with bounded backoff and jitter.
- [ ] Add a per-chat outgoing queue that enforces private-chat and group rate
      limits.
- [ ] Add a shared bot-wide limiter below Telegram's free global rate.
- [ ] Coalesce or discard stale progress updates waiting to be delivered.
- [ ] Prioritize approval prompts and final answers over optional progress
      updates.
- [ ] Add structured logs or metrics for queue depth, retries, discarded
      progress, and `429` responses.
- [ ] Send unusually long responses as text files rather than many consecutive
      messages.

## Internal distribution checklist

- [ ] Replace `<your-internal-repository-url>` with the real repository URL.
- [ ] Decide who owns and rotates the Telegram bot token.
- [ ] Confirm every permitted Telegram numeric ID out of band.
- [ ] Review every allowlisted project path.
- [ ] Choose a dedicated OS account or container boundary.
- [ ] Authenticate Codex for that runtime account.
- [ ] Run lint, type-check, tests, and build.
- [ ] Send a read-only test task before allowing edits.
- [ ] Document who monitors logs and audit data.
- [ ] Establish an update and incident-response process.

## References

- [Codex app-server protocol](https://learn.chatgpt.com/docs/app-server)
- [Codex sandboxing](https://learn.chatgpt.com/codex/sandboxing)
- [Codex agent approvals and security](https://learn.chatgpt.com/codex/agent-approvals-security)
