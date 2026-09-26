/**
 * The integration surface other domains import.
 *
 * Canvas-only (docs/design/canvas-only-integration.md): `inject.ts` owns what
 * a canvas launch carries, `migrate.ts` the one-time removal of the old global
 * installs, `integration.ts` what the settings page reads and does. The
 * per-CLI modules only know their CLI's own file shapes — needed now to take
 * an old install back out, and for Codex to compute the trust it requires.
 */
export * from "./events";
export * from "./shared";
export {
  INJECTED_AGENTS,
  type Injection,
  type InjectionRequest,
  artifactLayout,
  canvasInjection,
  integrationDir,
  prepareInjection,
} from "./inject";
export { migrateGlobalInstalls, readMigration } from "./migrate";
export { modulePath, piExtensionPath, opencodePluginPath } from "./extensions";
export {
  hookHash,
  hooksPath as codexHooksPath,
  configPath as codexConfigPath,
} from "./codex";
export { hooksPath as copilotHooksPath } from "./copilot";
export { settingsPath as claudeSettingsPath } from "./claude";
