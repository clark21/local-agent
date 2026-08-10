#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"method":"initialize"'*)
      printf '%s\n' '{"id":1,"result":{"userAgent":"fake"}}'
      ;;
    *'"method":"thread/start"'*)
      printf '%s\n' '{"id":2,"result":{"thread":{"id":"thread-test"}}}'
      ;;
    *'"method":"turn/start"'*)
      printf '%s\n' '{"id":3,"result":{"turn":{"id":"turn-test"}}}'
      printf '%s\n' '{"id":900,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread-test","turnId":"turn-test","itemId":"item-test","command":"npm test","cwd":"/tmp"}}'
      ;;
    *'"id":900,"result":{"decision":"accept"}'*)
      printf '%s\n' '{"method":"item/completed","params":{"threadId":"thread-test","turnId":"turn-test","item":{"type":"agentMessage","id":"answer","text":"completed"}}}'
      printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-test","turn":{"id":"turn-test","status":"completed","error":null}}}'
      ;;
  esac
done
