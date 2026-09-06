// End-to-end checks for a business domain's write-ownership switch, one domain
// per run (Go Host 业务所有权迁移 §5.2, §6.2):
//
//     pnpm ownership:e2e --domain settings
//     pnpm ownership:e2e --domain filesystem
//     pnpm ownership:e2e --domain git
//
// Each scenario is its own module under `tools/ownership/`. The canvas domain
// keeps its older and much wider script (`pnpm canvas:e2e`), which also drives
// a real browser. Everything here is Node-only, talks to a real Rust Runtime
// and a real Go Host on kernel-assigned loopback ports, and never touches the
// operator's own data directory or the application's reserved ports.
const scenarios = {
  settings: "./ownership/settings-e2e.mjs",
  filesystem: "./ownership/filesystem-e2e.mjs",
  git: "./ownership/git-e2e.mjs",
};

const index = process.argv.indexOf("--domain");
const domain = index >= 0 ? process.argv[index + 1] : "";
if (domain === "canvas") {
  console.error(
    "The canvas domain has its own end-to-end check: pnpm canvas:e2e",
  );
  process.exit(2);
}
if (!Object.hasOwn(scenarios, domain)) {
  console.error(
    `ownership-e2e: --domain must name one of ${Object.keys(scenarios).join(", ")}` +
      (domain ? ` (got "${domain}")` : ""),
  );
  process.exit(2);
}
await import(scenarios[domain]);
