/**
 * Pure overlap ("clash") detection across expanded calendar events (ODIAA-2328).
 *
 * Input is the flat, already-expanded list POST /calendar/events/list returns: each event
 * has start/end (ISO 8601 UTC instants, or a plain YYYY-MM-DD date when allDay is true),
 * allDay, status, and transparency. Recurring events must already be expanded into
 * individual occurrences before calling this — this function has no concept of recurrence
 * rules, it only compares the intervals it's given.
 *
 * Ignores cancelled events (status === "CANCELLED") and free/transparent events
 * (transparency === "TRANSPARENT"), per this issue's scope. Comparisons use each event's
 * absolute UTC instant, so DST transitions can't produce a false clash/non-clash — a
 * Date parsed from an ISO string with an explicit offset always resolves to the same
 * instant regardless of which side of a DST boundary it falls on.
 *
 * Returns an array of clash groups — connected components of the interval-overlap graph,
 * sorted by start — so a chain of pairwise overlaps (A-B, B-C, A doesn't overlap C) is
 * reported as one group rather than missed or split.
 */

function calendarEventInstant(value, allDay) {
  if (allDay) {
    const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  }
  return new Date(value).getTime();
}

function isRelevantCalendarEvent(event) {
  if (!event) return false;
  if (event.status === "CANCELLED") return false;
  if (event.transparency === "TRANSPARENT") return false;
  return true;
}

function detectCalendarClashes(events) {
  const intervals = (events || [])
    .filter(isRelevantCalendarEvent)
    .map((event) => ({
      event,
      startMs: calendarEventInstant(event.start, event.allDay),
      endMs: calendarEventInstant(event.end, event.allDay),
    }))
    .filter((entry) => Number.isFinite(entry.startMs) && Number.isFinite(entry.endMs) && entry.endMs > entry.startMs)
    .sort((a, b) => a.startMs - b.startMs);

  const groups = [];
  let current = null;

  for (const entry of intervals) {
    if (current && entry.startMs < current.maxEnd) {
      current.items.push(entry);
      current.maxEnd = Math.max(current.maxEnd, entry.endMs);
    } else {
      if (current && current.items.length > 1) groups.push(current);
      current = { items: [entry], maxEnd: entry.endMs };
    }
  }
  if (current && current.items.length > 1) groups.push(current);

  return groups.map((group) => ({
    start: new Date(Math.min(...group.items.map((entry) => entry.startMs))).toISOString(),
    end: new Date(Math.max(...group.items.map((entry) => entry.endMs))).toISOString(),
    events: group.items.map((entry) => entry.event),
  }));
}
