/**
 * Deterministic "skill" formatters (ODIAA-2332): today / week / clashes / from.
 *
 * Pure functions only — no bridge/network calls, no Date.now() defaults — so the CLI
 * (cli/src/cli.js) and MCP server (mcp/src/tools.js) render byte-identical Markdown from
 * the same data, and so tests can pass fixed dates for deterministic snapshots. Callers do
 * the data fetching and pass plain data in; this module never throws on missing/odd fields.
 *
 * Dates/times are formatted from the JS Date object's local-timezone getters (matching
 * cli/src/client.js's non-UTC formatDate()), not locale-dependent Intl formatting — so
 * output shape doesn't vary with the OS locale, only with TZ (tests pin TZ=UTC).
 */

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function pad(n) {
  return String(n).padStart(2, "0");
}

export function formatDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function formatTime(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Mirrors extension/src/thread-utils.js's normalizeSubject exactly, so grouping-by-subject
 * agrees with the extension's own thread matching. Duplicated rather than imported: this
 * module runs in Node (CLI/MCP); thread-utils.js is a WebExtension background script loaded
 * into the browser's global scope (see extension/manifest.json), not an importable module.
 */
export function normalizeSubjectForThreading(subject) {
  return (subject || "")
    .trim()
    .replace(/^((Re|WG|AW|Fwd?|FW|Sv|Vs|Ref):\s*|\[[^\]]*\]\s*)*/gi, "")
    .trim();
}

// All-day events first (so a day's timed schedule reads top-to-bottom in start order),
// then by start instant.
export function sortEvents(events) {
  return [...(events || [])].sort((a, b) => {
    if (!!a.allDay !== !!b.allDay) return a.allDay ? -1 : 1;
    return new Date(a.start) - new Date(b.start);
  });
}

export function formatEventLine(event) {
  const cal = event.calendarName ? ` (${event.calendarName})` : "";
  const loc = event.location ? ` — ${event.location}` : "";
  if (event.allDay) {
    return `All day: ${event.title}${cal}${loc}`;
  }
  const start = new Date(event.start);
  const end = new Date(event.end);
  return `${formatTime(start)}–${formatTime(end)} ${event.title}${cal}${loc}`;
}

export function renderToday({ date, events, calendarError, unreadTotal, flagged }) {
  const lines = [`# Today — ${formatDate(date)}`, ""];

  if (calendarError) {
    lines.push("## Calendar", `- unavailable: ${calendarError}`, "");
  } else {
    const sorted = sortEvents(events);
    lines.push(`## Calendar (${sorted.length})`);
    if (sorted.length === 0) lines.push("- no events");
    else for (const e of sorted) lines.push(`- ${formatEventLine(e)}`);
    lines.push("");
  }

  lines.push("## Mail");
  if (unreadTotal != null) lines.push(`- ${unreadTotal} unread`);
  if (flagged) lines.push(`- ${flagged.count}${flagged.hasMore ? "+" : ""} flagged`);

  return lines.join("\n").trimEnd() + "\n";
}

export function renderWeek({ start, numDays = 7, events, calendarError }) {
  const lines = [`# Week of ${formatDate(start)}`, ""];

  if (calendarError) {
    lines.push(`unavailable: ${calendarError}`);
    return lines.join("\n").trimEnd() + "\n";
  }

  const byDay = new Map();
  for (const e of events || []) {
    const key = e.allDay ? String(e.start).slice(0, 10) : formatDate(new Date(e.start));
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(e);
  }

  let freeCount = 0;
  for (let i = 0; i < numDays; i++) {
    const day = addDays(start, i);
    const key = formatDate(day);
    const dayEvents = sortEvents(byDay.get(key));
    if (dayEvents.length === 0) {
      freeCount++;
      continue;
    }
    lines.push(`## ${DOW[day.getDay()]} ${key}`);
    for (const e of dayEvents) lines.push(`- ${formatEventLine(e)}`);
    lines.push("");
  }
  if (freeCount) lines.push(`${freeCount} of ${numDays} days free`);

  return lines.join("\n").trimEnd() + "\n";
}

export function renderClashes({ start, end, clashes, calendarError }) {
  const lines = [`# Clashes — ${formatDate(start)} to ${formatDate(end)}`, ""];

  if (calendarError) {
    lines.push(`unavailable: ${calendarError}`);
    return lines.join("\n").trimEnd() + "\n";
  }

  if (!clashes || clashes.length === 0) {
    lines.push("No clashes found.");
    return lines.join("\n").trimEnd() + "\n";
  }

  clashes.forEach((group, i) => {
    const gStart = new Date(group.start);
    const gEnd = new Date(group.end);
    lines.push(`## Clash ${i + 1}: ${formatDate(gStart)} ${formatTime(gStart)}–${formatTime(gEnd)}`);
    for (const e of sortEvents(group.events)) lines.push(`- ${formatEventLine(e)}`);
    lines.push("");
  });

  return lines.join("\n").trimEnd() + "\n";
}

// Groups by normalized subject (case-insensitive); most-recently-active thread first,
// newest message first within a thread.
export function groupMessagesIntoThreads(messages) {
  const byKey = new Map();
  for (const m of messages || []) {
    const normalized = normalizeSubjectForThreading(m.subject) || "(no subject)";
    const key = normalized.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, { subject: normalized, messages: [] });
    byKey.get(key).messages.push(m);
  }
  const threads = [...byKey.values()];
  for (const t of threads) t.messages.sort((a, b) => new Date(b.date) - new Date(a.date));
  threads.sort((a, b) => new Date(b.messages[0].date) - new Date(a.messages[0].date));
  return threads;
}

export function renderFrom({ address, threads, hasMore }) {
  const msgCount = threads.reduce((sum, t) => sum + t.messages.length, 0);
  const plusMore = hasMore ? "+" : "";
  const lines = [
    `# Mail from ${address} (${msgCount}${plusMore} message${msgCount === 1 ? "" : "s"}, ` +
      `${threads.length} thread${threads.length === 1 ? "" : "s"})`,
    "",
  ];

  if (threads.length === 0) {
    lines.push("No messages found.");
    return lines.join("\n").trimEnd() + "\n";
  }

  for (const t of threads) {
    lines.push(`## ${t.subject} (${t.messages.length})`);
    for (const m of t.messages) {
      const d = new Date(m.date);
      lines.push(`- ${formatDate(d)} ${formatTime(d)} — ${m.author || "unknown"}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
