#!/usr/bin/env node
/**
 * Deterministic snapshot tests for lib/skills.js (ODIAA-2332).
 *
 * TZ is pinned to UTC so event/message times render the same regardless of the machine
 * running the suite — these formatters use local-Date getters (see lib/skills.js), not UTC
 * formatting, on purpose (matches cli/src/client.js's non-UTC formatDate()).
 */
process.env.TZ = "UTC";

import {
  formatDate,
  formatTime,
  startOfDay,
  addDays,
  normalizeSubjectForThreading,
  sortEvents,
  formatEventLine,
  renderToday,
  renderWeek,
  renderClashes,
  groupMessagesIntoThreads,
  renderFrom,
} from "../lib/skills.js";

let passed = 0, failed = 0;
function test(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n    ${detail}` : ""}`); }
}

function event(title, start, end, extra = {}) {
  return { id: title, calendarId: "cal1", calendarName: "Work", title, start, end, allDay: false, ...extra };
}

const DATE = new Date("2026-09-28T00:00:00.000Z"); // a Monday

console.log("\ndate/time helpers");
test("formatDate pads month/day", formatDate(new Date(2026, 0, 5)) === "2026-01-05");
test("formatTime pads hour/minute", formatTime(new Date(2026, 0, 5, 9, 5)) === "09:05");
test("startOfDay strips time", startOfDay(new Date("2026-09-28T15:30:00Z")).getHours() === 0);
test("addDays advances calendar day", formatDate(addDays(DATE, 3)) === "2026-10-01");
test("normalizeSubjectForThreading strips Re/Fwd/brackets", normalizeSubjectForThreading("Re: WG: [All-ipp] Call for Participants") === "Call for Participants");

console.log("\nsortEvents");
{
  const events = [
    event("Standup", "2026-09-28T09:00:00Z", "2026-09-28T09:30:00Z"),
    { ...event("Holiday", "2026-09-28", "2026-09-29"), allDay: true },
    event("Dentist", "2026-09-28T14:00:00Z", "2026-09-28T15:00:00Z"),
  ];
  const sorted = sortEvents(events);
  test("all-day events sort first", sorted[0].title === "Holiday");
  test("timed events sort by start ascending", sorted[1].title === "Standup" && sorted[2].title === "Dentist");
}

console.log("\nformatEventLine");
test("timed event line", formatEventLine(event("Standup", "2026-09-28T09:00:00Z", "2026-09-28T09:30:00Z")) === "09:00–09:30 Standup (Work)");
test("all-day event line", formatEventLine({ ...event("Holiday", "2026-09-28", "2026-09-29"), allDay: true, calendarName: "Family" }) === "All day: Holiday (Family)");
test("event line includes location", formatEventLine(event("Dentist", "2026-09-28T14:00:00Z", "2026-09-28T15:00:00Z", { location: "Downtown Clinic" })) === "14:00–15:00 Dentist (Work) — Downtown Clinic");

console.log("\nrenderToday");
{
  const md = renderToday({
    date: DATE,
    events: [event("Standup", "2026-09-28T09:00:00Z", "2026-09-28T09:30:00Z")],
    calendarError: null,
    unreadTotal: 12,
    flagged: { count: 3, hasMore: false },
  });
  test("today header uses date", md.startsWith("# Today — 2026-09-28\n"));
  test("today lists event", md.includes("- 09:00–09:30 Standup (Work)"));
  test("today lists unread/flagged", md.includes("- 12 unread") && md.includes("- 3 flagged"));
  test("today output ends with single trailing newline", md.endsWith("\n") && !md.endsWith("\n\n"));
}
{
  const md = renderToday({ date: DATE, events: [], calendarError: "calendar experiment not loaded", unreadTotal: 0, flagged: null });
  test("today surfaces calendar error instead of crashing", md.includes("unavailable: calendar experiment not loaded"));
}
{
  const md = renderToday({ date: DATE, events: [], calendarError: null, unreadTotal: 0, flagged: { count: 5, hasMore: true } });
  test("today marks flagged count as a floor when capped", md.includes("- 5+ flagged"));
}

console.log("\nrenderWeek");
{
  const md = renderWeek({
    start: DATE,
    numDays: 7,
    events: [
      event("Standup", "2026-09-28T09:00:00Z", "2026-09-28T09:30:00Z"),
      { ...event("Holiday", "2026-10-01", "2026-10-02"), allDay: true },
    ],
  });
  test("week header", md.startsWith("# Week of 2026-09-28\n"));
  test("week groups events under their day", md.includes("## Mon 2026-09-28") && md.includes("## Thu 2026-10-01"));
  test("week reports free-day count", md.includes("5 of 7 days free"));
}
{
  const md = renderWeek({ start: DATE, numDays: 7, events: [], calendarError: "calendar experiment not loaded" });
  test("week surfaces calendar error", md.includes("unavailable: calendar experiment not loaded"));
}

console.log("\nrenderClashes");
{
  const md = renderClashes({
    start: DATE,
    end: addDays(DATE, 7),
    clashes: [{
      start: "2026-09-29T10:00:00Z",
      end: "2026-09-29T11:00:00Z",
      events: [
        event("Team Sync", "2026-09-29T10:00:00Z", "2026-09-29T11:00:00Z"),
        event("Dentist", "2026-09-29T10:30:00Z", "2026-09-29T11:00:00Z"),
      ],
    }],
  });
  test("clashes header covers the range", md.startsWith("# Clashes — 2026-09-28 to 2026-10-05\n"));
  test("clashes group lists both events", md.includes("Team Sync") && md.includes("Dentist"));
}
{
  const md = renderClashes({ start: DATE, end: addDays(DATE, 7), clashes: [] });
  test("no clashes found message", md.includes("No clashes found."));
}

console.log("\ngroupMessagesIntoThreads / renderFrom");
{
  const messages = [
    { subject: "Project Kickoff", author: "jane@example.com", date: "2026-09-18T14:22:00Z" },
    { subject: "Re: Project Kickoff", author: "jane@example.com", date: "2026-09-27T10:15:00Z" },
    { subject: "Invoice #4821", author: "billing@example.com", date: "2026-09-25T08:00:00Z" },
  ];
  const threads = groupMessagesIntoThreads(messages);
  test("groups by normalized subject", threads.length === 2);
  test("most-recently-active thread first", threads[0].subject === "Project Kickoff");
  test("newest message first within a thread", threads[0].messages[0].date === "2026-09-27T10:15:00Z");

  const md = renderFrom({ address: "jane@example.com", threads, hasMore: false });
  test("from header includes counts", md.startsWith("# Mail from jane@example.com (3 messages, 2 threads)\n"));
  test("from lists thread with message count", md.includes("## Project Kickoff (2)"));
}
{
  const md = renderFrom({ address: "nobody@example.com", threads: [], hasMore: false });
  test("no messages found message", md.includes("No messages found."));
}

console.log(`\n\x1b[1m${"─".repeat(40)}\x1b[0m`);
console.log(`\x1b[1m${passed} passed, ${failed} failed, ${passed + failed} total\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
