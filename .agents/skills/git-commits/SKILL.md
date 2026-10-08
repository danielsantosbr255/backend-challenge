---
name: git-commits
description: Conventional Commits workflow for auditing a working tree, separating changes into dependency-aware atomic commits, selecting semantic types and scopes, writing useful bodies, and verifying staged and committed diffs. Use when asked to commit, prepare commits, split changes into commits, or review commit semantics. Don't use for implementing changes, reviewing code quality, or pushing branches.
---

# Conventional Commit Workflow

Create an auditable sequence of **atomic commits**: each commit has one intent, includes every inseparable dependency of that intent, and can be reviewed or reverted without dragging in unrelated behavior.

## 1. Establish the baseline

1. Run `git status --short`, `git diff --stat`, `git diff`, and `git diff --cached`.
2. Run `git log -10 --format="%h %s"` and inspect repository commitlint/configuration files when present.
3. Record the current `HEAD` before committing so the final sequence can be audited with `<baseline>..HEAD`.
4. Account for every modified, deleted, untracked, and already-staged path. Treat pre-existing or unrelated changes as out of scope unless the user explicitly includes them.

Completion criterion: every working-tree path is understood, its owner/scope is known, and no pre-existing staged content is mistaken for the requested work.

## 2. Build atomic groups

Group by **intent and dependency**, not by directory, file type, application, or arbitrary commit size.

An atomic group:

- produces one coherent behavior, fix, refactor, dependency change, documentation update, or agent-tooling change;
- contains its directly coupled tests, schemas/contracts, migrations, generated lockfile entries, and documentation when separating them would make either commit misleading or unusable;
- excludes changes that can be reviewed and reverted independently;
- leaves each intermediate repository state buildable and testable when practical;
- orders prerequisites before consumers, such as a dependency before code that imports it.

Use patch staging only when a file contains multiple independent intents. Inspect every hunk first and keep coupled hunks together. Never split a test from the behavior it proves merely to manufacture a `test` commit.

Before staging, write a short commit map containing the proposed header, included paths/hunks, intent, and dependency on earlier commits.

Completion criterion: every in-scope hunk belongs to exactly one proposed commit, every group passes the revertability test, and the order respects dependencies.

## 3. Select the semantic type

Choose the type from the commit's observable purpose, not from the files touched:

| Type | Use when the commit… |
| --- | --- |
| `feat` | introduces a new user-, API-, or operator-visible capability |
| `fix` | restores intended behavior or corrects a defect, regression, security issue, or incorrect result |
| `refactor` | changes internal structure while preserving intended observable behavior |
| `perf` | preserves behavior while measurably improving performance |
| `test` | changes tests or fixtures without changing production behavior |
| `docs` | changes human-facing documentation only |
| `build` | changes dependencies, package resolution, compilation, bundling, or build tooling |
| `ci` | changes continuous-integration or delivery automation only |
| `style` | changes formatting only, with no semantic code change |
| `chore` | performs repository maintenance that fits none of the semantic types above |
| `revert` | reverts a named prior commit |

Decision rules:

- A bug discovered during feature work remains `fix` when it is independently revertible; otherwise describe it in the feature commit body.
- Dependency manifests and their lockfile entries form a `build` commit when they enable later code and can stand independently. Keep them with the consumer when the dependency has no valid standalone repository state.
- Deleting replaced code is part of the replacing commit when both express one intent; use `refactor` or `chore` only for independent cleanup.
- Tests, docs, and generated artifacts do not determine the type when they support a production behavior change.

Completion criterion: each type answers what applying the commit does, and changing the chosen type would misdescribe the primary intent.

## 4. Choose the scope and header

Prefer scopes already established by recent repository history. Otherwise use the narrowest stable capability or subsystem name; add the monorepo app/package prefix only when it disambiguates ownership. Avoid filenames, ticket numbers, temporary change names, and multi-concern scopes.

Format the header as:

```text
<type>(<scope>): <imperative description>
```

Header gate:

- English;
- imperative, lowercase description;
- no trailing period;
- one outcome, without `and` joining independent intents;
- at most 72 characters unless repository configuration is stricter;
- `!` before `:` only for an actual breaking change, paired with a footer.

Completion criterion: the header truthfully completes “If applied, this commit will…”, matches local scope conventions, and passes the repository's commit-message rules.

## 5. Write a body when it adds information

Add a body when the reason, constraints, trade-offs, security/privacy impact, data behavior, compatibility, migration, or coupling is not obvious from the header and diff. Omit it for genuinely self-explanatory changes.

Write the body after one blank line. Explain **why** and material consequences; do not narrate filenames or restate the header. Use short paragraphs or bullets. Wrap prose near 72 characters when practical.

Prefer bullet points when the body communicates two or more distinct motivations, behavioral consequences, constraints, or validation notes. Keep each bullet focused on one idea and avoid bullets for a single sentence that reads more clearly as prose.

Use footers for issue references, co-authors, or breaking changes:

```text
BREAKING CHANGE: describe the incompatible behavior and migration path
Refs: ENG-123
```

Add a footer when it improves traceability or communicates structured metadata. Keep issue references out of the header and avoid empty, redundant, or invented footers.

Completion criterion: a reviewer can understand non-obvious motivation and risk without reconstructing them from the implementation.

## 6. Stage, audit, and commit one group at a time

For each mapped group:

1. Run `git add -- <explicit paths>` or use deliberate patch staging.
2. Run `git diff --cached --stat` and `git diff --cached`.
3. Confirm the staged diff contains the complete intent, no secret, no unrelated hunk, and no missing coupled test/contract/lockfile change.
4. Commit with separate `-m` arguments for stable multi-paragraph messages:

   ```powershell
   git commit -m "type(scope): imperative description" -m "- Preserve the first material consequence.`n- Document the second material consequence." -m "Refs: ENG-123"
   ```

5. Read hook output. If a hook modifies files, inspect both `git show --stat --oneline HEAD` and `git status --short` before continuing.
6. Run `git show --format=fuller --stat HEAD` and inspect the committed diff when hooks or patch staging could have changed it.

Keep `git add` and `git commit` as separate commands. On rejection, fix the stated cause, re-audit the cached diff, and retry. Amend only a commit created in the current task and only before later commits depend on it.

Completion criterion: `HEAD` contains exactly the audited staged group and the remaining working tree matches the commit map.

## 7. Verify the sequence

After all commits:

1. Run `git status --short`.
2. Run `git log --format="%h %s" <baseline>..HEAD`.
3. Run `git diff --stat <baseline>..HEAD` and compare it with the original in-scope inventory.
4. Inspect each commit with `git show --stat --oneline <hash>`; inspect full diffs for mixed or patch-staged files.
5. Confirm no in-scope change is uncommitted, no out-of-scope change was committed, every header uses the correct type/scope, and bodies exist where the decision was non-obvious.

Report the ordered commits with hash, header, purpose, checks run, and any intentionally uncommitted paths. Push only when the user separately requests it.

Completion criterion: every original in-scope hunk appears once in the intended commit, the working tree contains only explicitly preserved changes, and the final history is dependency-safe and semantically accurate.
