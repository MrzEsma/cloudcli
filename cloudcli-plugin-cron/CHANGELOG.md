# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog, and this project uses semantic version tags for GitHub releases.

## [Unreleased]

### Added

- Explicit Codex presets for low-cost Luna, balanced Terra, and quality-first Sol scheduled runs
- Run-history metadata showing the selected Codex model and reasoning effort
- Automatic CLI resolution through host-provided paths, `PATH`, and common CloudCLI locations

### Changed

- Build-time TypeScript dependencies are installed as runtime dependencies because CloudCLI builds
  plugins after a production-mode install
- Codex scheduled runs are ephemeral to avoid accumulating resumable CLI sessions

### Fixed

- Claude schedules now reuse the authenticated CloudCLI host's Claude proxy environment on Linux
  without persisting credentials or exposing them to non-Claude commands
- CloudCLI container installs no longer fail with `spawn codex ENOENT` when Codex is bundled under
  `/app/node_modules/.bin`
- Production-only plugin builds no longer depend on Vitest type definitions
- Missing executables now produce an actionable invalid configuration state before a run starts
- Backend dashboard tests now execute in a Node environment while explicitly providing JSDOM for UI coverage

### Quality

- Added real command-resolution, model-metadata, and run-history regression coverage
- Updated the test toolchain to patched dependency versions with a clean npm audit
- Verified an end-to-end HTTP run against `gpt-5.6-luna` with low reasoning

## [0.1.0] - 2026-04-26

Initial public release of `Scheduled Prompt`, a local-first CloudCLI / ClaudeCodeUI plugin for workspace-scoped scheduled prompts.

### Added

- Plugin tab UI for creating and editing scheduled prompts per workspace
- Supported schedule types:
  - one-time
  - daily
  - selected weekdays
  - weekly
  - monthly
- Local execution through configurable commands with presets for:
  - Codex
  - Claude Code
  - Gemini CLI
- Per-workspace persistence for schedules, execution settings, and run history
- Schedule lifecycle controls:
  - pause
  - resume
  - duplicate
  - delete
  - run now
  - retry
- Recent run history with `running`, `succeeded`, `failed`, and `missed` states
- Workspace-scoped recurrence summaries and next-run previews
- Initial user documentation in [README.md](/home/sorg/CloudCLI/cloudcli-cron/README.md)
- Quickstart and feature design artifacts under [specs/001-workspace-scheduled-prompts](/home/sorg/CloudCLI/cloudcli-cron/specs/001-workspace-scheduled-prompts)

### Changed

- Final plugin display name set to `Scheduled Prompt`
- Codex preset normalized to use the supported global approval flags layout

### Fixed

- Safe rendering of run output and failure text in the UI without HTML injection
- Validation of whitespace-only task updates and invalid weekday values
- Scheduler behavior for repeated missed recurring runs after downtime
- UI reconciliation so failed refreshes do not incorrectly show success states

### Quality

- Automated coverage for:
  - RPC contract validation
  - recurrence edge cases
  - scheduler integration
  - execution adapter behavior
  - frontend jsdom interaction flows
  - lightweight performance fixture for 100 tasks and 500 runs
