# global-todo — global todo list for pi

A shared task store every pi session can use, plus an hourly headless worker
that does the work when the local 27B model is free.

## How it works

- **Add**: any session runs
  `node ~/.pi/agent/skills/global-todo/scripts/taskctl.mjs add "do the thing" --cwd /path`,
  or you text yourself **`@task do the thing`** on iMessage (the pi-imessage
  extension handles `@task` and replies with a confirmation — it never reaches
  the agent, so it can't contaminate a session's context).
- **Run**: a launchd job (`com.piagent.pi-todo-loop`) wakes the `global-todo`
  skill every hour. If no pi agent is using the local model (checked via the
  MTPLX admin API), it claims the oldest pending task and launches a detached
  headless `pi -p` worker with a fixed workdir.
- **Finish**: the worker writes a summary
  (`~/.pi/agent/todos/summaries/<id>-r<n>-<stamp>.md`) and notifies you on
  iMessage. The loop reaps crashed/overrun workers hourly and notifies on
  failures too.

## Where things live

| Thing | Path |
|---|---|
| Tasks (source of truth) | `~/.pi/agent/todos/tasks.json` |
| Summaries | `~/.pi/agent/todos/summaries/` |
| Worker logs | `~/.pi/agent/todos/logs/` |
| Worker workdirs | `~/.pi/agent/todos/work/<id>/` |
| iMessage outbox | `~/.pi/agent/todos/outbox/` |
| Loop trace | `~/.pi/agent/todos/loop.log` |

## Useful commands

```bash
TC="node $HOME/.pi/agent/skills/global-todo/scripts/taskctl.mjs"
$TC list                          # open todos
$TC list --status done            # finished
$TC show T0003
$TC release T0003                 # in-progress → pending
$TC fail T0003 --error "why"      # mark failed
$TC status                        # counts
$TC notify self "hello"           # queue an iMessage

L="$HOME/.pi/agent/skills/global-todo/scripts/loop.mjs"
node $L --status                  # queue + model busy state
node $L --force                   # run the loop now, skipping the busy gate
tail -f $HOME/.pi/agent/todos/loop.log
```

## Safety

- One headless worker at a time (single local model).
- Busy gate skips launch if any pi session is in-flight or active in the last
  2 minutes; if the MTPLX server is down, the loop does nothing.
- A worker killed by macOS (code 137) is auto-retried on the next run — its
  `work/<id>/` dir and previous summaries persist, so a re-run continues.
- Tuning via env in the launchd plist: `PI_TODO_MAX_RUNTIME_H` (6),
  `PI_TODO_ACTIVE_WINDOW_S` (120).

## Remove

```bash
sh ~/.pi/agent/skills/global-todo/install-loop.sh --remove
rm -rf ~/.pi/agent/todos   # only if you don't want the data
```

The pi-imessage `@task` handler keeps working after removal (it just gets a
store error instead of a confirmation).