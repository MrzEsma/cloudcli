# Tenant agent skills

Skills in this directory are part of the immutable tenant image and are synced
into every tenant home at container startup by `scripts/start-production.sh`:

| Destination | Discovered by |
| --- | --- |
| `~/.claude/skills/<name>` | Claude Code |
| `~/.codex/skills/<name>` | Codex CLI |
| `~/.config/opencode/skill/<name>` | OpenCode |

Each destination receives a real copy (not a symlink) because Codex does not
resolve symlinked `SKILL.md` files. Keep skills agent-facing and self-contained:
a skill documents a capability that exists in the tenant runtime and how to
reach it, and it must stay correct for every agent CLI listed above.
