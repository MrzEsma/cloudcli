# CloudCLI Provider Setup

Tenant-facing CloudCLI tab for direct OpenAI, Hoosh Code proxy (Codex), and
Hoosh Code proxy (Claude Code) authentication. It also renders the read-only
status for an operator-managed iClaude team connection.

- The CloudCLI login middleware protects all plugin RPC calls.
- A direct OpenAI key is validated with OpenAI before it is saved.
- A Hoosh Code key is never sent to OpenAI and configures the tenant-specific
  Codex provider at `CODEX_PROXY_BASE_URL`.
- A Hoosh Code Claude Code token is validated against `CLAUDE_PROXY_BASE_URL`
  the same way Claude Code itself will send it (`ANTHROPIC_AUTH_TOKEN` bearer
  header on the Anthropic-compatible origin) and is stored only in the `env`
  block of the tenant's `~/.claude/settings.json`. Unrelated Claude settings
  always survive writes.
- Each provider validates its own key before it is saved.
- The plugin rejects empty, whitespace-bearing, or oversized key input but does
  not impose an arbitrary provider-token minimum length before validation.
- The plugin writes the file-store schema produced by `codex login
  --with-api-key` atomically instead of starting a Codex subprocess in the HTTP
  request path.
- Credentials stay in the tenant's `~/.codex/auth.json` and
  `~/.claude/settings.json` on its private home PVC.
- API responses never return the saved credential.
- `.cloudcli-user-managed-auth` (Codex) and
  `.cloudcli-claude-user-managed-auth` (Claude Code) prevent the platform
  bootstrap from replacing a tenant-managed credential on later container
  restarts.
- Removing the Claude Code token (`DELETE /credentials/claude`) never touches
  the Codex credential or the tenant's own Claude login state; it only drops
  the Hoosh Code proxy env keys.
- With `CLAUDE_AUTH_MODE=iclaude`, status is read from the non-secret managed
  pod attestation and requires matching server, identity, credential revision,
  and observed Claude Code version before returning `method: iclaude`. The tab shows
  «Claude · حساب تیم», hides key/save/remove fields and the generic proxy card,
  and both Claude configure and delete routes return 403. Responses never
  return the marker's server, version, digest or any setup credential.
- Provider tabs are available before a project/session exists, and model lists
  come from local definitions/cache without a blocking `codex debug` process.
- This OpenAI/Hoosh Code flow remains available alongside CloudCLI's built-in
  Settings connections for Claude, Cursor, Codex and OpenCode. It does not
  replace or share credentials with those provider-owned CLI login stores.

Build and test:

```bash
npm ci
npm test
```
