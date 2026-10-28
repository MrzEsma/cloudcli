import path from 'node:path';

const tenantMode = process.env.CLOUDCLI_TENANT_MODE === '1';
const tenantSlug = process.env.CLOUDCLI_TENANT_SLUG?.trim() || '';

if (!tenantMode) {
  console.log('[cloudcli-project-init] tenant mode is disabled; default project init skipped.');
  process.exit(0);
}

// Old standalone deployments may not have tenant metadata yet. They should
// continue to boot; every newly provisioned tenant gets this value explicitly.
if (!tenantSlug) {
  console.log('[cloudcli-project-init] CLOUDCLI_TENANT_SLUG is not set; default project init skipped.');
  process.exit(0);
}

if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(tenantSlug)) {
  throw new Error('CLOUDCLI_TENANT_SLUG must be a valid lowercase DNS label.');
}

const workspaceRoot = process.env.WORKSPACES_ROOT || process.env.CLOUDCLI_WORKSPACE || '/workspace';
const projectPath = path.join(workspaceRoot, tenantSlug);
const displayName = process.env.CLOUDCLI_TENANT_NAME?.trim() || tenantSlug;

const databaseModule = await import(
  '../node_modules/@cloudcli-ai/cloudcli/dist-server/server/modules/database/index.js'
);
const projectModule = await import(
  '../node_modules/@cloudcli-ai/cloudcli/dist-server/server/modules/projects/services/project-management.service.js'
);
const { closeConnection, initializeDatabase, projectsDb } = databaseModule;

try {
  await initializeDatabase();
  const existingProject = projectsDb.getProjectPath(projectPath);
  if (existingProject && !existingProject.isArchived) {
    console.log(`[cloudcli-project-init] default project already exists: ${projectPath}`);
  } else {
    const result = await projectModule.createProject({ projectPath, customName: displayName });
    console.log(`[cloudcli-project-init] ${result.outcome} default project: ${projectPath}`);
  }
} finally {
  closeConnection();
}
