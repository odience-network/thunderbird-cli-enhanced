/**
 * Installation-wide access policy, embedded in the XPI at build time (docs/ACCESS-CONTROL.md).
 *
 * Enforced here in the add-on, before any side effect — never trusted from CLI/MCP/bridge
 * callers. Shared with scripts/build-xpi.mjs (via Node's vm), which validates the config and
 * derives the manifest's native permissions from it.
 */

const ACCESS_DEFAULTS = Object.freeze({
  delete: false,
  folderDelete: false,
});

function normalizeAccessPolicy(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("INVALID_ARGS: access config must be a JSON object");
  }
  for (const [key, value] of Object.entries(config)) {
    if (!Object.hasOwn(ACCESS_DEFAULTS, key)) throw new Error(`INVALID_ARGS: unknown access setting '${key}'`);
    if (typeof value !== "boolean") throw new Error(`INVALID_ARGS: access setting '${key}' must be boolean`);
  }
  return Object.freeze({ ...ACCESS_DEFAULTS, ...config });
}

const ACCESS_POLICY = normalizeAccessPolicy(globalThis.TB_ACCESS_CONFIG);

// POST routes that need a policy switch. Everything else is unaffected by this policy.
const GATED_PATHS = Object.freeze({
  "/messages/delete": "delete",
  "/bulk/delete": "delete",
  "/folders/delete": "folderDelete",
});

// Native permissions only granted when the policy needs them.
function accessPermissions(policy, permissions) {
  const result = permissions.filter((p) => p !== "messagesDelete");
  if (policy.delete) result.push("messagesDelete");
  return result;
}

function enforceAccess(method, path, policy = ACCESS_POLICY) {
  if (method !== "POST" || !Object.hasOwn(GATED_PATHS, path)) return;
  const key = GATED_PATHS[path];
  if (!policy[key]) {
    throw Object.assign(
      new Error(`FORBIDDEN: '${key}' is disabled by the add-on access policy (rebuild the XPI with "${key}": true to enable)`),
      { code: "FORBIDDEN" }
    );
  }
}
