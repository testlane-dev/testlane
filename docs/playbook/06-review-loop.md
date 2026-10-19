# 06 Review loop

## The rule

Before a change merges, have an **independent reviewer** review a **fixed version** of it, not a
moving target; **fix** findings and **re-verify** after each fix; then commit **exactly what was
approved**. The strictest way to do this is to **freeze** the candidate and record its git tree
hash, then prove the commit matches by comparing hashes; the steps below show it. Use it for
anything that touches secrets, access policy or permissions. For a lighter change, a pull request
whose approval is dismissed when new commits arrive gives much the same guarantee. When work is
split between agents, give **one job to each agent**, with a non-overlapping list of files it may
change, and require a return that someone else can verify.

## Why

- **The reviewer reviewed a moving target.** The author kept editing while the review ran; the
  approval applies to a tree that no longer exists.
- **The fix was never reviewed.** A finding is fixed after approval, and the fix introduces the
  next bug.
- **The commit is not what was reviewed.** A stray file, a debug line or a formatting pass slips in
  between approval and `git commit`.
- **The author reviews their own work.** An agent that wrote the patch shares its blind spots and
  its assumptions about what the code "obviously" does.
- **Parallel agents clobber each other.** Two jobs edit the same file; the second write wins and
  nobody notices until tests fail for unrelated reasons.
- **"Done" with nothing to check.** A job returns a summary but no commands, exit codes or file
  list, so whoever split the work (the orchestrator) has to redo the verification or trust it
  blindly.

## How

### 1. Freeze and hash (the strict form)

When the author believes the patch is complete and its checks pass
([05-evidence.md](05-evidence.md)):

```bash
git status --short                      # every path listed must belong to the patch
git add -A
git diff --cached --stat > output/freeze-1.stat
tree=$(git write-tree)                  # hash of exactly what is staged; nothing is committed
printf '%s\n' "$tree" > output/freeze-1.tree
echo "frozen tree $tree"
```

From now on the author does not edit files until the review returns. The checks are re-run on the
frozen state if anything was touched after they last ran.

### 2. Independent review of the frozen tree

The reviewer is a different agent or person from the author. Give them:

- the base commit and the tree hash;
- the diff: `git diff <base> <tree>`;
- a copy of the exact files, if they want to run things:
  `mkdir ../review && git archive <tree> | tar -x -C ../review`;
- the evidence (logs, exit files, counts);
- the relevant rules (the security requirements and threat model your project documents; for
  Testlane itself, the guarantees in [SECURITY.md](../../SECURITY.md) and the
  [threat model](../threat-model.md));
- specific questions: "can any path here print a loaded secret?", "is every new refusal audited?".

The reviewer does not edit the working tree. They return findings, each with a severity
(blocker, should-fix, nit), a file and line, and the reason; or an explicit approval **naming the
tree hash** they approved.

### 3. Fix, re-verify, re-hash

For each blocker and should-fix: fix it, re-run the affected checks (new log numbers), freeze
again (`output/freeze-2.tree`), and send the reviewer the delta:

```bash
git diff "$(cat output/freeze-1.tree)" "$(cat output/freeze-2.tree)"
```

Repeat until the reviewer approves a specific hash. An approval of `freeze-1` does not cover
`freeze-2`.

### 4. Commit exactly the approved tree

```bash
approved=$(cat output/freeze-2.tree)
test "$(git write-tree)" = "$approved" || { echo "index differs from the approved tree"; exit 1; }
git commit -m "feat(scope): what and why"
test "$(git rev-parse 'HEAD^{tree}')" = "$approved" && echo "committed approved tree $approved"
```

If the hashes differ, stop: something changed after approval. Do not "fix up" the commit without
going back through step 3.

### 5. Split work into jobs

When an orchestrating agent (or a person) splits a change between several agents, each job gets
a written brief:

- **Goal**: one outcome, stated as something checkable.
- **Files owned**: the exact list the job may create or modify. No two concurrent jobs share a
  file. Shared files (a changelog, an index) are edited by the orchestrator afterwards.
- **Files readable**: what it may read for context.
- **Files forbidden**: anything else, stated explicitly for the obvious temptations.
- **Commands**: which checks to run and how to log them.
- **Constraints**: no commits, no pushes, no dependency changes, no network, as applicable.

A job's return must contain:

1. every file created or changed, with line counts, and a statement that nothing outside the
   owned list was touched;
2. every command run, with its exit code, counts and log path;
3. what the job was unsure of, and every assumption it made;
4. anything it found out of scope (as a note, not a change);
5. a proposed commit boundary and message.

The orchestrator checks the file list against `git status`, re-runs the full check on the combined
tree once all jobs have returned, and only then freezes (step 1). Reviewers review the combined
frozen tree, not the individual jobs.

## Checklist

- [ ] The reviewed state was fixed: frozen with `git write-tree` and the hash recorded under `output/`, or a pull request with no commits added after approval.
- [ ] The reviewer is not the author and did not edit the tree.
- [ ] The approval names what was approved (a tree hash, or the pull request's head commit).
- [ ] Every fix after a finding was re-verified and re-frozen; the reviewer saw the delta.
- [ ] For frozen changes, `HEAD^{tree}` after the commit equals the approved hash.
- [ ] Each parallel job owned a disjoint set of files and returned files, commands, exit codes, counts, doubts and a commit proposal.
- [ ] The combined tree passed the full check before freezing.
