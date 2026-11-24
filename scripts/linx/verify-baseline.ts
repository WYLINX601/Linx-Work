// @effect-diagnostics nodeBuiltinImport:off - the baseline check runs without an Effect runtime.
// @effect-diagnostics globalConsole:off - CLI output is the result of this check.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

interface Baseline {
  readonly integrationBranch: string;
  readonly baselineCommit: string;
  readonly lockfile: string;
  readonly lockfileSha256: string;
}

const root = NodePath.resolve(import.meta.dirname, "../..");
const baseline = JSON.parse(
  NodeFS.readFileSync(NodePath.resolve(root, "docs/linx/baseline.json"), "utf8"),
) as Baseline;
const allowDirty = process.argv.includes("--allow-dirty");

const git = (...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

const failures: Array<string> = [];
const check = (condition: boolean, message: string): void => {
  if (condition) {
    console.log(`ok ${message}`);
  } else {
    failures.push(message);
    console.error(`not ok ${message}`);
  }
};

const head = git("rev-parse", "HEAD");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");

let reachesBaseline = false;
try {
  NodeChildProcess.execFileSync(
    "git",
    ["merge-base", "--is-ancestor", baseline.baselineCommit, "HEAD"],
    {
      cwd: root,
      stdio: "ignore",
    },
  );
  reachesBaseline = true;
} catch {
  reachesBaseline = false;
}

check(
  reachesBaseline,
  `HEAD ${head.slice(0, 12)} reaches baseline ${baseline.baselineCommit.slice(0, 12)}`,
);
check(
  branch.startsWith("linx/"),
  `branch ${branch} is a linx/* branch (expected ${baseline.integrationBranch} or a child)`,
);

const lockfilePath = NodePath.resolve(root, baseline.lockfile);
const lockfileHash = NodeCrypto.createHash("sha256")
  .update(NodeFS.readFileSync(lockfilePath))
  .digest("hex");
check(
  lockfileHash === baseline.lockfileSha256,
  `${baseline.lockfile} sha256 matches ${baseline.lockfileSha256.slice(0, 12)}…`,
);

if (allowDirty) {
  console.log("ok working tree cleanliness skipped (--allow-dirty)");
} else {
  const status = git("status", "--porcelain");
  check(status.length === 0, "working tree is clean");
}

if (failures.length > 0) {
  console.error(`\nbaseline verification failed (${failures.length})`);
  process.exit(1);
}

console.log("\nbaseline verified");
