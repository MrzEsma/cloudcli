import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function requireFromCloudCli(name) {
  try {
    return require(name);
  } catch {
    return require(path.join(process.cwd(), 'node_modules/@cloudcli-ai/cloudcli/node_modules', name));
  }
}

const username = process.env.CLOUDCLI_ADMIN_USERNAME?.trim();
const password = process.env.CLOUDCLI_ADMIN_PASSWORD || '';
const tenantMode = process.env.CLOUDCLI_TENANT_MODE === '1';
const databasePath = process.env.DATABASE_PATH || path.join(os.homedir(), '.cloudcli', 'auth.db');

if (!username && !password) {
  console.log('[cloudcli-init] CLOUDCLI_ADMIN_USERNAME/PASSWORD not set; use first-run setup or mount an existing auth.db.');
  process.exit(0);
}

if (!username || !password) {
  throw new Error('Both CLOUDCLI_ADMIN_USERNAME and CLOUDCLI_ADMIN_PASSWORD must be set.');
}

if (username.length < 3 || password.length < 6) {
  throw new Error('CLOUDCLI_ADMIN_USERNAME must be at least 3 chars and CLOUDCLI_ADMIN_PASSWORD at least 6 chars.');
}

fs.mkdirSync(path.dirname(databasePath), { recursive: true });

const Database = requireFromCloudCli('better-sqlite3');
const bcrypt = requireFromCloudCli('bcrypt');
const db = new Database(databasePath);

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME,
      is_active BOOLEAN DEFAULT 1,
      git_name TEXT,
      git_email TEXT,
      has_completed_onboarding BOOLEAN DEFAULT 0
    );
  `);

  const activeUsers = db.prepare(`
    SELECT id, username, password_hash, has_completed_onboarding
    FROM users WHERE is_active = 1 ORDER BY id
  `).all();
  if (activeUsers.length > 0 && !tenantMode) {
    console.log('[cloudcli-init] auth.db already has a user; admin init skipped.');
    process.exit(0);
  }

  if (activeUsers.length > 1) {
    throw new Error('Tenant auth.db must contain exactly one active user.');
  }

  if (activeUsers.length === 1) {
    const current = activeUsers[0];
    const passwordMatches = await bcrypt.compare(password, current.password_hash);
    if (current.username === username && passwordMatches) {
      if (current.has_completed_onboarding !== 1) {
        db.prepare('UPDATE users SET has_completed_onboarding = 1 WHERE id = ?').run(current.id);
      }
      console.log('[cloudcli-init] tenant login is already synchronized.');
      process.exit(0);
    }
    const passwordHash = await bcrypt.hash(password, 12);
    db.prepare('UPDATE users SET username = ?, password_hash = ?, has_completed_onboarding = 1 WHERE id = ?')
      .run(username, passwordHash, current.id);
    console.log('[cloudcli-init] synchronized the tenant login.');
    process.exit(0);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  db.prepare(`
    INSERT INTO users (username, password_hash, has_completed_onboarding)
    VALUES (?, ?, 1)
  `).run(username, passwordHash);
  console.log('[cloudcli-init] created the initial tenant login.');
} finally {
  db.close();
}
