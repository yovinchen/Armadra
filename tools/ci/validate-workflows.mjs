/**
 * Structural checks over .github/workflows.
 *
 *   node tools/ci/validate-workflows.mjs
 *
 * A workflow is only exercised when it runs, and the release workflow runs
 * when a tag is pushed — which is the worst possible moment to discover that a
 * job depends on one that does not exist, or that a step names an output no
 * job produces. These are the mistakes a YAML file makes silently, so they are
 * checked here where a pull request sees them.
 *
 * This is not a schema validator and does not try to be GitHub. It asserts the
 * relationships between jobs, which is what actually breaks.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseYaml } from "./workflow-yaml.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOW_DIR = join(root, ".github/workflows");

/** Every ${{ needs.<job>. }} reference in a value, however deeply nested. */
function neededJobs(value, found = new Set()) {
  if (typeof value === "string") {
    for (const match of value.matchAll(/needs\.([A-Za-z0-9_-]+)/g))
      found.add(match[1]);
    return found;
  }
  if (Array.isArray(value)) {
    for (const item of value) neededJobs(item, found);
    return found;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) neededJobs(item, found);
  }
  return found;
}

/** Check one parsed workflow, returning problems as plain sentences. */
export function checkWorkflow(name, document) {
  const problems = [];
  const say = (message) => problems.push(`${name}: ${message}`);
  if (!document || typeof document !== "object") {
    say("is not a mapping");
    return problems;
  }
  if (typeof document.name !== "string" || document.name === "")
    say("has no name");
  // YAML 1.1 readers turn a bare `on:` into `true`; the parser here keeps it a
  // key, and either way a workflow with no trigger never runs.
  const triggers = document.on ?? document[true];
  if (!triggers) say("has no trigger");
  const jobs = document.jobs;
  if (!jobs || typeof jobs !== "object" || Array.isArray(jobs)) {
    say("has no jobs");
    return problems;
  }
  const names = new Set(Object.keys(jobs));
  if (names.size === 0) say("has no jobs");

  for (const [jobName, job] of Object.entries(jobs)) {
    const where = `${name}: job ${jobName}`;
    if (!job || typeof job !== "object" || Array.isArray(job)) {
      problems.push(`${where} is not a mapping`);
      continue;
    }
    if (!job["runs-on"] && !job.uses)
      problems.push(`${where} names no runner and reuses no workflow`);
    const declared = new Set(
      job.needs === undefined
        ? []
        : Array.isArray(job.needs)
          ? job.needs
          : [job.needs],
    );
    for (const dependency of declared) {
      if (!names.has(dependency))
        problems.push(
          `${where} needs ${dependency}, which is not a job in this workflow`,
        );
      if (dependency === jobName) problems.push(`${where} needs itself`);
    }
    // A job that reads needs.<other> without declaring it does not wait for it,
    // so the value is empty at exactly the moment it matters.
    for (const referenced of neededJobs({ ...job, needs: undefined })) {
      if (!declared.has(referenced))
        problems.push(
          `${where} reads needs.${referenced} without declaring it in needs`,
        );
    }
    const steps = job.steps;
    if (steps === undefined) {
      if (!job.uses) problems.push(`${where} has no steps`);
      continue;
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      problems.push(`${where} has no steps`);
      continue;
    }
    const stepIds = new Set();
    for (const [index, step] of steps.entries()) {
      const stepWhere = `${where} step ${index + 1}`;
      if (!step || typeof step !== "object" || Array.isArray(step)) {
        problems.push(`${stepWhere} is not a mapping`);
        continue;
      }
      if (!step.run && !step.uses)
        problems.push(`${stepWhere} neither runs nor uses anything`);
      if (step.run && step.uses)
        problems.push(`${stepWhere} both runs and uses something`);
      if (step.uses && !/@/.test(String(step.uses)))
        problems.push(
          `${stepWhere} uses ${step.uses} without pinning a version`,
        );
      if (step.id) {
        if (stepIds.has(step.id))
          problems.push(`${stepWhere} repeats the id ${step.id}`);
        stepIds.add(step.id);
      }
    }
    // A step output can only come from a step that has an id, and a typo here
    // reads as an empty string rather than as an error.
    for (const match of JSON.stringify(job).matchAll(
      /steps\.([A-Za-z0-9_-]+)\.outputs/g,
    )) {
      if (!stepIds.has(match[1]))
        problems.push(
          `${where} reads steps.${match[1]}.outputs, but no step has that id`,
        );
    }
  }

  // Detect a cycle: needs must be a directed acyclic graph, and GitHub reports
  // one as a workflow that simply never starts.
  const state = new Map();
  const visit = (jobName, trail) => {
    if (state.get(jobName) === "done") return;
    if (state.get(jobName) === "open") {
      say(`jobs form a cycle: ${[...trail, jobName].join(" -> ")}`);
      return;
    }
    state.set(jobName, "open");
    const job = jobs[jobName];
    const needs =
      job?.needs === undefined
        ? []
        : Array.isArray(job.needs)
          ? job.needs
          : [job.needs];
    for (const dependency of needs) {
      if (names.has(dependency)) visit(dependency, [...trail, jobName]);
    }
    state.set(jobName, "done");
  };
  for (const jobName of names) visit(jobName, []);
  return problems;
}

/** Check every workflow in the repository. */
export function checkWorkflowDirectory(directory = WORKFLOW_DIR) {
  const problems = [];
  const files = readdirSync(directory).filter((name) => /\.ya?ml$/.test(name));
  if (files.length === 0) problems.push(`${directory} holds no workflows`);
  for (const file of files.sort()) {
    let document;
    try {
      document = parseYaml(readFileSync(join(directory, file), "utf8"));
    } catch (error) {
      problems.push(`${file}: ${error.message}`);
      continue;
    }
    problems.push(...checkWorkflow(file, document));
  }
  return { files, problems };
}

function main() {
  const { files, problems } = checkWorkflowDirectory();
  for (const problem of problems) console.error(`✗ ${problem}`);
  if (problems.length > 0) {
    console.error(
      `\nWorkflow validation failed: ${problems.length} problem(s)`,
    );
    return 1;
  }
  console.log(`${files.length} workflow(s) validated: ${files.join(", ")}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(main());
}
