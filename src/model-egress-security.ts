import type { JsonObject } from 'craft-common-store-local';
import { DEFAULT_RULES, Sanitizer } from '@craft/capability-datasec/rules';

export interface EgressProviderBinding { base_url: string; chat_path: string }
export interface EgressRequestBinding { url: string; body: JsonObject }

const SENSITIVE_PROPERTY = /(?:password|passwd|pwd|token|secret|credential|api[_-]?key|authorization|cookie)/iu;

function scrubText(value: string, sanitizer: Sanitizer): string {
  return sanitizer.text(value).replace(/((?:api[_-]?key|authorization|cookie|password|secret|credential|token)["']?\s*[:=]\s*["']?(?:bearer\s+)?)([^\s"',;}]+)/giu, "$1[REDACTED]");
}

function redactExample(value: unknown, depth: number): unknown {
  if (depth > 64) throw new Error("Model request nesting exceeds redaction limit");
  if (typeof value === "string") return "[REDACTED]";
  if (Array.isArray(value)) return value.map(item => redactExample(item, depth + 1));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactExample(item, depth + 1)]));
  return value;
}

function scrubValue(value: unknown, sanitizer: Sanitizer, depth = 0, sensitive = false, schema = false): unknown {
  if (depth > 64) throw new Error("Model request nesting exceeds redaction limit");
  if (typeof value === "string") return sensitive && !schema ? "[REDACTED]" : scrubText(value, sanitizer);
  if (Array.isArray(value)) return value.map(item => scrubValue(item, sanitizer, depth + 1, sensitive, schema));
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (schema && key === "properties" && item !== null && typeof item === "object" && !Array.isArray(item)) {
      return [key, Object.fromEntries(Object.entries(item).map(([property, childSchema]) => [property,
        scrubValue(childSchema, sanitizer, depth + 2, SENSITIVE_PROPERTY.test(property), true)]))];
    }
    if (schema && sensitive && ["default", "example", "examples", "enum", "const"].includes(key)) return [key, redactExample(item, depth + 1)];
    const childSchema = schema || key === "parameters" || key === "input_schema" || key === "codex_output_schema";
    return [key, scrubValue(item, sanitizer, depth + 1, sensitive || (!schema && SENSITIVE_PROPERTY.test(key)), childSchema)];
  }));
  return value;
}

/** Final content and destination check used immediately before a transport sends bytes. */
export function sanitizeModelEgressRequest<T extends EgressRequestBinding>(spec: EgressProviderBinding, request: T): T {
  if (request.url !== `${spec.base_url}${spec.chat_path}`) throw new Error("Model request destination does not match the configured provider");
  if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) throw new Error("Model request body must be an object");
  const sanitizer = new Sanitizer(DEFAULT_RULES.map(rule => ({ ...rule, enabled: true })), () => "[REDACTED]");
  return { ...request, body: scrubValue(request.body, sanitizer) as JsonObject };
}
