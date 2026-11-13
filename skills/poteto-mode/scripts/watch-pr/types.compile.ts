import { parsePrNumber } from "./types.ts";
import type {
  CiClean,
  GitHubMergeAllowed,
  PrContext,
  ReadyPr,
  TerminalVerdict,
} from "./types.ts";

type ReadyVerdict = Extract<TerminalVerdict, { readonly kind: "READY" }>;

const context = {
  owner: "octocat",
  repo: "hello-world",
  number: parsePrNumber(123),
} satisfies PrContext;
const cleanCi = {
  kind: "ci-clean",
  source: "gh-pr-checks",
  all: [
    {
      kind: "passed",
      name: "ci",
      reportedState: "SUCCESS",
      description: "",
      link: "",
      workflow: "",
    },
  ],
  failed: [],
  pending: [],
  hadPreviousPassingCi: false,
  github: {
    kind: "allowed",
    basis: "merge-state",
    mergeStateStatus: "CLEAN",
    headRollupState: "SUCCESS",
  },
} satisfies CiClean;
const readyPr = {
  kind: "ready-pr",
  context,
  proof: {
    mergeability: "clear",
    threads: [],
    ci: cleanCi,
    gate: {
      state: "OPEN",
      reviewDecision: "APPROVED",
      draft: "not-draft",
    },
  },
} satisfies ReadyPr;
const ready = {
  schemaVersion: 1,
  sequence: 1,
  observedAt: "2026-07-26T00:00:00.000Z",
  mode: "single",
  kind: "READY",
  terminal: true,
  exitCode: 0,
  scope: { kind: "single", pr: readyPr },
} satisfies ReadyVerdict;

void ready;

const blocked = {
  kind: "allowed",
  basis: "merge-state",
  mergeStateStatus: "BLOCKED",
  headRollupState: "SUCCESS",
} as const;

// @ts-expect-error Branch protection cannot be bypassed by a passing rollup.
const blockedIsNotAllowed: GitHubMergeAllowed = blocked;

// @ts-expect-error CI cannot be clean while GitHub refuses the merge.
const refusalIsNotClean: CiClean = { ...cleanCi, github: blocked };

const blockedPending = {
  kind: "allowed",
  basis: "rollup",
  mergeStateStatus: "BLOCKED",
  headRollupState: "PENDING",
} as const satisfies GitHubMergeAllowed;

// @ts-expect-error A rollup-only pending allowance cannot prove clean CI.
const pendingIsNotClean: CiClean = { ...cleanCi, github: blockedPending };

const behind = { ...blocked, mergeStateStatus: "BEHIND" } as const;

// @ts-expect-error An out-of-date protected branch is not an allowed merge.
const behindIsNotAllowed: GitHubMergeAllowed = behind;

// @ts-expect-error READY cannot carry the failing-checks exit code.
const readyWithBlockerExit: ReadyVerdict = { ...ready, exitCode: 4 };

const unprovenPr = { kind: "ready-pr", context } as const;

// @ts-expect-error An open READY row must carry positive readiness proof.
const readyWithoutProof: ReadyPr = unprovenPr;

const reviewRequiredPr = {
  ...readyPr,
  proof: {
    ...readyPr.proof,
    gate: { ...readyPr.proof.gate, reviewDecision: "REVIEW_REQUIRED" },
  },
} as const;

// @ts-expect-error A required review cannot be readiness proof.
const reviewRequiredReady: ReadyPr = reviewRequiredPr;

void blockedIsNotAllowed;
void refusalIsNotClean;
void pendingIsNotClean;
void behindIsNotAllowed;
void readyWithBlockerExit;
void readyWithoutProof;
void reviewRequiredReady;
