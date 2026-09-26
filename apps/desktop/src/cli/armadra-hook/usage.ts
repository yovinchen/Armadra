/**
 * The command-surface constants.
 *
 * The browser part of `USAGE` and `BROWSER_VERBS` come from the runtime's verb
 * list (`core/browser/verb-spec.ts`, which imports nothing, so the hook stays
 * a small program); the rest is written out here.
 */

import { VERB_NAMES, browserUsage } from "../../core/browser/verb-spec.js";

/** Protocol version carried in every hook body. */
export const HOOK_PROTOCOL_VERSION = 1;

/**
 * Value of the `X-Armadra-Hook-Client` header. Bumped when the wire behaviour
 * of this client changes so the runtime can flag stale installs — this port
 * changes no wire behaviour at all, so it stays on the Rust client's number.
 */
export const HOOK_CLIENT_REVISION = "4";

/** Upper bound on the hook payload we are willing to buffer, in bytes. */
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

/** Reported by `--version`; the Rust client reports its crate version. */
export const CLIENT_VERSION = "0.1.0";

/** The context-link verbs the runtime exposes. */
export const CONTEXT_VERBS = [
  "list",
  "summary",
  "transcript",
  "terminal",
] as const;

/**
 * The controlled-browser verbs the runtime exposes (B01).
 *
 * The list is checked here as well as in the runtime so a typo costs a local
 * error line instead of a round trip and a refusal in the model's context.
 * It is the runtime's own list (`core/browser/verb-spec.ts`), not a copy.
 */
export const BROWSER_VERBS: readonly string[] = VERB_NAMES;

/**
 * Text printed by `--help` and by any usage error. The browser section is
 * generated from the verb list, so it cannot describe a flag or a verb the
 * runtime does not have (`verb-spec.test.ts`).
 */
export const USAGE = `armadra-hook — Armadra hook client

USAGE:
  armadra-hook <agentId>                       report a hook event (payload on stdin)
  armadra-hook context <verb> [options]        read a linked node's context
  armadra-hook canvas <verb> [--flag value]    drive the canvas
  armadra-hook browser <verb> [--flag value]   drive a linked browser node
  armadra-hook doctor                          diagnose the local hook endpoint

CONTEXT VERBS:
  list                      list the nodes linked to this one
  summary                   a <=2 KB digest of a linked node; read this first
  transcript [-n N]         the linked node's transcript, 20 entries by default
  terminal [-n N]           the linked node's terminal screen, 40 lines by default

CONTEXT OPTIONS:
  --node <name|id|title>    which linked node to read (defaults to the only link)
  -n, --lines <N>           entries for transcript (20), lines for terminal (40, max 200)
  --since                   transcript: only what is new since your last read
  --full --max-kb <N>       transcript: lift the 32 KB cap, up to 128 KB
  Every link has a read budget: 64 KB/minute and 1 MB/hour, then RATE_LIMITED.

CANVAS:
  help                      short collaboration guide (no provider configuration needed)
  post --to NAME --key KEY --body TEXT store a handoff for a linked agent
  inbox --limit 10 --after 0           read your pending messages without acknowledgement
  ack --id ID                         acknowledge one received message
  open-agent --agent ID [--task TEXT] [--title T] [--permission-mode M]
                                      [--model M] [--after ID]
                                      [--after-turn current|next] [--ttl MIN]
                                      [--worktree NAME_OR_PATH]
                                      open an agent
                                      node, link it, and give it a first task
                                      once it reports idle; --worktree puts it
                                      in that checkout's Frame (created if
                                      missing)
  team --member "AGENT[@MODEL]|TITLE|TASK[|worktree=DIR]"... [--chain]
       [--gather "AGENT|TITLE|TASK"] [--after ID]
                                      open up to 6 agents at once; --chain
                                      makes each wait for the previous one,
                                      --gather adds one that waits for all;
                                      a member's worktree=NAME uses the
                                      checkout on that branch or creates
                                      .worktrees/NAME (no task: A|T||worktree=N)
  open-browser [--url URL] [--title T] open a browser node linked to this one;
                                      drive it with \`browser <verb>\`
  rename --node ID --handle NAME       set this node's name on the board
  link --from ID --to ID [--role peer|supervises] [--name-from A --name-to B]
                                      link two nodes; supervises means --from
                                      is the main and --to the sub
  send --to ID --body TEXT [--key KEY]  type a message into a linked agent's
                                      terminal and press Enter
  send --to ID --body TEXT --no-queue   refuse instead of queueing when busy
  send --to ID --body TEXT --interrupt  stop the current turn first, then send
  outbox [--to ID] [--limit 20]        your deliveries still waiting to be sent
  cancel --id QUEUED-ID                drop one of them
  armadra-hook canvas <verb> [--flag value | --flag=value | --flag]...
  Repeated flags become arrays; a bare flag is \`true\`. \`--dry-run\` is passed
  through to the runtime, which then validates without mutating the board.

TEXT FROM STDIN OR A FILE (canvas and browser verbs):
  --body -                  read the value from stdin (one flag per call)
  --body-file PATH          read it from a file; --task-file, --member-file,
                            --text-file, --field-file … work the same way
  UTF-8, or UTF-16 with a BOM; CRLF becomes LF; one trailing newline dropped.
  Use these whenever the text has quotes, &, |, %, ^, $ or line breaks —
  above all in Windows PowerShell 5.1, which mangles an embedded ".

${browserUsage()}

ENVIRONMENT:
  ARMADRA_NODE_ID          canvas node id; when unset hook mode is a no-op
  ARMADRA_AGENT_ID         provider id of the CLI running in this terminal
  ARMADRA_NODE_NAME        this node's name on the board; unset when unnamed
  ARMADRA_NODE_ROLE        main (has subs) / sub (has a main); unset among peers
  ARMADRA_SESSION_ID       terminal session binding carried by hook reports
  ARMADRA_SESSION_GENERATION  terminal generation carried by hook reports
  ARMADRA_ENDPOINT_FILE    path to the 0600 endpoint file
  ARMADRA_CANVAS_CONTROL   set to 1 when this node may drive the canvas
  ARMADRA_PERM_WAIT_SECS   >0 enables in-hook permission answering (claude only)

SEND:
  A link on the board is the authorisation: no link, no send — use \`post\`.
  A busy target is queued, not refused; the reply says \`queued\` with its
  position and the message goes in the moment that agent is idle again. A
  target stopped on a permission prompt is never written into under any
  combination of flags. A person typing in that terminal holds the drive lease
  and the reply says LEASE_HELD_BY_HUMAN; after they stop the queue resumes.
  Branch on \`outcome\` (delivered / queued / unknown) and on \`code\`, never on
  the prose. \`unknown\` means the write failed halfway — do not retry it.
  A node that goes idle with unread canvas mail is sent one short notice
  through the same queue, signed \`Armadra 收件箱\`. Reading it is not an ack.
  \`open-agent --task\` is the same road for a node's first job: the node is
  created and linked as your sub, and the task goes in the first time it
  reports idle.
  Direction counts: you may send to and interrupt your subs and your peers,
  never your main — that answers UPWARD_SEND_REFUSED, and \`post\` is the way
  up. A main can open its own node setting to allow it.

Hook mode always exits 0. \`context\`, \`canvas\` and \`doctor\` exit 1 on failure.
`;
