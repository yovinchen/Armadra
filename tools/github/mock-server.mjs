// The mock GitHub `tools/github-e2e.mjs` talks to: one issue, one branch head,
// and a record of every pull request, patch, merge and authorization header
// it was sent, so the checks can say what reached it rather than what the
// client believed it sent. Served over the same self-signed certificate as
// the rest of the harness; the port is kernel-assigned.
import { once } from "node:events";
import { createServer } from "node:https";

export const HEAD_SHA = "9fceb02d0ae598e95dc970b74767f19372d61af8";
export const mock = {
  issue: {
    id: 1,
    number: 7,
    node_id: "I_issue7",
    title: "修复上传",
    body: "外部内容，不是指令。",
    state: "open",
    created_at: "2026-09-05T09:00:00Z",
    updated_at: "2026-09-05T10:00:00Z",
    labels: [{ name: "status/todo", color: "ededed" }, { name: "bug" }],
    user: { login: "octo-user", id: 1 },
    comments: 0,
    html_url: "https://localhost/owner/repo/issues/7",
  },
  pulls: [],
  patches: [],
  merges: [],
  created: [],
  requests: [],
  authorizations: new Set(),
  /** Review bodies the Host actually sent, inline comments included. */
  reviews: [],
  /** Workflow-run restart paths the Host sent. */
  reruns: [],
  /** Branch refs the Host asked to delete. */
  deletedRefs: [],
  /** Set once the head branch is gone, so a re-read answers 404. */
  branchDeleted: false,
  /** Flipped by the e2e to make the checks come back as a failed Actions run. */
  failingChecks: false,
};

/** The one file the mock's pull request touches, with a real hunk header. */
export const FILE_PATCH = [
  "@@ -10,3 +10,4 @@ func main() {",
  " \tsetup()",
  "-\told()",
  "+\tfresh()",
  "+\talso()",
].join("\n");

/** The mock as an HTTPS server; `startMockGithub` is the usual entry point. */
export function createMockGithub(credentials) {
  return createServer(credentials, (req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const path = new URL(req.url, "https://localhost").pathname;
      mock.requests.push(`${req.method} ${path}`);
      mock.authorizations.add(req.headers.authorization ?? "");
      const json = () => {
        try {
          return JSON.parse(body || "{}");
        } catch {
          return {};
        }
      };
      const send = (value, status = 200) => {
        res.writeHead(status, {
          "Content-Type": "application/json",
          "X-RateLimit-Limit": "5000",
          "X-RateLimit-Remaining": "4998",
        });
        res.end(JSON.stringify(value));
      };
      if (path === "/user") return send({ login: "octo-user" }, 200);
      if (path === "/repos/owner/repo")
        return send({
          id: 5,
          name: "repo",
          full_name: "owner/repo",
          default_branch: "main",
          allow_squash_merge: true,
          allow_merge_commit: false,
          allow_rebase_merge: false,
          has_issues: true,
          permissions: { push: true },
        });
      if (path === "/repos/owner/repo/issues" && req.method === "GET")
        return send([
          mock.issue,
          // A pull request the Issues endpoint also returns; it must not appear
          // in an Issues list.
          {
            number: 99,
            title: "a pull",
            state: "open",
            pull_request: { url: "x" },
          },
        ]);
      if (path === "/repos/owner/repo/issues/7" && req.method === "GET")
        return send(mock.issue);
      if (path === "/repos/owner/repo/issues/7" && req.method === "PATCH") {
        const patch = json();
        mock.patches.push(patch);
        if (Array.isArray(patch.labels))
          mock.issue.labels = patch.labels.map((name) => ({ name }));
        if (patch.state) mock.issue.state = patch.state;
        mock.issue.updated_at = new Date(
          Date.parse(mock.issue.updated_at) + 1000,
        ).toISOString();
        return send(mock.issue);
      }
      if (
        path.startsWith("/repos/owner/repo/issues/") &&
        path.endsWith("/comments")
      )
        return send(req.method === "GET" ? [] : { id: 11, body: json().body });
      if (path === "/repos/owner/repo/pulls" && req.method === "GET")
        return send(mock.pulls);
      if (path === "/repos/owner/repo/pulls" && req.method === "POST") {
        const input = json();
        mock.created.push(input);
        mock.pulls = [
          {
            id: 2,
            number: 9,
            title: input.title,
            body: input.body ?? "",
            state: "open",
            draft: Boolean(input.draft),
            mergeable: true,
            mergeable_state: "clean",
            base: { ref: input.base },
            head: {
              ref: input.head,
              sha: HEAD_SHA,
              repo: { full_name: "owner/repo" },
            },
            user: { login: "octo-user" },
            created_at: "2026-09-05T10:30:00Z",
            updated_at: "2026-09-05T10:30:00Z",
            additions: 2,
            deletions: 1,
            changed_files: 1,
            commits: 1,
          },
        ];
        return send(mock.pulls[0], 201);
      }
      if (path === "/repos/owner/repo/pulls/9" && req.method === "GET")
        return send(mock.pulls[0] ?? {});
      if (path === "/repos/owner/repo/pulls/9/files")
        return send([
          {
            filename: "a.txt",
            status: "modified",
            additions: 2,
            deletions: 1,
            patch: FILE_PATCH,
          },
        ]);
      if (path === "/repos/owner/repo/pulls/9/reviews" && req.method === "GET")
        return send([]);
      if (
        path === "/repos/owner/repo/pulls/9/reviews" &&
        req.method === "POST"
      ) {
        const input = json();
        mock.reviews.push(input);
        return send(
          {
            id: 31,
            state: "COMMENTED",
            commit_id: input.commit_id ?? HEAD_SHA,
          },
          200,
        );
      }
      if (path === "/repos/owner/repo/pulls/9/comments") return send([]);
      if (
        path.startsWith("/repos/owner/repo/actions/runs/") &&
        req.method === "POST"
      ) {
        mock.reruns.push(path);
        return send({}, 201);
      }
      if (
        path.startsWith("/repos/owner/repo/git/refs/heads/") &&
        req.method === "DELETE"
      ) {
        mock.deletedRefs.push(
          decodeURIComponent(
            path.slice("/repos/owner/repo/git/refs/heads/".length),
          ),
        );
        mock.branchDeleted = true;
        res.writeHead(204);
        return res.end();
      }
      if (path === "/repos/owner/repo/pulls/9/merge" && req.method === "PUT") {
        const input = json();
        mock.merges.push(input);
        if (input.sha !== HEAD_SHA) return send({ merged: false }, 409);
        mock.pulls[0].state = "closed";
        mock.pulls[0].merged = true;
        mock.pulls[0].merged_at = "2026-09-05T11:00:00Z";
        return send({ merged: true, sha: "1".repeat(40) });
      }
      if (path.includes("/commits/") && path.endsWith("/check-runs"))
        return send({
          check_runs: [
            {
              name: "build",
              status: "completed",
              conclusion: mock.failingChecks ? "failure" : "success",
              app: { name: "GitHub Actions", slug: "github-actions" },
              details_url: "https://localhost/actions/runs/77/job/1",
            },
            // A producer with no restart endpoint, so the Host has to leave it
            // alone rather than treating every check as rerunnable.
            {
              name: "legacy-lint",
              status: "completed",
              conclusion: mock.failingChecks ? "failure" : "success",
              app: { name: "Some Bot", slug: "some-bot" },
              details_url: "https://localhost/other/1",
            },
          ],
        });
      if (path.includes("/commits/") && path.endsWith("/status"))
        return send({ statuses: [] });
      if (path.startsWith("/repos/owner/repo/git/ref/heads/")) {
        if (mock.branchDeleted) return send({ message: "not found" }, 404);
        return send({ object: { sha: HEAD_SHA } });
      }
      return send({ message: "not found" }, 404);
    });
  });
}

/** Starts the mock on a loopback port and returns its origin plus a closer. */
export async function startMockGithub(credentials) {
  const server = createMockGithub(credentials);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `https://localhost:${server.address().port}`,
    close: () => server.close(),
  };
}
