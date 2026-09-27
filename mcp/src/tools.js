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

export const tools = [
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
];
