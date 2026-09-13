/**
 * The mechanics of a stacked PR train — see `.claude/skills/stack/SKILL.md`
 * for the workflow this serves, and `docs/PHASE-1-STACK.md` for the phase-1
 * stack itself.
 *
 * A stack is just local branches named `<prefix>/<n>-<slug>`, ordered by `n`,
 * each based on the one before it and the first based on `main`. Nothing here
 * talks to GitHub except the optional `--prs` lookup, which shells out to `gh`.
 *
 *   node --experimental-strip-types scripts/stack.ts status p1 [--prs]
 *   node --experimental-strip-types scripts/stack.ts restack p1 [--onto main] [--apply]
 *   node --experimental-strip-types scripts/stack.ts push p1 [--apply]
 *   node --experimental-strip-types scripts/stack.ts base p1/8-gcal p1/3-outbox
 *
 *   status    the chain in order: parent, commits, whether it still sits on
 *             its parent's head, and how it stands against its remote
 *   restack   after the bottom PR merges (or main moves): replay every branch
 *             onto its parent's new head, in order. Prints the plan; `--apply`
 *             runs it
 *   push      `--force-with-lease` every branch in the stack, which is what a
 *             restack needs afterwards. Prints the plan; `--apply` runs it
 *   base      record that a branch forks off some branch other than the one
 *             before it, so status and restack stop treating the stack as one
 *             line. Stored as `branch.<name>.stackBase` in the local git config
 *
 * A stack is not always a line: a slice that depends only on something further
 * down forks off it and reviews in parallel. Left to guess, `restack` would
 * quietly flatten that fork into the line — so a recorded base wins over the
 * ordinal, always.
 *
 * Restacking rewrites history on your own stack branches — fine, they are
 * yours and nobody else builds on them. Never point it at a branch someone
 * else has checked out.
 */
import { execFileSync } from "node:child_process";

const [command, prefixArg, ...rest] = process.argv.slice(2);
const apply = rest.includes("--apply");
const withPrs = rest.includes("--prs");
const onto = flagValue(rest, "--onto") ?? "main";

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/** Exit status only — for the git commands whose answer is yes/no. */
function gitOk(...args: string[]): boolean {
  try {
    execFileSync("git", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Local branches `<prefix>/<n>-<slug>`, in `n` order. */
/** A fork's recorded parent, set by `stack.ts base`. */
function recordedBase(branch: string): string | undefined {
  try {
    const base = execFileSync("git", ["config", "--get", `branch.${branch}.stackBase`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return base || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who each branch sits on: its recorded base if it has one, otherwise the
 * branch before it, and `onto` for the bottom of the stack.
 */
function parentsOf(branches: string[]): Map<string, string> {
  const parents = new Map<string, string>();
  branches.forEach((branch, i) => {
    const base = recordedBase(branch);
    if (base && !gitOk("rev-parse", "--verify", "--quiet", base)) {
      console.error(`${branch} records a base (${base}) that no longer exists — check it out or re-record it.`);
      process.exit(1);
    }
    parents.set(branch, base ?? (i === 0 ? onto : (branches[i - 1] as string)));
  });
  return parents;
}

function stackBranches(prefix: string): string[] {
  const refs = git("for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}/*`)
    .split("\n")
    .filter(Boolean);
  const numbered: { n: number; branch: string }[] = [];
  const seen = new Set<number>();
  for (const branch of refs) {
    const ordinal = branch.slice(prefix.length + 1).match(/^(\d+)-/)?.[1];
    if (!ordinal) {
      console.error(`skipping ${branch}: no leading ordinal`);
      continue;
    }
    const n = Number(ordinal);
    if (seen.has(n)) {
      console.error(`Two branches claim position ${n}. Renumber one of them.`);
      process.exit(1);
    }
    seen.add(n);
    numbered.push({ n, branch });
  }
  numbered.sort((a, b) => a.n - b.n);
  return numbered.map((entry) => entry.branch);
}

function prState(branch: string): string {
  try {
    const json = execFileSync(
      "gh",
      ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state,isDraft,baseRefName"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const prs = JSON.parse(json) as {
      number: number;
      state: string;
      isDraft: boolean;
      baseRefName: string;
    }[];
    const pr = prs[0];
    if (!pr) return "no PR";
    return `#${pr.number} ${pr.state.toLowerCase()}${pr.isDraft ? " (draft)" : ""} → ${pr.baseRefName}`;
  } catch {
    return "gh unavailable";
  }
}

function status(prefix: string): void {
  const branches = stackBranches(prefix);
  if (branches.length === 0) {
    console.log(`No ${prefix}/* branches.`);
    return;
  }
  const parents = parentsOf(branches);
  let needsRestack = false;
  for (const branch of branches) {
    const parent = parents.get(branch) as string;
    const forked = recordedBase(branch) !== undefined;
    const stacked = gitOk("merge-base", "--is-ancestor", parent, branch);
    needsRestack ||= !stacked;
    const commits = git("rev-list", "--count", `${parent}..${branch}`);
    const remote = `origin/${branch}`;
    let sync = "not pushed";
    if (gitOk("rev-parse", "--verify", "--quiet", remote)) {
      const ahead = git("rev-list", "--count", `${remote}..${branch}`);
      const behind = git("rev-list", "--count", `${branch}..${remote}`);
      sync = ahead === "0" && behind === "0" ? "pushed" : `ahead ${ahead}, behind ${behind}`;
    }
    const parts = [
      `on ${parent}${forked ? " (fork)" : ""}`,
      `${commits} commit${commits === "1" ? "" : "s"}`,
      stacked ? "stacked" : "NEEDS RESTACK",
      sync,
    ];
    if (withPrs) parts.push(prState(branch));
    console.log(`${branch}\n    ${parts.join(" · ")}`);
  }
  if (needsRestack) {
    console.log(`\nRun: node --experimental-strip-types scripts/stack.ts restack ${prefix} --apply`);
  }
}

/**
 * Replaying a stack needs each parent's *old* head, so the plan is computed
 * against the heads as they are now, before anything moves.
 */
function restack(prefix: string): void {
  const branches = stackBranches(prefix);
  if (branches.length === 0) {
    console.log(`No ${prefix}/* branches.`);
    return;
  }
  const parents = parentsOf(branches);
  const plan: { branch: string; args: string[] }[] = [];

  // Each branch is replayed onto its parent's *new* head, from where its
  // parent's head was before anything moved — so the heads are all recorded
  // up front, and a branch is only planned after the parent it sits on.
  const oldHeads = new Map<string, string>(branches.map((b) => [b, git("rev-parse", b)]));
  const newParents = new Map<string, string>();

  for (const branch of branches) {
    const parent = parents.get(branch) as string;
    const parentMoved = oldHeads.has(parent);
    if (parentMoved && !newParents.has(parent)) {
      console.error(`${branch} sits on ${parent}, which comes after it. Renumber, or re-record its base.`);
      process.exit(1);
    }
    const from = parentMoved ? (oldHeads.get(parent) as string) : git("merge-base", parent, branch);
    plan.push({ branch, args: ["rebase", "--onto", parent, from, branch] });
    newParents.set(branch, branch);
  }

  if (!apply) {
    console.log(`Plan (add --apply to run):\n`);
    for (const { args } of plan) console.log(`  git ${args.join(" ")}`);
    return;
  }
  if (git("status", "--porcelain") !== "") {
    console.error("Working tree is dirty. Commit or stash first.");
    process.exit(1);
  }
  const startingBranch = git("rev-parse", "--abbrev-ref", "HEAD");
  for (const { branch, args } of plan) {
    console.log(`git ${args.join(" ")}`);
    try {
      execFileSync("git", args, { stdio: "inherit" });
    } catch {
      console.error(
        `\nRebase of ${branch} stopped. Resolve and \`git rebase --continue\`, or ` +
          `\`git rebase --abort\`, then re-run restack — the branches above it have not moved.`,
      );
      process.exit(1);
    }
  }
  git("checkout", startingBranch);
  console.log(`\nRestacked onto ${onto}. Push with: scripts/stack.ts push ${prefix} --apply`);
}

function push(prefix: string): void {
  const branches = stackBranches(prefix);
  for (const branch of branches) {
    const args = ["push", "--force-with-lease", "-u", "origin", branch];
    if (!apply) {
      console.log(`  git ${args.join(" ")}`);
      continue;
    }
    console.log(`git ${args.join(" ")}`);
    execFileSync("git", args, { stdio: "inherit" });
  }
  if (!apply) console.log("\n(add --apply to run)");
}

/** Record that a branch forks off something other than the branch before it. */
function setBase(branch: string, base: string): void {
  if (!gitOk("rev-parse", "--verify", "--quiet", branch)) {
    console.error(`no branch ${branch}.`);
    process.exit(1);
  }
  if (!gitOk("rev-parse", "--verify", "--quiet", base)) {
    console.error(`no branch ${base}.`);
    process.exit(1);
  }
  git("config", `branch.${branch}.stackBase`, base);
  console.log(`${branch} forks off ${base}.`);
}

if (!command || !prefixArg) {
  console.error(
    "usage: stack.ts <status|restack|push> <prefix> [--onto main] [--apply] [--prs]\n" +
      "       stack.ts base <branch> <base-branch>",
  );
  process.exit(1);
}
switch (command) {
  case "status":
    status(prefixArg);
    break;
  case "restack":
    restack(prefixArg);
    break;
  case "push":
    push(prefixArg);
    break;
  case "base": {
    const base = rest[0];
    if (!base) {
      console.error("usage: stack.ts base <branch> <base-branch>");
      process.exit(1);
    }
    setBase(prefixArg, base);
    break;
  }
  default:
    console.error(`Unknown command ${command}.`);
    process.exit(1);
}
