/**
 * The command-surface constants, carried verbatim from the Rust client.
 *
 * `USAGE` is byte-compared against `armadra-hook --help` by
 * `wire.test.ts`, so it is a fixture, not documentation: edit it only
 * together with the Rust text it mirrors.
 */

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
 */
export const BROWSER_VERBS = [
  "navigate",
  "read",
  "click",
  "type",
  "wait",
  "capture",
  "select",
  "press",
  "scroll",
  "upload",
  "download",
  "back",
  "forward",
  "close",
  "tabs",
  "dialog",
  "lease",
] as const;

/** Text printed by `--help` and by any usage error. */
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
                                      open an agent
                                      node, link it, and give it a first task
                                      once it reports idle
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

BROWSER VERBS (the browser node linked to this one):
  navigate --url URL            open an address; --action back|forward|reload|stop
  back | forward                walk the history of the current tab
  read [--mode text|elements|links|title|console|network] [-n N]
  click --selector CSS | --ref REF | --x N --y N
  type --selector CSS --text TEXT [--replace] [--submit]
  select --selector CSS|--ref REF --value V [--value V] | --label L
  press --key Enter|Tab|Escape|ArrowDown|F5|<char> [--modifiers ctrl,shift]
  scroll --direction up|down|left|right [--amount PX] | --to-ref REF
  wait --selector CSS | --url-contains TEXT | --title-contains TEXT [--timeout MS]
  capture [--full-page] [--format png|jpeg]      save a screenshot into .armadra/
  upload --path REL [--path REL] [--selector CSS | --ref REF]
  download [--id ID --accept | --id ID --reject]  list or decide the queue
  tabs [--switch t2 | --new URL]                 list, switch or open a tab
  close --tab t2                                 close one tab, never the last
  dialog --accept | --dismiss [--text TEXT]      answer alert/confirm/prompt
  lease [--status | --release]                   who is driving; give yours back

BROWSER OPTIONS:
  --node <id|title>         which linked browser node (defaults to the only one)
  --tab t2 / --frame ID     which tab and frame; defaults to the active tab's
                            main frame, so most calls need neither
  Element references from \`read --mode elements\` are only valid until that
  frame navigates; after that the runtime answers STALE_TARGET and you read
  again. A reference read inside an iframe looks like \`e3-12@t1/<frameId>\` and
  carries its own address, so it can be passed straight back.
  \`upload --path\` only takes workspace-relative paths.
  While a page is showing a dialog, actions on that tab answer DIALOG_PENDING
  with the dialog's text; \`read\` still works, and \`dialog\` clears it.
  Anything that drives the page takes the control lease. A person mid-typing
  makes it wait briefly and then answers LEASE_HELD_BY_HUMAN; a person who
  took the browser over makes it answer LEASE_REVOKED at once — do not retry
  either, read \`lease --status\` and say so instead.

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
