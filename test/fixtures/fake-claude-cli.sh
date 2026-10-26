#!/usr/bin/env bash
set -euo pipefail

# Mirrors the real CLI's stream-json contract closely enough to catch
# integration regressions. --resume <id> selects failure scenarios.
args=" $* "
resume=""
mode=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --resume) resume="$2"; shift 2 ;;
    --permission-mode) mode="$2"; shift 2 ;;
    *) shift ;;
  esac
done

case "$mode" in
  manual|acceptEdits|auto|dontAsk|plan) ;;
  bypassPermissions)
    if [[ "$args" != *" --allow-dangerously-skip-permissions "* ]]; then
      echo 'Error: bypassPermissions needs --allow-dangerously-skip-permissions' >&2
      exit 1
    fi
    ;;
  *) echo "Error: invalid --permission-mode '$mode'" >&2; exit 1 ;;
esac

if [[ "$args" != *" --verbose "* ]]; then
  echo 'Error: When using --print, --output-format=stream-json requires --verbose' >&2
  exit 1
fi
if [[ "$args" != *" --permission-prompt-tool stdio "* ]]; then
  echo 'Error: permission prompts were not routed to stdio' >&2
  exit 1
fi
if [[ "$args" != *" --append-system-prompt Security policy: "* ]]; then
  echo 'Error: missing secret-file instructions' >&2
  exit 1
fi

case "$resume" in
  dead)
    # Close stdin, then ask for permission so the host's answer hits EPIPE.
    exec 0<&-
    printf '%s\n' '{"type":"control_request","request_id":"permission-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"npm test"}}}'
    sleep 0.5
    exit 3
    ;;
  missing-session)
    read -r _prompt
    echo "No conversation found with session ID: $resume" >&2
    printf '%s\n' "{\"type\":\"result\",\"subtype\":\"error_during_execution\",\"is_error\":true,\"session_id\":\"$resume\",\"errors\":[\"No conversation found with session ID: $resume\"]}"
    exit 1
    ;;
  multi-repo)
    read -r _prompt
    if [[ "$args" != *" --add-dir /tmp/web /tmp/docs "* ]]; then
      echo 'Error: additional repositories were not passed with --add-dir' >&2
      exit 1
    fi
    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"claude-session","result":"multi"}'
    cat >/dev/null
    exit 0
    ;;
  webfetch)
    read -r _prompt
    printf '%s\n' '{"type":"system","subtype":"init","session_id":"claude-session"}'
    printf '%s\n' '{"type":"control_request","request_id":"permission-1","request":{"subtype":"can_use_tool","tool_name":"WebFetch","input":{"url":"https://example.com","prompt":"summarize"}}}'
    read -r _response
    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"claude-session","result":"fetched"}'
    cat >/dev/null
    exit 0
    ;;
  report-mode)
    read -r _prompt
    printf '%s\n' "{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"claude-session\",\"result\":\"mode:$mode\"}"
    cat >/dev/null
    exit 0
    ;;
  error-result)
    read -r _prompt
    printf '%s\n' '{"type":"system","subtype":"init","session_id":"claude-session"}'
    printf '%s\n' '{"type":"result","subtype":"success","is_error":true,"session_id":"claude-session","result":"API Error: overloaded"}'
    cat >/dev/null
    exit 0
    ;;
esac

read -r _prompt
printf '%s\n' '{"type":"system","subtype":"init","session_id":"claude-session"}'
printf '%s\n' '{"type":"control_request","request_id":"permission-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"npm test","cwd":"/tmp"},"permission_suggestions":[]}}'
read -r response
if [[ "$response" != *'"behavior":"allow"'* ]]; then
  exit 2
fi
printf '%s\n' '{"type":"assistant","session_id":"claude-session","message":{"content":[{"type":"text","text":"completed"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"session_id":"claude-session","result":"completed"}'
# Like the real CLI, wait for the host to close stdin before exiting.
cat >/dev/null
