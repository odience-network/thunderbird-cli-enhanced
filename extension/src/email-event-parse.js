/**
 * Deterministic (no LLM) event draft extraction from an email's subject/body:
 * a candidate date, time (or time range), and location, used by
 * `POST /messages/:id/event-draft` and by the "Create Event" context-menu
 * action (which calls parseEventDraft() directly, in-process).
 *
 * Loaded as a background script before background.js (see manifest.json), so
 * plain globals rather than ES exports — same convention as action-items.js.
 * test/email-event-parse.test.mjs loads this file in a Node vm.
 *
 * Heuristic and intentionally conservative: when no date/time is found, the
 * caller (background.js / cli / mcp) falls back to a placeholder draft the
 * user edits, rather than guessing wildly at meaning.
 */

const WEEKDAY_RE =
  /\b(next\s+)?(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat)\b/i;

const WEEKDAY_INDEX = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const MONTH_RE =
  /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i;

const MONTH_INDEX = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const NUMERIC_DATE_RE = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/;
const TOMORROW_RE = /\btomorrow\b/i;
const TONIGHT_RE = /\btonight\b/i;
const TODAY_RE = /\btoday\b/i;

const RANGE_TIME_RE =
  /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\s*(?:-|–|to)\s*(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b/i;
const SINGLE_TIME_12H_RE = /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)\b/i;
const SINGLE_TIME_24H_RE = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;

const MEETING_URL_RE = /\bhttps?:\/\/\S*(zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com)\S*/i;
const LOCATION_LABEL_RE = /\b(?:location|where)\s*:\s*([^\n]{2,80})/i;
const ROOM_RE = /\broom\s*#?\s*(\d+[a-z]?)\b/i;
const AT_PLACE_RE = /\bat\s+(?:the\s+)?([A-Z][A-Za-z0-9&'.-]*(?:\s+[A-Z][A-Za-z0-9&'.-]*){0,3})/;

function atMidnightUTC(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function nextWeekday(referenceDate, targetDow, skipCurrentWeek) {
  const ref = atMidnightUTC(referenceDate);
  const refDow = ref.getUTCDay();
  let diff = (targetDow - refDow + 7) % 7;
  if (diff === 0) diff = skipCurrentWeek ? 7 : 0;
  else if (skipCurrentWeek) diff += 7;
  const result = new Date(ref);
  result.setUTCDate(ref.getUTCDate() + diff);
  return result;
}

function resolveMonthDay(monthIdx, day, year, referenceDate) {
  const y = year || referenceDate.getUTCFullYear();
  let d = new Date(Date.UTC(y, monthIdx, day));
  if (!year && d.getTime() < atMidnightUTC(referenceDate).getTime() - 24 * 3600 * 1000) {
    d = new Date(Date.UTC(y + 1, monthIdx, day));
  }
  return d;
}

function normalizeYear(y) {
  if (y === undefined) return undefined;
  const n = parseInt(y, 10);
  return n < 100 ? 2000 + n : n;
}

// Returns { date: Date (UTC midnight), matched: string } or null.
function resolveDateOnly(text, referenceDate) {
  let m = text.match(MONTH_RE);
  if (m) {
    const monthIdx = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
    const day = parseInt(m[2], 10);
    const year = normalizeYear(m[3]);
    return { date: resolveMonthDay(monthIdx, day, year, referenceDate), matched: m[0] };
  }

  m = text.match(NUMERIC_DATE_RE);
  if (m) {
    const monthIdx = parseInt(m[1], 10) - 1;
    const day = parseInt(m[2], 10);
    const year = normalizeYear(m[3]);
    if (monthIdx >= 0 && monthIdx <= 11 && day >= 1 && day <= 31) {
      return { date: resolveMonthDay(monthIdx, day, year, referenceDate), matched: m[0] };
    }
  }

  if (TOMORROW_RE.test(text) || TONIGHT_RE.test(text)) {
    const d = atMidnightUTC(referenceDate);
    d.setUTCDate(d.getUTCDate() + 1);
    return { date: d, matched: TONIGHT_RE.test(text) && !TOMORROW_RE.test(text) ? "tonight" : "tomorrow" };
  }

  if (TODAY_RE.test(text)) {
    return { date: atMidnightUTC(referenceDate), matched: "today" };
  }

  m = text.match(WEEKDAY_RE);
  if (m) {
    const skipCurrentWeek = !!m[1];
    const dow = WEEKDAY_INDEX[m[2].toLowerCase()];
    return { date: nextWeekday(referenceDate, dow, skipCurrentWeek), matched: m[0] };
  }

  return null;
}

function parseTimeToken(hourStr, minuteStr, meridiem) {
  let hour = parseInt(hourStr, 10);
  const minute = minuteStr ? parseInt(minuteStr, 10) : 0;
  if (meridiem) {
    const mer = meridiem.toLowerCase();
    if (mer === "pm" && hour !== 12) hour += 12;
    if (mer === "am" && hour === 12) hour = 0;
  }
  return { hour, minute };
}

// Returns { start: {hour, minute}, end: {hour, minute} | null } or null (no time found).
function resolveTimeRange(text) {
  let m = text.match(RANGE_TIME_RE);
  if (m) {
    const endMeridiem = m[6];
    const startMeridiem = m[3] || endMeridiem; // "2-3pm" -> both pm
    return {
      start: parseTimeToken(m[1], m[2], startMeridiem),
      end: parseTimeToken(m[4], m[5], endMeridiem),
    };
  }

  m = text.match(SINGLE_TIME_12H_RE);
  if (m) return { start: parseTimeToken(m[1], m[2], m[3]), end: null };

  m = text.match(SINGLE_TIME_24H_RE);
  if (m) return { start: parseTimeToken(m[1], m[2], null), end: null };

  return null;
}

function stripTrailingPunctuation(s) {
  return s.replace(/[.,;:!?]+$/, "");
}

function extractLocation(text) {
  let m = text.match(MEETING_URL_RE);
  if (m) return stripTrailingPunctuation(m[0]);

  m = text.match(LOCATION_LABEL_RE);
  if (m) return stripTrailingPunctuation(m[1].trim());

  m = text.match(ROOM_RE);
  if (m) return `Room ${m[1]}`;

  m = text.match(AT_PLACE_RE);
  if (m) return stripTrailingPunctuation(m[1].trim());

  return null;
}

function cleanSubject(subject) {
  return String(subject || "")
    .replace(/^\s*(re|fwd?|fw)\s*:\s*/i, "")
    .replace(/^\s*(re|fwd?|fw)\s*:\s*/i, "")
    .trim();
}

function withTime(date, time) {
  const d = new Date(date);
  d.setUTCHours(time.hour, time.minute, 0, 0);
  return d;
}

/**
 * Parses a candidate calendar event out of an email's subject/body.
 *
 * @param {{subject?: string, body?: string, date?: string}} email
 * @returns {{title: string, start: string, end: string, allDay: boolean, location: string|null, description: string, needsReview: boolean}}
 */
function parseEventDraft({ subject, body, date } = {}) {
  const referenceDate = date && !isNaN(new Date(date)) ? new Date(date) : new Date();
  const haystack = `${subject || ""}\n${body || ""}`;
  const title = cleanSubject(subject) || "Untitled event";
  const location = extractLocation(haystack);

  const dateMatch = resolveDateOnly(haystack, referenceDate);
  const timeMatch = dateMatch ? resolveTimeRange(haystack) : null;

  let start, end, allDay, needsReview;

  if (dateMatch && timeMatch) {
    start = withTime(dateMatch.date, timeMatch.start);
    end = timeMatch.end ? withTime(dateMatch.date, timeMatch.end) : new Date(start.getTime() + 60 * 60 * 1000);
    allDay = false;
    needsReview = false;
  } else if (dateMatch) {
    start = dateMatch.date;
    end = dateMatch.date;
    allDay = true;
    needsReview = false;
  } else {
    // No date detected at all — placeholder draft the user must edit.
    start = atMidnightUTC(referenceDate);
    start.setUTCDate(start.getUTCDate() + 1);
    start.setUTCHours(9, 0, 0, 0);
    end = new Date(start.getTime() + 30 * 60 * 1000);
    allDay = false;
    needsReview = true;
  }

  let description = String(body || "").trim();
  if (description.length > 2000) description = `${description.slice(0, 2000)}\n...[truncated]`;
  if (needsReview) {
    description = `⚠ Could not detect a date/time in this email — verify before confirming.\n\n${description}`;
  }

  return {
    title,
    start: start.toISOString(),
    end: end.toISOString(),
    allDay,
    location,
    description,
    needsReview,
  };
}
