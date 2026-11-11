import { access, readFile } from "node:fs/promises";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, resolve } from "node:path";
import { atomicPrivateJson, craftPaths, ensureLayout, type CraftPaths } from '../../craft-common/packages/craft-common-store-local/src/paths.ts';

export type ModelProtocol = "openai-compatible" | "anthropic";

/** A context kind is mirrored to an Obsidian-style vault or any local directory. */
export type ContextStorageMode = "off" | "mirror";
export interface ContextStorageTarget { mode: ContextStorageMode; path: string | null; }
export interface ContextStorageConfig { memory: ContextStorageTarget; knowledge: ContextStorageTarget; experience: ContextStorageTarget; }

export interface ModelPricing {
  version: string;
  input_usd_per_million: number;
  output_usd_per_million: number;
  cached_input_usd_per_million?: number;
}

export function normalizeModelPricing(value: unknown): ModelPricing | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("model pricing must be an object");
  const raw = value as Record<string, unknown>;
  if (typeof raw.version !== "string" || !raw.version.trim()) throw new Error("model pricing version is required");
  const pricing: ModelPricing = { version: raw.version.trim(), input_usd_per_million: raw.input_usd_per_million as number, output_usd_per_million: raw.output_usd_per_million as number };
  if (raw.cached_input_usd_per_million !== undefined) pricing.cached_input_usd_per_million = raw.cached_input_usd_per_million as number;
  for (const [key, rate] of Object.entries(pricing)) if (key !== "version" && (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0)) throw new Error("model pricing rates must be non-negative finite numbers");
  return pricing;
}

export interface CraftModelConfig {
  id: string;
  name: string;
  protocol: ModelProtocol;
  baseUrl: string;
  model: string;
  apiKeyEnv: string;
  supportsTools: boolean;
  pricing?: ModelPricing;
}

export interface CraftSettings {
  schemaVersion: 1;
  locale: "zh-CN" | "en-US";
  theme: "system" | "light" | "dark";
  dataRoot: string;
  workbench: { port: number; openOnStart: boolean; codexExecutable: string | null; claudeExecutable: string | null;
    dshExecutable: string | null; dshHome: string | null; dshEntryPath: string | null; dshPluginProfile: string;
    browserMode: "system" | "app"; defaultPermission: "ask" | "auto" | "full"; contextStorage: ContextStorageConfig;
    // Pilot scheduling fan-out. Deterministic coordinator still decides when to
    // split; this only bounds how many already-approved Workers may run at once.
    pilotConcurrency: number;
    // Who signs human decisions (approvals, corrections, subscriptions). Empty
    // means the operator chose not to identify; callers must then say so rather
    // than inventing a name.
    operator: string;
    // First-run guidance (model/workspace setup). Once completedAt is set the
    // workbench never shows the one-time wizard again; a reset clears it.
    onboarding: { completedAt: string | null; workspaceId: string | null; skippedAt?: string | null } };
  lastProvider: string;
  runtime: { maxSteps: number; maxTokens: number };
  models: CraftModelConfig[];
  privacy: { telemetry: boolean };
  updatedAt: string;
}

export type CraftSettingsPatch = Partial<Pick<CraftSettings, "locale" | "theme" | "dataRoot">> & {
  workbench?: Partial<CraftSettings["workbench"]>;
  lastProvider?: string | null;
  runtime?: Partial<CraftSettings["runtime"]>;
  models?: CraftModelConfig[];
  privacy?: Partial<CraftSettings["privacy"]>;
};

function number(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

function boolean(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error(`${name} must be a boolean`);
  return value;
}

function text(value: unknown, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function httpUrl(value: unknown, name: string, fallback: string): string {
  if (value === undefined) return fallback;
  const raw = text(value, name, fallback);
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error(`${name} must be a valid HTTP(S) URL`); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error(`${name} must be http or https`);
  return raw.replace(/\/+$/u, "");
}

function optionalAbsolutePath(value: unknown, name: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be an absolute path or null`);
  const path = value.trim();
  if (!isAbsolute(path)) throw new Error(`${name} must be an absolute path`);
  return resolve(path);
}

const CONTEXT_STORAGE_KINDS = ["memory", "knowledge", "experience"] as const;

const DEFAULT_CONTEXT_STORAGE: ContextStorageConfig = {
  memory: { mode: "off", path: null }, knowledge: { mode: "off", path: null }, experience: { mode: "off", path: null },
};

/**
 * The mirror path is validated as an absolute path here, but the directory is not
 * created: settings must stay loadable even when the vault is on a detached drive.
 */
function normalizeContextStorage(value: unknown): ContextStorageConfig {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const next: ContextStorageConfig = {
    memory: { ...DEFAULT_CONTEXT_STORAGE.memory }, knowledge: { ...DEFAULT_CONTEXT_STORAGE.knowledge }, experience: { ...DEFAULT_CONTEXT_STORAGE.experience },
  };
  for (const kind of CONTEXT_STORAGE_KINDS) {
    const raw = input[kind];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`workbench.contextStorage.${kind} must be an object`);
    const entry = raw as Record<string, unknown>;
    const mode = entry.mode === undefined ? "off" : text(entry.mode, `workbench.contextStorage.${kind}.mode`, "off");
    if (mode !== "off" && mode !== "mirror") throw new Error(`workbench.contextStorage.${kind}.mode must be off or mirror`);
    const path = optionalAbsolutePath(entry.path, `workbench.contextStorage.${kind}.path`);
    if (mode === "mirror" && !path) throw new Error(`workbench.contextStorage.${kind}.path is required when mode is mirror`);
    next[kind] = { mode, path };
  }
  return next;
}

function normalizeModels(value: unknown): CraftModelConfig[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("models must be an array");
  const seen = new Set<string>();
  return value.map(function (item, index) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`models[${index}] must be an object`);
    const entry = item as Record<string, unknown>;
    const id = text(entry.id, `models[${index}].id`, `model-${index}`);
    if (seen.has(id)) throw new Error(`Duplicate model id: ${id}`);
    seen.add(id);
    const protocol = text(entry.protocol, `models[${index}].protocol`, "openai-compatible");
    if (protocol !== "openai-compatible" && protocol !== "anthropic") throw new Error(`models[${index}].protocol must be openai-compatible or anthropic`);
    const supportsTools = entry.supportsTools === undefined ? true : Boolean(entry.supportsTools);
    return {
      id,
      name: text(entry.name, `models[${index}].name`, id),
      protocol: protocol as ModelProtocol,
      baseUrl: httpUrl(entry.baseUrl, `models[${index}].baseUrl`, "https://api.openai.com/v1"),
      model: text(entry.model, `models[${index}].model`, "gpt-4o-mini"),
      apiKeyEnv: text(entry.apiKeyEnv, `models[${index}].apiKeyEnv`, "CRAFT_API_KEY"),
      supportsTools,
      ...(entry.pricing === undefined ? {} : { pricing: normalizeModelPricing(entry.pricing) }),
    };
  });
}

export function defaultSettings(paths = craftPaths()): CraftSettings {
  // `theme` must agree with `normalizeSettings`, which fills a missing theme
  // with "system": the factory and the loader describe the same first launch,
  // so a reset cannot silently pin a different theme than a fresh load.
  return { schemaVersion: 1, locale: "zh-CN", theme: "system", dataRoot: paths.root,
    workbench: { port: 4173, openOnStart: true, codexExecutable: null, claudeExecutable: null,
      dshExecutable: null, dshHome: null, dshEntryPath: null, dshPluginProfile: "craft-plugin-host",
      browserMode: "system", defaultPermission: "ask", contextStorage: normalizeContextStorage(undefined), operator: "",
      pilotConcurrency: 3,
      onboarding: { completedAt: null, workspaceId: null, skippedAt: null } }, lastProvider: "",
    runtime: { maxSteps: 32, maxTokens: 12000 },
    models: [], privacy: { telemetry: false }, updatedAt: new Date(0).toISOString() };
}

export function normalizeSettings(value: unknown, paths = craftPaths()): CraftSettings {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const workbench = input.workbench && typeof input.workbench === "object" && !Array.isArray(input.workbench) ? input.workbench as Record<string, unknown> : {};
  const runtime = input.runtime && typeof input.runtime === "object" && !Array.isArray(input.runtime) ? input.runtime as Record<string, unknown> : {};
  const privacy = input.privacy && typeof input.privacy === "object" && !Array.isArray(input.privacy) ? input.privacy as Record<string, unknown> : {};
  const dataRoot = resolve(text(input.dataRoot, "dataRoot", paths.root));
  const locale = text(input.locale, "locale", "zh-CN");
  if (locale !== "zh-CN" && locale !== "en-US") throw new Error("locale must be zh-CN or en-US");
  const theme = text(input.theme, "theme", "system");
  if (theme !== "system" && theme !== "light" && theme !== "dark") throw new Error("theme must be system, light, or dark");
  const updatedAt = text(input.updatedAt, "updatedAt", new Date(0).toISOString());
  if (Number.isNaN(Date.parse(updatedAt))) throw new Error("updatedAt must be an ISO timestamp");
  const browserMode = text(workbench.browserMode, "workbench.browserMode", "system");
  if (browserMode !== "system" && browserMode !== "app") throw new Error("workbench.browserMode must be system or app");
  const defaultPermission = text(workbench.defaultPermission, "workbench.defaultPermission", "ask");
  if (defaultPermission !== "ask" && defaultPermission !== "auto" && defaultPermission !== "full") throw new Error("workbench.defaultPermission must be ask, auto, or full");
  const dshPluginProfile = text(workbench.dshPluginProfile, "workbench.dshPluginProfile", "craft-plugin-host");
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(dshPluginProfile)) throw new Error("workbench.dshPluginProfile must be a profile identifier");
  const lastProviderValue = input.lastProvider;
  if (lastProviderValue !== undefined && lastProviderValue !== null && typeof lastProviderValue !== "string") throw new Error("lastProvider must be a string");
  const lastProvider = typeof lastProviderValue === "string" ? lastProviderValue.trim() : "";
  if (lastProvider && !/^[A-Za-z0-9_-]{1,32}$/u.test(lastProvider)) throw new Error("lastProvider must be an identifier");
  const operatorValue = workbench.operator;
  if (operatorValue !== undefined && operatorValue !== null && typeof operatorValue !== "string") throw new Error("workbench.operator must be a string");
  const operator = typeof operatorValue === "string" ? operatorValue.trim() : "";
  if (operator.length > 64) throw new Error("workbench.operator must be 64 characters or fewer");
  if (/[\r\n\0]/u.test(operator)) throw new Error("workbench.operator must be a single line");
  const onboardingRaw = workbench.onboarding && typeof workbench.onboarding === "object" && !Array.isArray(workbench.onboarding) ? workbench.onboarding as Record<string, unknown> : {};
  const onboardingCompletedAt = onboardingRaw.completedAt === null || onboardingRaw.completedAt === undefined
    ? null
    : text(onboardingRaw.completedAt, "workbench.onboarding.completedAt", new Date(0).toISOString());
  if (onboardingCompletedAt !== null && Number.isNaN(Date.parse(onboardingCompletedAt))) throw new Error("workbench.onboarding.completedAt must be an ISO timestamp");
  const onboardingSkippedAt = onboardingRaw.skippedAt === null || onboardingRaw.skippedAt === undefined
    ? null : text(onboardingRaw.skippedAt, "workbench.onboarding.skippedAt", new Date(0).toISOString());
  if (onboardingSkippedAt !== null && Number.isNaN(Date.parse(onboardingSkippedAt))) throw new Error("workbench.onboarding.skippedAt must be an ISO timestamp");
  const onboardingWorkspaceId = onboardingRaw.workspaceId === null || onboardingRaw.workspaceId === undefined
    ? null
    : text(onboardingRaw.workspaceId, "workbench.onboarding.workspaceId", "workspace");
  if (onboardingWorkspaceId !== null && !/^[A-Za-z0-9_-]{1,64}$/u.test(onboardingWorkspaceId)) throw new Error("workbench.onboarding.workspaceId must be an identifier");
  return { schemaVersion: 1, locale: locale as CraftSettings["locale"], theme: theme as CraftSettings["theme"], dataRoot,
    workbench: { port: number(workbench.port, "workbench.port", 4173, 0, 65535), openOnStart: boolean(workbench.openOnStart, "workbench.openOnStart", true),
      codexExecutable: optionalAbsolutePath(workbench.codexExecutable, "workbench.codexExecutable"), browserMode: browserMode as CraftSettings["workbench"]["browserMode"],
      claudeExecutable: optionalAbsolutePath(workbench.claudeExecutable, "workbench.claudeExecutable"),
      dshExecutable: optionalAbsolutePath(workbench.dshExecutable, "workbench.dshExecutable"),
      dshHome: optionalAbsolutePath(workbench.dshHome, "workbench.dshHome"),
      dshEntryPath: optionalAbsolutePath(workbench.dshEntryPath, "workbench.dshEntryPath"),
      dshPluginProfile,
      defaultPermission: defaultPermission as CraftSettings["workbench"]["defaultPermission"],
      pilotConcurrency: number(workbench.pilotConcurrency, "workbench.pilotConcurrency", 3, 1, 8),
      contextStorage: normalizeContextStorage(workbench.contextStorage), operator,
      onboarding: { completedAt: onboardingCompletedAt, workspaceId: onboardingWorkspaceId, skippedAt: onboardingSkippedAt } },
    lastProvider,
    runtime: { maxSteps: number(runtime.maxSteps, "runtime.maxSteps", 32, 1, 10000), maxTokens: number(runtime.maxTokens, "runtime.maxTokens", 12000, 1, 100000000) },
    models: normalizeModels(input.models),
    privacy: { telemetry: boolean(privacy.telemetry, "privacy.telemetry", false) }, updatedAt };
}

export async function loadSettings(paths = craftPaths()): Promise<CraftSettings> {
  await ensureLayout(paths);
  try { await access(paths.settingsFile); return normalizeSettings(JSON.parse((await readFile(paths.settingsFile, "utf8")).replace(/^\uFEFF/u, "")), paths); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return defaultSettings(paths);
    const settings = defaultSettings(paths); await atomicPrivateJson(paths.settingsFile, settings); return settings;
  }
}

export async function saveSettings(patch: CraftSettingsPatch, paths = craftPaths(), now = new Date()): Promise<CraftSettings> {
  const current = await loadSettings(paths);
  const next = normalizeSettings({ ...current, ...patch,
    workbench: { ...current.workbench, ...(patch.workbench ?? {}) }, runtime: { ...current.runtime, ...(patch.runtime ?? {}) },
    models: [current.models, patch.models][Number(patch.models !== undefined)],
    privacy: { ...current.privacy, ...(patch.privacy ?? {}) }, updatedAt: now.toISOString() }, paths);
  await atomicPrivateJson(paths.settingsFile, next); return next;
}

export async function resetSettings(paths = craftPaths(), now = new Date()): Promise<CraftSettings> {
  const next = { ...defaultSettings(paths), updatedAt: now.toISOString() }; await atomicPrivateJson(paths.settingsFile, next); return next;
}

function syncWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true }); const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 }); renameSync(temporary, path);
}

export function loadSettingsSync(paths = craftPaths()): CraftSettings {
  if (!existsSync(paths.settingsFile)) { const settings = defaultSettings(paths); syncWrite(paths.settingsFile, settings); return settings; }
  try { return normalizeSettings(JSON.parse(readFileSync(paths.settingsFile, "utf8").replace(/^\uFEFF/u, "")), paths); }
  catch { return defaultSettings(paths); }
}

export function saveSettingsSync(patch: CraftSettingsPatch, paths = craftPaths(), now = new Date()): CraftSettings {
  const current = loadSettingsSync(paths); const next = normalizeSettings({ ...current, ...patch,
    workbench: { ...current.workbench, ...(patch.workbench ?? {}) }, runtime: { ...current.runtime, ...(patch.runtime ?? {}) },
    models: patch.models !== undefined ? patch.models : current.models,
    privacy: { ...current.privacy, ...(patch.privacy ?? {}) }, updatedAt: now.toISOString() }, paths); syncWrite(paths.settingsFile, next); return next;
}

/** True once the one-time first-run wizard has been completed and dismissed. */
export function isOnboardingComplete(settings: CraftSettings): boolean {
  return settings.workbench.onboarding.completedAt !== null;
}

/** Record first-run completion; idempotent and never overwrites an earlier stamp. */
export function markOnboardingComplete(paths = craftPaths(), now = new Date(), workspaceId: string | null = null): CraftSettings {
  const current = loadSettingsSync(paths);
  if (isOnboardingComplete(current)) return current;
  return saveSettingsSync({ workbench: { onboarding: { completedAt: now.toISOString(), workspaceId } } } as CraftSettingsPatch, paths, now);
}

/** Forcibly clear first-run completion (used by a settings reset). */
export function resetOnboarding(paths = craftPaths(), now = new Date()): CraftSettings {
  return saveSettingsSync({ workbench: { onboarding: { completedAt: null, workspaceId: null } } } as CraftSettingsPatch, paths, now);
}

export function resetSettingsSync(paths = craftPaths(), now = new Date()): CraftSettings {
  const next = { ...defaultSettings(paths), updatedAt: now.toISOString() }; syncWrite(paths.settingsFile, next); return next;
}

export function publicSettings(settings: CraftSettings, paths = craftPaths()): Record<string, unknown> {
  return { ...settings, settingsFile: paths.settingsFile, dataRoot: settings.dataRoot, restartRequiredForDataRoot: settings.dataRoot !== paths.root,
    secretsStored: false, note: "Credentials remain in environment variables or host stores; settings.json never contains API keys." };
}
