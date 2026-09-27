/**
 * Installation-wide access policy, embedded in the XPI at build time (docs/ACCESS-CONTROL.md).
 *
 * Enforced here in the add-on, before any side effect — never trusted from CLI/MCP/bridge
 * callers. Shared with scripts/build-xpi.mjs (via Node's vm), which validates the config and
 * derives the manifest's native permissions from it.
 *
 * Every request is classified below. A route with no classification is refused rather than
 * silently let through, so a handler added to background.js without an access-control entry
 * fails closed instead of shipping unrestricted.
 */

const ACCESS_DEFAULTS = Object.freeze({
  downloadAttachments: true,
  compose: true,
  send: true,
  move: true,
  copy: true,
  archive: true,
  delete: false,
  mark: true,
  tag: true,
  tagCreate: true,
  folderCreate: true,
  folderRename: true,
  folderDelete: false,
  contactsWrite: false,
});

function normalizeAccessPolicy(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("INVALID_ARGS: access config must be a JSON object");
  }
  for (const [key, value] of Object.entries(config)) {
    if (!Object.hasOwn(ACCESS_DEFAULTS, key)) throw new Error(`INVALID_ARGS: unknown access setting '${key}'`);
    if (typeof value !== "boolean") throw new Error(`INVALID_ARGS: access setting '${key}' must be boolean`);
  }
  const policy = { ...ACCESS_DEFAULTS, ...config };
  if (policy.send && !policy.compose) throw new Error("INVALID_ARGS: 'send' requires 'compose' to also be true");
  return Object.freeze(policy);
}

const ACCESS_POLICY = normalizeAccessPolicy(globalThis.TB_ACCESS_CONFIG);

// Native permissions only granted when the policy needs them. Every other switch reuses a
// WebExtension permission the manifest always requests, since only deletion has a distinct,
// user-visible install-time permission prompt worth gating.
function accessPermissions(policy, permissions) {
  const result = permissions.filter((p) => p !== "messagesDelete");
  if (policy.delete) result.push("messagesDelete");
  return result;
}

// GET routes, and POST routes that only read, never need a policy switch.
const UNGATED_GET = /^\/(health|access|accounts(?:\/[^/]+(?:\/folders)?)?|identities|tags|stats|contacts(?:\/[^/]+)?|calendars|messages\/\d+(?:\/(raw|headers|full|check-download|download-status|attachments|thread))?)$/;
const UNGATED_POST = new Set([
  "/folders/info", "/messages/search", "/messages/list", "/messages/read-batch",
  "/messages/fetch", "/stats", "/recent", "/contacts/search", "/sync", "/sync/status",
  "/bulk/fetch", "/extension/reload",
]);

// POST routes with one fixed policy switch each.
const WRITE_PATHS = Object.freeze({
  "/messages/move": "move",
  "/messages/copy": "copy",
  "/messages/archive": "archive",
  "/messages/delete": "delete",
  "/bulk/delete": "delete",
  "/bulk/tag": "tag",
  "/tags/create": "tagCreate",
  "/folders/create": "folderCreate",
  "/folders/rename": "folderRename",
  "/folders/delete": "folderDelete",
  "/contacts/create": "contactsWrite",
  "/contacts/update": "contactsWrite",
});

function enforceAccess(method, path, body, policy = ACCESS_POLICY) {
  const requireAccess = (key) => {
    if (!policy[key]) {
      throw Object.assign(
        new Error(`FORBIDDEN: '${key}' is disabled by the add-on access policy (rebuild the XPI with "${key}": true to enable)`),
        { code: "FORBIDDEN" }
      );
    }
  };

  if (method === "GET" && UNGATED_GET.test(path)) return;
  if (method === "POST" && UNGATED_POST.has(path)) return;

  // Attachment content download, distinct from the (ungated) attachment listing.
  if (method === "POST" && /^\/messages\/\d+\/attachment$/.test(path)) {
    return requireAccess("downloadAttachments");
  }

  if (method === "POST" && (path === "/compose" || path === "/compose/edit" || path === "/reply" || path === "/forward")) {
    requireAccess("compose");
    if (body?.send) requireAccess("send");
    return;
  }

  if (method === "POST" && path === "/messages/update") {
    if (body?.tags !== undefined) requireAccess("tag");
    if (["read", "flagged", "junk"].some((key) => body?.[key] !== undefined)) requireAccess("mark");
    return;
  }

  if (method === "POST" && Object.hasOwn(WRITE_PATHS, path)) {
    return requireAccess(WRITE_PATHS[path]);
  }

  throw Object.assign(new Error(`FORBIDDEN: unclassified operation ${method} ${path}`), { code: "FORBIDDEN" });
}
