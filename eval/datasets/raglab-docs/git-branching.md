# Git Branching Workflows

Branches let several lines of work evolve in parallel in one repository. A branch in Git is only a
movable pointer to a commit, so creating one is cheap.

## Feature branches

Create a short-lived branch for every change, for example `git switch -c fix-login-timeout`, and
open a pull request when it is ready. Keep feature branches small: a branch that lives for weeks
drifts away from the main branch and becomes painful to integrate. Delete the branch after it has
been merged.

## Merge versus rebase

A merge commit joins two histories and records that they were combined; the original commits stay
untouched. A rebase replays your commits on top of another branch and produces a linear history,
but it rewrites commit ids. Rule of thumb: rebase your own local work to tidy it up before sharing
it, and never rebase commits that other people have already pulled. Squash merging collapses a
whole pull request into one commit on the main branch.

## Resolving conflicts

A conflict happens when two branches changed the same lines. Git stops and marks the file with
conflict markers `<<<<<<<`, `=======` and `>>>>>>>`. Edit the file to the intended result, remove
the markers, stage the file with `git add` and continue with `git merge --continue` or
`git rebase --continue`. If you get lost, `git merge --abort` returns to the state before the
merge. Running the tests after resolving is essential because a clean textual merge can still be
semantically wrong.

## Undoing mistakes

`git revert` creates a new commit that undoes an earlier one and is safe on shared branches. The
reflog records where branch pointers have been, so even commits that seem lost after a bad reset
can usually be recovered with `git reflog` and a new branch pointing at the old commit.
