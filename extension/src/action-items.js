/**
 * Deterministic (no LLM) extraction of candidate action items from a plain-text message
 * body into a Markdown checklist.
 *
 * Loaded as a background script before background.js (see manifest.json), so these are plain
 * globals rather than ES exports. test/action-items.test.mjs loads this file in a Node vm.
 */

const IMPERATIVE_VERBS = [
  "send", "review", "update", "confirm", "schedule", "call", "email", "complete",
  "finish", "prepare", "submit", "check", "attach", "sign off", "sign", "approve",
  "provide", "share", "follow up", "followup", "reply", "respond", "add", "remove",
  "fix", "create", "set up", "setup", "book", "arrange", "verify", "upload",
  "download", "draft", "cancel", "reschedule", "renew", "pay", "order", "ship",
  "deliver", "install", "configure", "test", "deploy", "merge", "let me know",
  "make sure", "ensure", "finalize", "file", "print",
];

const REQUEST_PATTERNS = [
  /\bplease\b/i,
  /\bcan you\b/i,
  /\bcould you\b/i,
  /\bwould you\b/i,
  /\bneed(?:s)? to\b/i,
];

const DATE_HINT_PATTERN =
  /\bby\s+((?:next\s+)?(?:mon|tues?|wednes?|thurs?|fri|satur|sun)day|today|tomorrow|tonight|end of (?:day|week|month)|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?)/i;

// Drop quoted reply history (RFC 3676 leading '>') and anything from a signature delimiter
// ("-- " on its own line) onward, so items aren't re-extracted from earlier thread layers.
function stripQuotedAndSignature(body) {
  const lines = String(body || "").split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/^\s*>/.test(line)) continue;
    if (/^--\s*$/.test(line)) break;
    kept.push(line);
  }
  return kept.join("\n");
}

function startsWithImperative(text) {
  const lower = text.trim().toLowerCase();
  return IMPERATIVE_VERBS.some((verb) => lower === verb || lower.startsWith(`${verb} `));
}

function hasRequestPhrase(text) {
  return REQUEST_PATTERNS.some((re) => re.test(text));
}

function extractDateHint(text) {
  const match = text.match(DATE_HINT_PATTERN);
  return match ? match[1] : null;
}

function cleanBulletText(line) {
  return line
    .replace(/^\s*[-*+]\s*(\[[ xX]\]\s*)?/, "")
    .replace(/^\s*\d+[.)]\s*/, "")
    .trim();
}

// Split a paragraph into sentences so a single imperative/request phrase inside a longer
// line doesn't pull the whole paragraph in as one item.
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractActionItems(body) {
  const lines = stripQuotedAndSignature(body).split(/\r?\n/);
  const items = [];
  const seen = new Set();

  const addItem = (text, checked) => {
    const trimmed = text.trim().replace(/[.!?\s]+$/, "");
    if (trimmed.length < 3) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ text: trimmed, checked: !!checked, dueHint: extractDateHint(text) });
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const checklistMatch = /^\s*[-*+]\s*\[([ xX])\]\s*(.+)/.exec(line);
    if (checklistMatch) {
      addItem(checklistMatch[2], /[xX]/.test(checklistMatch[1]));
      continue;
    }

    const bulletMatch = /^\s*(?:[-*+]|\d+[.)])\s+(.+)/.exec(line);
    if (bulletMatch) {
      addItem(cleanBulletText(line));
      continue;
    }

    for (const sentence of splitSentences(line)) {
      if (startsWithImperative(sentence) || hasRequestPhrase(sentence)) {
        addItem(sentence);
      }
    }
  }

  return items;
}

function actionItemsToMarkdown(items) {
  if (!items.length) return "";
  return items
    .map((item) => {
      const box = item.checked ? "[x]" : "[ ]";
      const suffix = item.dueHint ? ` (by ${item.dueHint})` : "";
      return `- ${box} ${item.text}${suffix}`;
    })
    .join("\n");
}
