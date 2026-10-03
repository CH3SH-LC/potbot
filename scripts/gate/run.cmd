@echo off
rem ===================================================================
rem  potbot FA-BOUND-RUN-LEDGER -- bound-candidate gate runner
rem
rem  Wrapper for scripts\gate\run.mjs (same split as
rem  scripts\device\smoke.cmd -> smoke.mjs): a plain "node ..." line so
rem  it can be typed as one command or double clicked, with no
rem  dependence on the PowerShell execution policy.
rem
rem  What it guarantees (external supervision 13:40 group-3 items 4 & 5):
rem    * every run drops its OWN never-overwritten artifact directory
rem      named <timestamp>-<shortHEAD> (HEAD / dirty / command / times /
rem      exit code / raw stdout+stderr / source digest);
rem    * a non-zero exit additionally COPIES that artifact into
rem      <out>\failures\<timestamp>-<shortHEAD>\ -- never in place;
rem    * numbers from two runs may only be compared when HEAD, the
rem      command, the dirty scope and the environment prerequisites
rem      match (see mayCompare in run.mjs).
rem
rem  FA-GATE-RUNNER-FIX:
rem    * pnpm demo:build is auto-injected as a PREREQUISITE of the demo
rem      commands (pnpm test / pnpm demo:test): the default four are
rem      self-sufficient on a fresh worktree;
rem    * with --no-prereq a missing prerequisite is recorded as a
rem      structured SKIP (outcome=skipped_missing_prerequisite, exit
rem      code 78) -- never as a test failure;
rem    * dirty is sampled BEFORE and AFTER every command, so which
rem      command dirtied what is attributable; git status paths outside
rem      the digest scope (e.g. .task-manifest) are listed separately.
rem
rem  Usage:
rem      scripts\gate\run.cmd
rem      scripts\gate\run.cmd --cmd "npx --no-install tsc --noEmit"
rem      scripts\gate\run.cmd --out .dev-evidence\gate --label wave-11
rem      scripts\gate\run.cmd --no-prereq --cmd "pnpm demo:test"
rem      scripts\gate\run.cmd --list
rem
rem  Exit code is the real exit code of run.mjs: a single command is
rem  passed through verbatim; several commands yield the first non-zero
rem  (0 when all pass); a missing prerequisite under --no-prereq yields
rem  78 (not a test failure); 1 means the runner itself failed (bad
rem  argument, artifact already exists, node missing).
rem ===================================================================
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo node.exe was not found on PATH. 1>&2
  exit /b 1
)
node "%~dp0run.mjs" %*
exit /b %ERRORLEVEL%
