/**
 * MCP tool definitions for thunderbird-cli.
 *
 * Each tool has:
 *   - name: tool identifier exposed to MCP clients
 *   - description: what the tool does (read by the LLM)
 *   - inputSchema: JSON Schema for arguments
 *   - handler: async (args, api) => result — calls bridge HTTP API
 *
 * `api` is injected by the server: api(method, path, body?) → response
 */

import { parseRelativeDate } from "./client.js";
import { listNotes, readNote, saveNote, appendNote, renderNoteHtml } from "./notes.js";
import {
  startOfDay,
  addDays,
  renderToday,
  renderWeek,
  renderClashes,
  groupMessagesIntoThreads,
  renderFrom,
} from "../../lib/skills.js";

// /calendar/events/list and /calendar/clashes return { error } (not a thrown error) when the
// calendar Experiment API hasn't loaded — see docs/decisions/calendar-backend.md.
function calendarErrorOf(result) {
  return !Array.isArray(result) && result?.error ? result.error : null;
}

export const tools = [
  // ─── 0. Calendar list (ODIAA-2327 proof, read-only) ─────────────
  {
    name: "calendar_list",
    description:
      "List calendars registered in Thunderbird (id, name, type, url, read-only/enabled state, color). Requires the calendar Experiment API to be built into the add-on — see docs/decisions/calendar-backend.md. For events within a calendar, see calendar_events/calendar_event_create/calendar_event_update/calendar_event_delete.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async (args, api) => {
      return await api("GET", "/calendars");
    },
  },

  // ─── 1. Stats ──────────────────────────────────────────────────
  {
    name: "email_stats",
    description:
      "Get an overview of all email accounts: total accounts, unread counts, message totals. Optionally filter to a single account or include per-folder breakdown.",
    inputSchema: {
      type: "object",
      properties: {
        accountId: {
          type: "string",
          description: "Optional: limit stats to a specific account ID",
        },
        includeFolders: {
          type: "boolean",
          description: "Include per-folder breakdown",
          default: false,
        },
      },
    },
    handler: async (args, api) => {
      if (args.accountId || args.includeFolders) {
        return await api("POST", "/stats", {
          accountId: args.accountId,
          folders: args.includeFolders,
        });
      }
      return await api("GET", "/stats");
    },
  },

  // ─── 2. Search ─────────────────────────────────────────────────
  {
    name: "email_search",
    description:
      "Search for emails across all accounts. The general query searches body, subject, and sender with OR logic. Add field-specific filters (from, to, subject) as AND constraints. Excludes junk by default.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "General search query — searches across message body, subject, and sender (OR logic). Use subject/from/to for field-specific AND filters. Optional when at least one filter is given.",
        },
        accountId: { type: "string", description: "Limit to specific account" },
        folderId: { type: "string", description: "Limit to specific folder" },
        from: { type: "string", description: "Filter by sender address" },
        to: { type: "string", description: "Filter by recipient address" },
        subject: { type: "string", description: "Filter by subject substring" },
        unread: { type: "boolean", description: "Unread only" },
        flagged: { type: "boolean", description: "Flagged/starred only" },
        tag: { type: "string", description: "Filter by tag key (e.g. $label1)" },
        since: {
          type: "string",
          description:
            "Start date (ISO 8601 or relative: '7d', '2w', '3m', '1y', 'today', 'yesterday')",
        },
        until: { type: "string", description: "End date (ISO or relative)" },
        hasAttachment: { type: "boolean", description: "Only with attachments" },
        sizeMin: { type: "number", description: "Minimum message size in bytes" },
        sizeMax: { type: "number", description: "Maximum message size in bytes" },
        includeJunk: {
          type: "boolean",
          description: "Include junk messages (default: false)",
        },
        limit: { type: "number", description: "Max results", default: 25 },
      },
    },
    handler: async (args, api) => {
      const query = args.query?.trim();
      const hasFilter = [
        "accountId", "folderId", "from", "to", "subject", "unread", "flagged",
        "tag", "since", "until", "hasAttachment", "sizeMin", "sizeMax",
      ].some((key) => args[key]);
      if (!query && !hasFilter) {
        throw Object.assign(
          new Error("email_search requires a query or at least one filter"),
          { code: "INVALID_ARGS" }
        );
      }
      const body = { limit: args.limit || 25 };
      if (query) body.query = query;
      if (args.accountId) body.accountId = args.accountId;
      if (args.folderId) body.folderId = args.folderId;
      if (args.from) body.fromAddress = args.from;
      if (args.to) body.toAddress = args.to;
      if (args.subject) body.subject = args.subject;
      if (args.unread) body.unreadOnly = true;
      if (args.flagged) body.flagged = true;
      if (args.tag) body.tag = args.tag;
      if (args.since) body.fromDate = parseRelativeDate(args.since);
      if (args.until) body.toDate = parseRelativeDate(args.until);
      if (args.hasAttachment) body.hasAttachment = true;
      if (args.sizeMin) body.sizeMin = args.sizeMin;
      if (args.sizeMax) body.sizeMax = args.sizeMax;
      if (args.includeJunk) body.includeJunk = true;
      return await api("POST", "/messages/search", body);
    },
  },

  // ─── 3. List ───────────────────────────────────────────────────
  {
    name: "email_list",
    description:
      "List messages in a specific folder. Use email_folders first to get folder IDs. Supports pagination and sorting.",
    inputSchema: {
      type: "object",
      properties: {
        folderId: {
          type: "string",
          description: "Folder ID (e.g. 'account1://INBOX')",
        },
        unread: { type: "boolean", description: "Unread only" },
        flagged: { type: "boolean", description: "Flagged only" },
        offset: { type: "number", description: "Skip first N (pagination)" },
        sort: {
          type: "string",
          enum: ["date", "from", "subject", "size"],
          description: "Sort field",
        },
        sortOrder: {
          type: "string",
          enum: ["asc", "desc"],
          description: "Sort direction",
        },
        limit: { type: "number", description: "Max results", default: 25 },
      },
      required: ["folderId"],
    },
    handler: async (args, api) => {
      const body = { folderId: args.folderId, limit: args.limit || 25 };
      if (args.unread) body.unreadOnly = true;
      if (args.flagged) body.flagged = true;
      if (args.offset) body.offset = args.offset;
      if (args.sort) body.sort = args.sort;
      if (args.sortOrder) body.sortOrder = args.sortOrder;
      return await api("POST", "/messages/list", body);
    },
  },

  // ─── 4. Read ───────────────────────────────────────────────────
  {
    name: "email_read",
    description:
      "Read a specific email message. Modes: 'default' (headers + text body), 'headers' (cheapest), 'full' (with HTML), 'raw' (RFC822). Use maxBody to truncate long messages.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "number",
          description: "Thunderbird internal message ID",
        },
        mode: {
          type: "string",
          enum: ["default", "headers", "full", "raw", "check-download"],
          description: "Read mode",
          default: "default",
        },
        maxBody: {
          type: "number",
          description: "Truncate body to N characters",
        },
      },
      required: ["messageId"],
    },
    handler: async (args, api) => {
      const id = args.messageId;
      const mode = args.mode || "default";
      let result;
      if (mode === "raw") result = await api("GET", `/messages/${id}/raw`);
      else if (mode === "headers") result = await api("GET", `/messages/${id}/headers`);
      else if (mode === "full") result = await api("GET", `/messages/${id}/full`);
      else if (mode === "check-download")
        result = await api("GET", `/messages/${id}/check-download`);
      else result = await api("GET", `/messages/${id}`);

      // Apply maxBody truncation
      if (args.maxBody && result?.parts?.text && result.parts.text.length > args.maxBody) {
        result.parts.text = result.parts.text.slice(0, args.maxBody) + "\n...[truncated]";
        result.parts.textTruncated = true;
      }
      return result;
    },
  },

  // ─── 5. Thread ─────────────────────────────────────────────────
  {
    name: "email_thread",
    description:
      "Get the full conversation thread for a message — all related messages sorted chronologically, resolved across accounts via References/In-Reply-To headers.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "number", description: "Message ID" },
      },
      required: ["messageId"],
    },
    handler: async (args, api) => {
      return await api("GET", `/messages/${args.messageId}/thread`);
    },
  },

  // ─── 6. Compose ────────────────────────────────────────────────
  {
    name: "email_compose",
    description:
      "Compose a new email. Default mode is 'draft' (saved to Drafts folder, not sent). Use mode='send' to send immediately, mode='open' to open in Thunderbird's compose window for human review. ALWAYS prefer draft mode unless the human explicitly asked to send.",
    inputSchema: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description: "Recipient(s), comma-separated for multiple",
        },
        cc: { type: "string", description: "CC recipients" },
        bcc: { type: "string", description: "BCC recipients" },
        subject: { type: "string", description: "Subject line" },
        body: { type: "string", description: "Message body (plain text)" },
        html: {
          type: "boolean",
          description: "Treat body as HTML",
          default: false,
        },
        from: {
          type: "string",
          description:
            "Identity ID to send from (use email_identities-equivalent or check email_stats for accounts)",
        },
        priority: {
          type: "string",
          enum: ["highest", "high", "normal", "low", "lowest"],
        },
        mode: {
          type: "string",
          enum: ["draft", "open", "send"],
          description: "draft (default, saves silently), open (compose window), send (immediate)",
          default: "draft",
        },
      },
      required: ["to", "body"],
    },
    handler: async (args, api) => {
      const payload = {
        to: args.to,
        subject: args.subject || "",
        body: args.body,
        isHTML: args.html || false,
      };
      if (args.cc) payload.cc = args.cc;
      if (args.bcc) payload.bcc = args.bcc;
      if (args.from) payload.identityId = args.from;
      if (args.priority) payload.priority = args.priority;
      const mode = args.mode || "draft";
      if (mode === "send") payload.send = true;
      else if (mode === "open") payload.open = true;
      else payload.draft = true;
      return await api("POST", "/compose", payload);
    },
  },

  // ─── 7. Reply ──────────────────────────────────────────────────
  {
    name: "email_reply",
    description:
      "Reply to a message. Default mode is 'draft'. Use mode='send' for immediate send. Set replyAll=true to reply to all recipients. The earlier thread is appended below the reply as quoted conversation history by default; set includeHistory=false to omit it.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "number", description: "Message ID to reply to" },
        body: { type: "string", description: "Reply body" },
        replyAll: { type: "boolean", description: "Reply to all recipients" },
        from: { type: "string", description: "Thunderbird identity ID to reply from (default: inferred from the message account)" },
        subject: { type: "string", description: "Override the subject (default: Thunderbird's, Re:-prefixed)" },
        includeHistory: { type: "boolean", description: "Append the earlier thread as quoted conversation history (default: true)" },
        mode: {
          type: "string",
          enum: ["draft", "open", "send"],
          default: "draft",
        },
      },
      required: ["messageId", "body"],
    },
    handler: async (args, api) => {
      const payload = {
        messageId: args.messageId,
        body: args.body,
        replyAll: args.replyAll || false,
        includeHistory: args.includeHistory !== false,
      };
      if (args.from) payload.identityId = args.from;
      if (args.subject) payload.subject = args.subject;
      const mode = args.mode || "draft";
      if (mode === "send") payload.send = true;
      else if (mode === "open") payload.open = true;
      else payload.draft = true;
      return await api("POST", "/reply", payload);
    },
  },

  // ─── 8. Forward ────────────────────────────────────────────────
  {
    name: "email_forward",
    description:
      "Forward a message to a new recipient. Default mode is 'draft' for human review. The earlier thread is appended below the body as quoted conversation history by default; set includeHistory=false to omit it.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "number", description: "Message ID to forward" },
        to: { type: "string", description: "Recipient address" },
        body: { type: "string", description: "Optional additional text" },
        from: { type: "string", description: "Thunderbird identity ID to forward from (default: inferred from the message account)" },
        includeHistory: { type: "boolean", description: "Append the earlier thread as quoted conversation history (default: true)" },
        mode: {
          type: "string",
          enum: ["draft", "open", "send"],
          default: "draft",
        },
      },
      required: ["messageId", "to"],
    },
    handler: async (args, api) => {
      const payload = {
        messageId: args.messageId,
        to: args.to,
        body: args.body || "",
        includeHistory: args.includeHistory !== false,
      };
      if (args.from) payload.identityId = args.from;
      const mode = args.mode || "draft";
      if (mode === "send") payload.send = true;
      else if (mode === "open") payload.open = true;
      else payload.draft = true;
      return await api("POST", "/forward", payload);
    },
  },

  // ─── 9. Edit draft ─────────────────────────────────────────────
  {
    name: "email_edit",
    description:
      "Edit an existing draft message in place. Only works on messages in a Drafts folder. Pass only the fields you want to change (to, cc, bcc, subject, body, from, priority). Default mode is 'draft' (save silently). The saved draft messageId may change after save (IMAP) — always use the returned messageId. Use mode='open' to open in Thunderbird for human review, mode='send' to send immediately.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: {
          type: "number",
          description: "Draft message ID to edit",
        },
        to: {
          type: "string",
          description: "Replace To recipients (comma-separated)",
        },
        cc: { type: "string", description: "Replace CC recipients" },
        bcc: { type: "string", description: "Replace BCC recipients" },
        subject: { type: "string", description: "New subject line" },
        body: { type: "string", description: "Replace message body" },
        html: {
          type: "boolean",
          description: "Treat body as HTML (only applies when the draft is HTML)",
          default: false,
        },
        from: {
          type: "string",
          description: "Identity ID to send from",
        },
        priority: {
          type: "string",
          enum: ["highest", "high", "normal", "low", "lowest"],
        },
        mode: {
          type: "string",
          enum: ["draft", "open", "send"],
          description: "draft (default, saves silently), open (compose window), send (immediate)",
          default: "draft",
        },
      },
      required: ["messageId"],
    },
    handler: async (args, api) => {
      const payload = { messageId: args.messageId };
      if (args.to !== undefined) payload.to = args.to;
      if (args.cc !== undefined) payload.cc = args.cc;
      if (args.bcc !== undefined) payload.bcc = args.bcc;
      if (args.subject !== undefined) payload.subject = args.subject;
      if (args.body !== undefined) {
        payload.body = args.body;
        payload.isHTML = args.html || false;
      }
      if (args.from) payload.identityId = args.from;
      if (args.priority) payload.priority = args.priority;

      const mode = args.mode || "draft";
      if (mode === "send") payload.send = true;
      else if (mode === "open") payload.open = true;
      else payload.draft = true;

      return await api("POST", "/compose/edit", payload);
    },
  },

  // ─── 10. Mark ───────────────────────────────────────────────────
  {
    name: "email_mark",
    description:
      "Update message flags: read/unread, flagged/unflagged, junk/not-junk. Accepts a single ID or array of IDs for batch operations.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "number" },
          description: "Message IDs",
        },
        read: { type: "boolean", description: "Mark as read (true) or unread (false)" },
        flagged: { type: "boolean", description: "Flag (true) or unflag (false)" },
        junk: { type: "boolean", description: "Mark junk (true) or not-junk (false)" },
      },
      required: ["messageIds"],
    },
    handler: async (args, api) => {
      const props = {};
      if (args.read !== undefined) props.read = args.read;
      if (args.flagged !== undefined) props.flagged = args.flagged;
      if (args.junk !== undefined) props.junk = args.junk;
      const results = [];
      for (const id of args.messageIds) {
        results.push(await api("POST", "/messages/update", { messageId: id, ...props }));
      }
      return { success: true, updated: results.length };
    },
  },

  // ─── 11. Archive / Move / Delete ───────────────────────────────
  {
    name: "email_archive",
    description:
      "Archive, move, or delete messages. Operations: 'archive' (move to archive folder), 'move' (to specific folder), 'delete' (to trash). Permanent delete requires confirm=true. 'delete' is refused (FORBIDDEN) unless the Thunderbird add-on was built with access policy delete=true; use 'move' to Trash instead. archive and non-permanent delete mark messages read by default; pass keepUnread=true to keep unread state.",
    inputSchema: {
      type: "object",
      properties: {
        messageIds: {
          type: "array",
          items: { type: "number" },
          description: "Message IDs",
        },
        operation: {
          type: "string",
          enum: ["archive", "move", "delete"],
          description: "Operation type",
        },
        destinationFolderId: {
          type: "string",
          description: "Required for 'move' operation",
        },
        permanent: {
          type: "boolean",
          description: "For delete: skip trash (requires confirm)",
        },
        confirm: {
          type: "boolean",
          description: "Required for permanent delete",
        },
        keepUnread: {
          type: "boolean",
          description: "Do not mark messages read before archiving or trashing (default: false, marks read)",
          default: false,
        },
      },
      required: ["messageIds", "operation"],
    },
    handler: async (args, api) => {
      const keepUnread = args.keepUnread || false;
      if (args.operation === "archive") {
        return await api("POST", "/messages/archive", { messageIds: args.messageIds, keepUnread });
      }
      if (args.operation === "move") {
        if (!args.destinationFolderId) {
          return { error: "destinationFolderId required for move" };
        }
        return await api("POST", "/messages/move", {
          messageIds: args.messageIds,
          destinationFolderId: args.destinationFolderId,
        });
      }
      if (args.operation === "delete") {
        if (args.permanent && !args.confirm) {
          return { error: "Permanent delete requires confirm=true" };
        }
        return await api("POST", "/messages/delete", {
          messageIds: args.messageIds,
          permanent: args.permanent || false,
          keepUnread,
        });
      }
      return { error: `Unknown operation: ${args.operation}` };
    },
  },

  // ─── 12. Attachments ───────────────────────────────────────────
  {
    name: "email_attachments",
    description:
      "List or download attachments from a message. Operation 'list' returns attachment metadata. Operation 'download' returns base64-encoded file data (use partName from list results).",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "number", description: "Message ID" },
        operation: {
          type: "string",
          enum: ["list", "download"],
          description: "list metadata or download a specific attachment",
        },
        partName: {
          type: "string",
          description: "Required for download — get from list operation",
        },
      },
      required: ["messageId", "operation"],
    },
    handler: async (args, api) => {
      if (args.operation === "list") {
        return await api("GET", `/messages/${args.messageId}/attachments`);
      }
      if (args.operation === "download") {
        if (!args.partName) return { error: "partName required for download" };
        return await api("POST", `/messages/${args.messageId}/attachment`, {
          partName: args.partName,
        });
      }
      return { error: `Unknown operation: ${args.operation}` };
    },
  },

  // ─── 13. Folders ───────────────────────────────────────────────
  {
    name: "email_folders",
    description:
      "List folders for an account, get folder info with message counts, or trigger sync. Operations: 'list' (folders for account), 'all' (across all accounts), 'info' (one folder), 'sync' (refresh from IMAP).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "all", "info", "sync"],
          description: "Operation type",
        },
        accountId: {
          type: "string",
          description: "Required for 'list' operation",
        },
        folderId: {
          type: "string",
          description: "Required for 'info' and 'sync' operations",
        },
      },
      required: ["operation"],
    },
    handler: async (args, api) => {
      if (args.operation === "list") {
        if (!args.accountId) return { error: "accountId required for list" };
        return await api("GET", `/accounts/${args.accountId}/folders`);
      }
      if (args.operation === "all") {
        const accounts = await api("GET", "/accounts");
        const all = [];
        for (const acct of accounts) {
          const folders = await api("GET", `/accounts/${acct.id}/folders`);
          for (const f of folders) all.push({ ...f, accountId: acct.id });
        }
        return all;
      }
      if (args.operation === "info") {
        if (!args.folderId) return { error: "folderId required for info" };
        return await api("POST", "/folders/info", { folderId: args.folderId });
      }
      if (args.operation === "sync") {
        if (args.folderId) return await api("POST", "/sync", { folderId: args.folderId });
        return await api("POST", "/sync", { all: true });
      }
      return { error: `Unknown operation: ${args.operation}` };
    },
  },

  {
    name: "contact_search",
    description:
      "Search or list address book contacts across all address books, matching name and any email property (primary, secondary, etc). Omit query to list all.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Optional search term matched against display name and email addresses",
        },
        book: {
          type: "string",
          description: "Optional: limit to one address book, by id or name",
        },
        limit: {
          type: "number",
          description: "Optional: max results",
        },
      },
    },
    handler: async (args, api) => {
      const body = {};
      if (args.query) body.query = args.query;
      if (args.book) body.book = args.book;
      if (args.limit) body.limit = args.limit;
      return await api("POST", "/contacts/search", body);
    },
  },

  // ─── 15. Contact create ────────────────────────────────────────
  {
    name: "contact_create",
    description:
      "Create a new contact in an address book. Requires the target address book (by id or name) and at least one property.",
    inputSchema: {
      type: "object",
      properties: {
        book: {
          type: "string",
          description: "Target address book, by id or name",
        },
        displayName: { type: "string", description: "Display name" },
        email: { type: "string", description: "Primary email" },
        secondEmail: { type: "string", description: "Secondary email" },
        firstName: { type: "string", description: "First name" },
        lastName: { type: "string", description: "Last name" },
        phone: { type: "string", description: "Work phone" },
        org: { type: "string", description: "Organization/company" },
      },
      required: ["book"],
    },
    handler: async (args, api) => {
      if (!args.book) return { error: "book required" };
      const properties = {};
      if (args.displayName) properties.DisplayName = args.displayName;
      if (args.email) properties.PrimaryEmail = args.email;
      if (args.secondEmail) properties.SecondEmail = args.secondEmail;
      if (args.firstName) properties.FirstName = args.firstName;
      if (args.lastName) properties.LastName = args.lastName;
      if (args.phone) properties.WorkPhone = args.phone;
      if (args.org) properties.Company = args.org;
      if (Object.keys(properties).length === 0) return { error: "at least one contact property required" };
      return await api("POST", "/contacts/create", { book: args.book, properties });
    },
  },

  // ─── 16. Contact update ────────────────────────────────────────
  {
    name: "contact_update",
    description:
      "Update properties on an existing contact by id. Only the properties you provide are changed.",
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "Contact id to update" },
        displayName: { type: "string", description: "Display name" },
        email: { type: "string", description: "Primary email" },
        secondEmail: { type: "string", description: "Secondary email" },
        firstName: { type: "string", description: "First name" },
        lastName: { type: "string", description: "Last name" },
        phone: { type: "string", description: "Work phone" },
        org: { type: "string", description: "Organization/company" },
      },
      required: ["contactId"],
    },
    handler: async (args, api) => {
      if (!args.contactId) return { error: "contactId required" };
      const properties = {};
      if (args.displayName) properties.DisplayName = args.displayName;
      if (args.email) properties.PrimaryEmail = args.email;
      if (args.secondEmail) properties.SecondEmail = args.secondEmail;
      if (args.firstName) properties.FirstName = args.firstName;
      if (args.lastName) properties.LastName = args.lastName;
      if (args.phone) properties.WorkPhone = args.phone;
      if (args.org) properties.Company = args.org;
      if (Object.keys(properties).length === 0) return { error: "at least one contact property required" };
      return await api("POST", "/contacts/update", { id: args.contactId, properties });
    },
  },
  // ─── 17. Notes: list ─────────────────────────────────────────────
  {
    name: "note_list",
    description:
      "List all notes in the local Markdown notes workspace (title, created date, source message id if any, size, last modified). Purely local — no Thunderbird round-trip.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => listNotes(),
  },

  // ─── 18. Notes: read ─────────────────────────────────────────────
  {
    name: "note_read",
    description:
      "Read a note's full Markdown body and metadata by name. Use this to pull a saved note in as context for the current conversation (\"Use as Context\").",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Note name (without the .md extension)" },
      },
      required: ["name"],
    },
    handler: async (args) => readNote(args.name),
  },

  // ─── 19. Notes: save ─────────────────────────────────────────────
  {
    name: "note_save",
    description:
      "Save a note to the local Markdown notes workspace, overwriting it if a note with the same name already exists (\"Save to Notes\"). Use this to save an AI reply, summary, or other generated content as a note.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Note name (without the .md extension); letters, numbers, spaces, '.', '_', '-' only" },
        body: { type: "string", description: "Note body (Markdown)" },
        title: { type: "string", description: "Note title (defaults to name)" },
        source: { type: "string", description: "Source email message ID this note came from, if any" },
      },
      required: ["name", "body"],
    },
    handler: async (args) => saveNote(args.name, args.body, { title: args.title, source: args.source }),
  },

  // ─── 20. Notes: append ───────────────────────────────────────────
  {
    name: "note_append",
    description:
      "Append Markdown text to a note, creating it first if it doesn't exist yet (\"Save to Notes\" for incremental additions, e.g. appending a new AI reply to an existing note).",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Note name (without the .md extension); letters, numbers, spaces, '.', '_', '-' only" },
        body: { type: "string", description: "Markdown text to append" },
        title: { type: "string", description: "Note title, only applied when the note is created" },
        source: { type: "string", description: "Source email message ID this note came from, if any" },
      },
      required: ["name", "body"],
    },
    handler: async (args) => appendNote(args.name, args.body, { title: args.title, source: args.source }),
  },

  // ─── 21. Notes: to draft ─────────────────────────────────────────
  {
    name: "note_to_draft",
    description:
      "Render a note's Markdown to sanitized HTML and open it as a new email draft via the same compose route as email_compose. Default mode is 'draft' (saved to Drafts, not sent); mode='open' opens it in Thunderbird's compose window for human review. This tool never sends — there is no 'send' mode.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Note name (without the .md extension)" },
        to: { type: "string", description: "Recipient(s), comma-separated for multiple" },
        cc: { type: "string", description: "CC recipients" },
        bcc: { type: "string", description: "BCC recipients" },
        subject: { type: "string", description: "Subject line (defaults to the note's title)" },
        from: { type: "string", description: "Identity ID to send from" },
        mode: {
          type: "string",
          enum: ["draft", "open"],
          default: "draft",
          description: "'draft' saves silently (default), 'open' opens the compose window for review",
        },
      },
      required: ["name", "to"],
    },
    handler: async (args, api) => {
      const note = readNote(args.name);
      const payload = {
        to: args.to,
        subject: args.subject || note.title,
        body: renderNoteHtml(note.body),
        isHTML: true,
      };
      if (args.cc) payload.cc = args.cc;
      if (args.bcc) payload.bcc = args.bcc;
      if (args.from) payload.identityId = args.from;
      if (args.mode === "open") payload.open = true;
      else payload.draft = true;
      return await api("POST", "/compose", payload);
    },
  },

  // ─── 22. Tasks: list (ODIAA-2329) ─────────────────────────────────
  {
    name: "task_list",
    description:
      "List calendar tasks (VTODO), optionally scoped to one calendar or filtered by completion state. Requires the calendar Experiment API — see docs/decisions/calendar-backend.md.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Optional: limit to one calendar" },
        completed: { type: "boolean", description: "Optional: true for completed tasks only, false for pending only" },
      },
    },
    handler: async (args, api) => {
      const body = {};
      if (args.calendarId) body.calendarId = args.calendarId;
      if (args.completed !== undefined) body.completed = args.completed;
      return await api("POST", "/tasks/list", body);
    },
  },

  // ─── 23. Tasks: create (ODIAA-2329) ───────────────────────────────
  {
    name: "task_create",
    description:
      "Create a calendar task (VTODO). Requires the tasksWrite access switch to be enabled (disabled by default) — see docs/ACCESS-CONTROL.md.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Target calendar" },
        title: { type: "string", description: "Task title" },
        due: { type: "string", description: "Due date (ISO date/time, or YYYY-MM-DD if allDay)" },
        allDay: { type: "boolean", description: "All-day due date" },
        priority: { type: "integer", description: "0-9; 1-4 high, 5 normal, 6-9 low, per RFC 5545" },
        description: { type: "string", description: "Task description" },
        source: { type: "string", description: "Message id this task was created from, if any" },
      },
      required: ["calendarId", "title"],
    },
    handler: async (args, api) => {
      if (!args.calendarId) return { error: "calendarId is required" };
      if (!args.title) return { error: "title is required" };
      const properties = { title: args.title };
      if (args.due !== undefined) properties.due = args.due;
      if (args.allDay !== undefined) properties.allDay = args.allDay;
      if (args.priority !== undefined) properties.priority = args.priority;
      if (args.description !== undefined) properties.description = args.description;
      if (args.source !== undefined) properties.source = args.source;
      return await api("POST", "/tasks/create", { calendarId: args.calendarId, ...properties });
    },
  },

  // ─── 24. Tasks: update (ODIAA-2329) ───────────────────────────────
  {
    name: "task_update",
    description:
      "Update properties on an existing calendar task by id. Only the properties you provide are changed. Requires the tasksWrite access switch to be enabled (disabled by default) — see docs/ACCESS-CONTROL.md.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar the task belongs to" },
        taskId: { type: "string", description: "Task id to update" },
        title: { type: "string", description: "Task title" },
        due: { type: "string", description: "Due date (ISO date/time, or YYYY-MM-DD if allDay)" },
        allDay: { type: "boolean", description: "All-day due date" },
        priority: { type: "integer", description: "0-9; 1-4 high, 5 normal, 6-9 low, per RFC 5545" },
        description: { type: "string", description: "Task description" },
        source: { type: "string", description: "Message id this task was created from, if any" },
        completed: { type: "boolean", description: "Mark completed (true) or not completed (false)" },
      },
      required: ["calendarId", "taskId"],
    },
    handler: async (args, api) => {
      if (!args.calendarId || !args.taskId) return { error: "calendarId and taskId are required" };
      const properties = {};
      if (args.title !== undefined) properties.title = args.title;
      if (args.due !== undefined) properties.due = args.due;
      if (args.allDay !== undefined) properties.allDay = args.allDay;
      if (args.priority !== undefined) properties.priority = args.priority;
      if (args.description !== undefined) properties.description = args.description;
      if (args.source !== undefined) properties.source = args.source;
      if (args.completed !== undefined) properties.completed = args.completed;
      if (Object.keys(properties).length === 0) return { error: "at least one task property is required" };
      return await api("POST", "/tasks/update", { calendarId: args.calendarId, id: args.taskId, ...properties });
    },
  },

  // ─── 25. Email: action items (ODIAA-2329) ─────────────────────────
  {
    name: "email_action_items",
    description:
      "Extract candidate action items from a message body as a Markdown checklist. Deterministic (no LLM) — looks for imperative lines, bullets/checklists, and 'please/can you' request phrasing, plus 'by <date>' due-date hints. Returns both the structured items and the rendered Markdown.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message id to extract action items from" },
      },
      required: ["messageId"],
    },
    handler: async (args, api) => {
      if (!args.messageId) return { error: "messageId is required" };
      return await api("POST", `/messages/${args.messageId}/action-items`, {});
    },
  },

  // ─── 26. Calendar: events list (ODIAA-2328) ───────────────────────
  {
    name: "calendar_events",
    description:
      "List calendar events in a date range, optionally scoped to one calendar. Recurring events are expanded into individual occurrences. Requires the calendar Experiment API — see docs/decisions/calendar-backend.md.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "Range start (ISO date/time)" },
        end: { type: "string", description: "Range end (ISO date/time)" },
        calendarId: { type: "string", description: "Optional: limit to one calendar" },
      },
      required: ["start", "end"],
    },
    handler: async (args, api) => {
      if (!args.start || !args.end) return { error: "start and end required" };
      const body = { start: args.start, end: args.end };
      if (args.calendarId) body.calendarId = args.calendarId;
      return await api("POST", "/calendar/events/list", body);
    },
  },

  // ─── 27. Calendar: event create (ODIAA-2328) ──────────────────────
  {
    name: "calendar_event_create",
    description:
      "Create a calendar event. Requires the calendarWrite access switch to be enabled (disabled by default) — see docs/ACCESS-CONTROL.md.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Target calendar id" },
        title: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start (ISO date/time, or YYYY-MM-DD if allDay)" },
        end: { type: "string", description: "End (ISO date/time, or YYYY-MM-DD if allDay)" },
        allDay: { type: "boolean", description: "All-day event" },
        location: { type: "string", description: "Location" },
        description: { type: "string", description: "Description" },
      },
      required: ["calendarId", "title", "start", "end"],
    },
    handler: async (args, api) => {
      if (!args.calendarId) return { error: "calendarId required" };
      if (!args.title || !args.start || !args.end) return { error: "title, start, and end required" };
      const properties = { title: args.title, start: args.start, end: args.end };
      if (args.allDay) properties.allDay = true;
      if (args.location) properties.location = args.location;
      if (args.description) properties.description = args.description;
      return await api("POST", "/calendar/events/create", { calendarId: args.calendarId, ...properties });
    },
  },

  // ─── 28. Calendar: event update (ODIAA-2328) ──────────────────────
  {
    name: "calendar_event_update",
    description:
      "Update properties on an existing calendar event by id. Only the properties you provide are changed. Requires the calendarWrite access switch to be enabled (disabled by default) — see docs/ACCESS-CONTROL.md.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar the event belongs to" },
        eventId: { type: "string", description: "Event id to update" },
        title: { type: "string", description: "Event title" },
        start: { type: "string", description: "Start (ISO date/time, or YYYY-MM-DD if allDay)" },
        end: { type: "string", description: "End (ISO date/time, or YYYY-MM-DD if allDay)" },
        allDay: { type: "boolean", description: "All-day event" },
        location: { type: "string", description: "Location" },
        description: { type: "string", description: "Description" },
      },
      required: ["calendarId", "eventId"],
    },
    handler: async (args, api) => {
      if (!args.calendarId || !args.eventId) return { error: "calendarId and eventId required" };
      const properties = {};
      if (args.title !== undefined) properties.title = args.title;
      if (args.start !== undefined) properties.start = args.start;
      if (args.end !== undefined) properties.end = args.end;
      if (args.allDay !== undefined) properties.allDay = args.allDay;
      if (args.location !== undefined) properties.location = args.location;
      if (args.description !== undefined) properties.description = args.description;
      if (Object.keys(properties).length === 0) return { error: "at least one event property required" };
      return await api("POST", "/calendar/events/update", { calendarId: args.calendarId, id: args.eventId, ...properties });
    },
  },

  // ─── 29. Calendar: event delete (ODIAA-2328) ──────────────────────
  {
    name: "calendar_event_delete",
    description:
      "Delete a calendar event by id. Requires the calendarWrite access switch to be enabled (disabled by default) — see docs/ACCESS-CONTROL.md.",
    inputSchema: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar the event belongs to" },
        eventId: { type: "string", description: "Event id to delete" },
      },
      required: ["calendarId", "eventId"],
    },
    handler: async (args, api) => {
      if (!args.calendarId || !args.eventId) return { error: "calendarId and eventId required" };
      return await api("POST", "/calendar/events/delete", { calendarId: args.calendarId, id: args.eventId });
    },
  },

  // ─── 30. Calendar: clashes (ODIAA-2328) ────────────────────────────
  {
    name: "calendar_clashes",
    description:
      "Detect overlapping ('clashing') events across all calendars in a date range. Ignores cancelled and free/transparent events; DST- and all-day-aware. Returns groups of mutually overlapping events.",
    inputSchema: {
      type: "object",
      properties: {
        start: { type: "string", description: "Range start (ISO date/time)" },
        end: { type: "string", description: "Range end (ISO date/time)" },
      },
      required: ["start", "end"],
    },
    handler: async (args, api) => {
      if (!args.start || !args.end) return { error: "start and end required" };
      return await api("POST", "/calendar/clashes", { start: args.start, end: args.end });
    },
  },

  // ─── Deterministic skills (ODIAA-2332) ───────────────────────────
  // Zero-LLM-reasoning tools: they compose existing read-only endpoints and hand back
  // pre-formatted, compact Markdown — no JSON for the model to parse or summarize.
  {
    name: "skill_today",
    description:
      "Today at a glance: today's calendar events (all calendars) plus unread and flagged mail counts. Returns ready-to-show Markdown, not JSON — do not reformat or re-summarize it.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, api) => {
      const date = startOfDay(new Date());
      const end = addDays(date, 1);
      const [eventsResult, stats, flaggedResult] = await Promise.all([
        api("POST", "/calendar/events/list", { start: date.toISOString(), end: end.toISOString() }),
        api("GET", "/stats"),
        api("POST", "/messages/search", { flagged: true, limit: 200 }),
      ]);
      const calendarError = calendarErrorOf(eventsResult);
      const markdown = renderToday({
        date,
        events: calendarError ? [] : eventsResult,
        calendarError,
        unreadTotal: stats?.totalUnread,
        flagged: flaggedResult?.messages
          ? { count: flaggedResult.messages.length, hasMore: !!flaggedResult.hasMore }
          : null,
      });
      return { markdown };
    },
  },

  {
    name: "skill_week",
    description:
      "This week at a glance: calendar events (all calendars) for the next 7 days, grouped by day. Returns ready-to-show Markdown, not JSON — do not reformat or re-summarize it.",
    inputSchema: { type: "object", properties: {} },
    handler: async (_args, api) => {
      const start = startOfDay(new Date());
      const end = addDays(start, 7);
      const eventsResult = await api("POST", "/calendar/events/list", {
        start: start.toISOString(),
        end: end.toISOString(),
      });
      const calendarError = calendarErrorOf(eventsResult);
      const markdown = renderWeek({
        start,
        numDays: 7,
        events: calendarError ? [] : eventsResult,
        calendarError,
      });
      return { markdown };
    },
  },

  {
    name: "skill_clashes",
    description:
      "Find overlapping ('clashing') events across all calendars in the next N days (default 7). Ignores cancelled and free/transparent events. Returns ready-to-show Markdown, not JSON — do not reformat or re-summarize it.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "Look ahead this many days (default 7)" },
      },
    },
    handler: async (args, api) => {
      const days = args.days > 0 ? args.days : 7;
      const start = startOfDay(new Date());
      const end = addDays(start, days);
      const result = await api("POST", "/calendar/clashes", {
        start: start.toISOString(),
        end: end.toISOString(),
      });
      const calendarError = calendarErrorOf(result);
      const markdown = renderClashes({ start, end, clashes: result?.clashes, calendarError });
      return { markdown };
    },
  },

  {
    name: "skill_from",
    description:
      "Recent mail from a sender address or domain, grouped into threads by subject. Returns ready-to-show Markdown, not JSON — do not reformat or re-summarize it.",
    inputSchema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Sender email address or domain (e.g. '@example.com')" },
        limit: { type: "number", description: "Max messages to consider (default 50)" },
      },
      required: ["address"],
    },
    handler: async (args, api) => {
      if (!args.address) return { error: "address required" };
      const limit = args.limit > 0 ? args.limit : 50;
      const result = await api("POST", "/messages/search", { fromAddress: args.address, limit });
      const threads = groupMessagesIntoThreads(result?.messages);
      const markdown = renderFrom({ address: args.address, threads, hasMore: !!result?.hasMore });
      return { markdown };
    },
  },

  // ─── 31. Address books (ODIAA-2333) ────────────────────────────────
  {
    name: "address_book_list",
    description: "List address books (id and name). Used to pick a target book for contact_create / email_to_contact.",
    inputSchema: { type: "object", properties: {} },
    handler: async (args, api) => await api("GET", "/addressbooks"),
  },

  // ─── 32. Fast actions: email to note (ODIAA-2333) ──────────────────
  {
    name: "email_to_note",
    description: "Save an email to the local notes workspace (\"Save to Notes\" fast action). Purely local once the message body is fetched — no access switch required.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message id to save" },
        name: { type: "string", description: "Note name (defaults to a slug of the subject)" },
        append: { type: "boolean", description: "Append to an existing note instead of overwriting" },
      },
      required: ["messageId"],
    },
    handler: async (args, api) => {
      if (!args.messageId) return { error: "messageId is required" };
      const msg = await api("GET", `/messages/${args.messageId}/full`);
      const name = args.name || slugify(msg.subject) || `message-${args.messageId}`;
      const body = [
        `**From:** ${msg.author || "unknown"}`,
        `**Date:** ${msg.date || "unknown"}`,
        "",
        msg.parts?.text || msg.parts?.html || "(no body)",
      ].join("\n");
      const opts = { title: msg.subject, source: String(args.messageId) };
      return args.append ? appendNote(name, body, opts) : saveNote(name, body, opts);
    },
  },

  // ─── 33. Fast actions: email to task (ODIAA-2333) ──────────────────
  {
    name: "email_to_task",
    description: "Create a task from an email, using action-item extraction for the title/description (\"Create Task\" fast action). Requires the tasksWrite access switch to be enabled (disabled by default) — see docs/ACCESS-CONTROL.md.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message id to create a task from" },
        calendarId: { type: "string", description: "Target calendar" },
        due: { type: "string", description: "Due date (ISO date/time, or YYYY-MM-DD if allDay)" },
        allDay: { type: "boolean", description: "All-day due date" },
        priority: { type: "integer", description: "0-9; 1-4 high, 5 normal, 6-9 low, per RFC 5545" },
      },
      required: ["messageId", "calendarId"],
    },
    handler: async (args, api) => {
      if (!args.messageId || !args.calendarId) return { error: "messageId and calendarId required" };
      const msg = await api("GET", `/messages/${args.messageId}/full`);
      const extracted = await api("POST", `/messages/${args.messageId}/action-items`, {});
      const properties = {
        title: extracted.items?.[0]?.text || msg.subject || `Task from message ${args.messageId}`,
        source: String(args.messageId),
      };
      if (extracted.markdown) properties.description = extracted.markdown;
      if (args.due) properties.due = args.due;
      if (args.allDay) properties.allDay = true;
      if (args.priority !== undefined) properties.priority = args.priority;
      return await api("POST", "/tasks/create", { calendarId: args.calendarId, ...properties });
    },
  },

  // ─── 34. Fast actions: email to event (ODIAA-2333) ─────────────────
  {
    name: "email_to_event",
    description: "Create a calendar event from an email via deterministic (no LLM) date/time/location parsing (\"Create Event\" fast action). When no date/time is found, falls back to a placeholder draft with status TENTATIVE for the user to edit. Requires the calendarWrite access switch to be enabled (disabled by default) — see docs/ACCESS-CONTROL.md.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message id to create an event from" },
        calendarId: { type: "string", description: "Target calendar" },
      },
      required: ["messageId", "calendarId"],
    },
    handler: async (args, api) => {
      if (!args.messageId || !args.calendarId) return { error: "messageId and calendarId required" };
      const draft = await api("POST", `/messages/${args.messageId}/event-draft`, {});
      const properties = {
        title: draft.title,
        description: draft.description,
        start: draft.start,
        end: draft.end,
        allDay: draft.allDay,
        status: draft.needsReview ? "TENTATIVE" : "CONFIRMED",
      };
      if (draft.location) properties.location = draft.location;
      const created = await api("POST", "/calendar/events/create", { calendarId: args.calendarId, ...properties });
      return { ...created, needsReview: draft.needsReview };
    },
  },

  // ─── 35. Fast actions: email to contact (ODIAA-2333) ───────────────
  {
    name: "email_to_contact",
    description: "Add an email's sender as a contact, deduped by email address (\"Add Sender to Contacts\" fast action). Requires the contactsWrite access switch to be enabled (disabled by default) — see docs/ACCESS-CONTROL.md.",
    inputSchema: {
      type: "object",
      properties: {
        messageId: { type: "string", description: "Message id whose sender should be added" },
        book: { type: "string", description: "Target address book, by id or name" },
      },
      required: ["messageId", "book"],
    },
    handler: async (args, api) => {
      if (!args.messageId || !args.book) return { error: "messageId and book required" };
      const msg = await api("GET", `/messages/${args.messageId}/full`);
      const { name, email } = parseSenderAuthor(msg.author);
      if (!email) return { error: "could not extract a sender email address from this message" };
      const existing = await api("POST", "/contacts/search", { query: email, book: args.book });
      if (existing.length > 0) return { ...existing[0], deduped: true };
      const properties = { PrimaryEmail: email };
      if (name) properties.DisplayName = name;
      const created = await api("POST", "/contacts/create", { book: args.book, properties });
      return { ...created, deduped: false };
    },
  },

  // ─── 36. Fast actions: notes listen-once (ODIAA-2333) ──────────────
  {
    name: "notes_listen_once",
    description: "Wait for a 'Save to Notes' click in Thunderbird, then save the resulting note. Long-polls the bridge event feed, so this call blocks until either a request arrives or the timeout elapses.",
    inputSchema: {
      type: "object",
      properties: {
        timeoutMs: { type: "integer", description: "How long to wait for a pending request, in ms (default 120000)" },
        name: { type: "string", description: "Note name (defaults to a slug of the subject)" },
        append: { type: "boolean", description: "Append to an existing note instead of overwriting" },
      },
    },
    handler: async (args, api) => {
      const timeout = args.timeoutMs || 120000;
      const since = Date.now() - 1000;
      let eventResp;
      try {
        eventResp = await api("GET", `/bridge/events?wait=note-save-requested&since=${since}&timeout=${timeout}`, null, timeout + 5000);
      } catch (err) {
        if (err.code === "EVENT_TIMEOUT" || err.code === "TIMEOUT") {
          return { error: "no 'Save to Notes' request received before the timeout" };
        }
        throw err;
      }
      const payload = eventResp.event?.data || {};
      const name = args.name || slugify(payload.subject) || `message-${payload.messageId || "unknown"}`;
      const body = [
        `**From:** ${payload.author || "unknown"}`,
        `**Date:** ${payload.date || "unknown"}`,
        "",
        payload.body || "(no body)",
      ].join("\n");
      const opts = { title: payload.subject, source: payload.messageId ? String(payload.messageId) : undefined };
      return args.append ? appendNote(name, body, opts) : saveNote(name, body, opts);
    },
  },
];

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Parses a WebExtension "author" header (e.g. `"Jane Doe" <jane@x.com>`) into name/email.
function parseSenderAuthor(author) {
  const str = String(author || "");
  const m = str.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim() };
  const emailOnly = str.match(/[^\s<>]+@[^\s<>]+/);
  return { name: null, email: emailOnly ? emailOnly[0] : null };
}
