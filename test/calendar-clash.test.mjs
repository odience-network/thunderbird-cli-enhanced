#!/usr/bin/env node
/**
 * Unit tests for the pure clash-detection function (extension/src/calendar-clash.js).
 * Loaded via vm, same pattern as test/access-control.test.mjs, since the file is a plain
 * background script (no module exports).
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import vm from "vm";

const EXT = join(dirname(fileURLToPath(import.meta.url)), "..", "extension");
const context = vm.createContext({});
vm.runInContext(readFileSync(join(EXT, "src/calendar-clash.js"), "utf8"), context);
const detectCalendarClashes = vm.runInContext("detectCalendarClashes", context);

let passed = 0, failed = 0;
function test(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
}

function event(id, start, end, extra = {}) {
  return { id, calendarId: "cal1", title: id, start, end, allDay: false, status: "CONFIRMED", transparency: "OPAQUE", ...extra };
}

console.log("\n\x1b[1m=== Calendar clash detection tests ===\x1b[0m\n");

// ─── No events / single event ──────────────────────────────────────────

{
  const clashes = detectCalendarClashes([]);
  test("empty input produces no clashes", clashes.length === 0);
}

{
  const clashes = detectCalendarClashes([event("A", "2026-01-15T10:00:00Z", "2026-01-15T11:00:00Z")]);
  test("a single event never clashes", clashes.length === 0);
}

// ─── Basic overlap ──────────────────────────────────────────────────────

{
  const clashes = detectCalendarClashes([
    event("A", "2026-01-15T10:00:00Z", "2026-01-15T11:00:00Z"),
    event("B", "2026-01-15T10:30:00Z", "2026-01-15T11:30:00Z"),
  ]);
  test("overlapping events produce one clash group", clashes.length === 1);
  test("clash group contains both events", clashes[0]?.events?.length === 2);
}

// ─── Adjacent (touching), not overlapping ──────────────────────────────

{
  const clashes = detectCalendarClashes([
    event("A", "2026-01-15T10:00:00Z", "2026-01-15T11:00:00Z"),
    event("B", "2026-01-15T11:00:00Z", "2026-01-15T12:00:00Z"),
  ]);
  test("back-to-back events (touching boundary) do not clash", clashes.length === 0);
}

// ─── One event fully contains another ──────────────────────────────────

{
  const clashes = detectCalendarClashes([
    event("A", "2026-01-15T09:00:00Z", "2026-01-15T17:00:00Z"),
    event("B", "2026-01-15T10:00:00Z", "2026-01-15T10:30:00Z"),
  ]);
  test("a short event fully inside a long one clashes", clashes.length === 1 && clashes[0].events.length === 2);
}

// ─── Chained overlap forms one connected-component group ───────────────

{
  const clashes = detectCalendarClashes([
    event("A", "2026-01-15T09:00:00Z", "2026-01-15T10:00:00Z"),
    event("B", "2026-01-15T09:30:00Z", "2026-01-15T10:30:00Z"), // overlaps A
    event("C", "2026-01-15T10:15:00Z", "2026-01-15T11:00:00Z"), // overlaps B, not A
  ]);
  test("chained overlaps (A-B, B-C) form a single group", clashes.length === 1);
  test("chained group includes all three events", clashes[0]?.events?.length === 3);
}

// ─── Two separate, non-overlapping clash groups ────────────────────────

{
  const clashes = detectCalendarClashes([
    event("A", "2026-01-15T09:00:00Z", "2026-01-15T10:00:00Z"),
    event("B", "2026-01-15T09:30:00Z", "2026-01-15T10:30:00Z"),
    event("C", "2026-01-15T14:00:00Z", "2026-01-15T15:00:00Z"),
    event("D", "2026-01-15T14:30:00Z", "2026-01-15T15:30:00Z"),
  ]);
  test("two independent overlapping pairs produce two groups", clashes.length === 2);
}

// ─── Cancelled and transparent events are ignored ──────────────────────

{
  const clashes = detectCalendarClashes([
    event("A", "2026-01-15T10:00:00Z", "2026-01-15T11:00:00Z"),
    event("B", "2026-01-15T10:30:00Z", "2026-01-15T11:30:00Z", { status: "CANCELLED" }),
  ]);
  test("cancelled events are ignored", clashes.length === 0);
}

{
  const clashes = detectCalendarClashes([
    event("A", "2026-01-15T10:00:00Z", "2026-01-15T11:00:00Z"),
    event("B", "2026-01-15T10:30:00Z", "2026-01-15T11:30:00Z", { transparency: "TRANSPARENT" }),
  ]);
  test("free/transparent events are ignored", clashes.length === 0);
}

{
  const clashes = detectCalendarClashes([
    event("A", "2026-01-15T10:00:00Z", "2026-01-15T11:00:00Z"),
    event("B", "2026-01-15T10:30:00Z", "2026-01-15T11:30:00Z"),
    event("C", "2026-01-15T10:45:00Z", "2026-01-15T11:15:00Z", { status: "CANCELLED" }),
  ]);
  test("a cancelled event doesn't bridge two otherwise-separate events into one group", clashes.length === 1 && clashes[0].events.length === 2);
}

// ─── All-day events ─────────────────────────────────────────────────────

{
  const clashes = detectCalendarClashes([
    event("A", "2026-01-15", "2026-01-16", { allDay: true }),
    event("B", "2026-01-15T10:00:00Z", "2026-01-15T11:00:00Z"),
  ]);
  test("an all-day event clashes with a timed event the same day", clashes.length === 1);
}

{
  // All-day DTEND is exclusive per RFC 5545: a one-day event on the 15th has end="2026-01-16".
  // A second all-day event starting on the 16th must NOT clash with it.
  const clashes = detectCalendarClashes([
    event("A", "2026-01-15", "2026-01-16", { allDay: true }),
    event("B", "2026-01-16", "2026-01-17", { allDay: true }),
  ]);
  test("consecutive all-day events (exclusive end date) do not clash", clashes.length === 0);
}

{
  const clashes = detectCalendarClashes([
    event("A", "2026-01-15", "2026-01-17", { allDay: true }), // spans 15th-16th
    event("B", "2026-01-16", "2026-01-18", { allDay: true }), // spans 16th-17th
  ]);
  test("overlapping multi-day all-day events clash", clashes.length === 1);
}

// ─── DST transitions: absolute-instant comparison, not wall-clock ──────

{
  // US "spring forward" 2026-03-08: 01:59 EST (-05:00) jumps to 03:00 EDT (-04:00). Wall-clock,
  // A (01:30-02:30) and B (03:00-04:00) look disjoint with a 30-minute gap. But the DST jump
  // erases an hour of absolute time, so in UTC they're 06:30-07:30Z and 07:00-08:00Z — they
  // actually DO overlap. A naive wall-clock diff would miss this; instant comparison catches it.
  const clashes = detectCalendarClashes([
    event("A", "2026-03-08T01:30:00-05:00", "2026-03-08T02:30:00-05:00"),
    event("B", "2026-03-08T03:00:00-04:00", "2026-03-08T04:00:00-04:00"),
  ]);
  test("events with a wall-clock gap spanning a spring-forward jump still clash in absolute time", clashes.length === 1);
}

{
  // Same nominal local times, but B given in UTC and A given in an equivalent offset that DOES
  // overlap once resolved to an absolute instant.
  const clashes = detectCalendarClashes([
    event("A", "2026-03-08T06:30:00Z", "2026-03-08T08:00:00Z"), // 01:30-03:00 EST
    event("B", "2026-03-08T07:00:00-04:00", "2026-03-08T08:00:00-04:00"), // 11:00-12:00Z
  ]);
  // A ends at 08:00Z; B (07:00-04:00 = 11:00Z) starts after A ends -> no overlap either.
  test("DST-adjacent instants compare correctly across differing UTC offsets", clashes.length === 0);
}

{
  const clashes = detectCalendarClashes([
    event("A", "2026-03-08T01:30:00-05:00", "2026-03-08T03:30:00-04:00"), // spans the DST jump
    event("B", "2026-03-08T03:15:00-04:00", "2026-03-08T04:00:00-04:00"), // starts just before A ends
  ]);
  test("an event spanning a DST jump still clashes correctly with one starting inside it", clashes.length === 1);
}

// ─── Recurring instances are treated as independent, already-expanded events ─

{
  const clashes = detectCalendarClashes([
    event("series", "2026-01-05T09:00:00Z", "2026-01-05T10:00:00Z", { recurring: true, recurrenceId: "2026-01-05" }),
    event("series", "2026-01-12T09:00:00Z", "2026-01-12T10:00:00Z", { recurring: true, recurrenceId: "2026-01-12" }),
    event("oneoff", "2026-01-12T09:30:00Z", "2026-01-12T10:30:00Z"),
  ]);
  test("only the recurring instance overlapping the one-off event clashes", clashes.length === 1);
  test("the clashing group is the 2026-01-12 occurrence, not the 01-05 one", clashes[0]?.events?.some((e) => e.recurrenceId === "2026-01-12"));
}

console.log(`\n\x1b[1m${"─".repeat(40)}\x1b[0m`);
console.log(`\x1b[1m${passed} passed, ${failed} failed, ${passed + failed} total\x1b[0m\n`);
process.exit(failed > 0 ? 1 : 0);
