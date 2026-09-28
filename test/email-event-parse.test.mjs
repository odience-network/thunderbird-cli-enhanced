#!/usr/bin/env node
/**
 * Unit tests for extension/src/email-event-parse.js (deterministic event-draft extraction).
 * The file is a classic background script, so it is loaded in a vm.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import vm from "vm";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "src", "email-event-parse.js");
const ctx = vm.createContext({});
vm.runInContext(readFileSync(SRC, "utf-8"), ctx, { filename: SRC });
const { parseEventDraft } = ctx;

let passed = 0, failed = 0;
function test(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failed++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
}

// Thursday, 2026-01-01T12:00:00Z — a fixed, known reference point for every test below.
const REF = "2026-01-01T12:00:00Z";

console.log("\n\x1b[1m=== email-event-parse tests ===\x1b[0m");

console.log("\n\x1b[1mparseEventDraft: relative dates\x1b[0m");

{
  const d = parseEventDraft({ subject: "Quick sync", body: "Let's meet tomorrow at 3pm at the Downtown Office.", date: REF });
  test("tomorrow resolves to the day after the reference date", d.start.startsWith("2026-01-02"));
  test("time is parsed as 3pm", new Date(d.start).getUTCHours() === 15);
  test("not flagged for review", d.needsReview === false);
  test("not all-day", d.allDay === false);
  test("location picked up from 'at <Place>'", d.location === "Downtown Office");
}

{
  const d = parseEventDraft({ subject: "Heads up", body: "We're on for today, no specific time though.", date: REF });
  test("today resolves to the reference date itself", d.start.startsWith("2026-01-01"));
  test("no time found means all-day", d.allDay === true);
}

console.log("\n\x1b[1mparseEventDraft: weekday resolution\x1b[0m");

{
  const d = parseEventDraft({ subject: "Planning", body: "Can we sync on Friday at 10am?", date: REF });
  const start = new Date(d.start);
  test("resolved date falls on a Friday", start.getUTCDay() === 5);
  test("resolved date is on/after the reference date", start.getTime() >= new Date(REF).getTime());
  test("time is parsed as 10am", start.getUTCHours() === 10);
}

{
  const d = parseEventDraft({ subject: "Planning", body: "Let's push it to next Friday instead.", date: REF });
  const baseline = parseEventDraft({ subject: "Planning", body: "Let's meet Friday instead.", date: REF });
  test("'next Friday' resolves a week later than plain 'Friday'", new Date(d.start).getTime() === new Date(baseline.start).getTime() + 7 * 24 * 3600 * 1000);
}

console.log("\n\x1b[1mparseEventDraft: explicit dates\x1b[0m");

{
  const d = parseEventDraft({ subject: "Deadline", body: "Reminder: submit the report by 3/15.", date: REF });
  const start = new Date(d.start);
  test("numeric month/day parsed", start.getUTCMonth() === 2 && start.getUTCDate() === 15);
}

{
  const d = parseEventDraft({ subject: "Save the date", body: "The offsite is on Dec 5th, hope to see you there.", date: REF });
  const start = new Date(d.start);
  test("month-name date parsed", start.getUTCMonth() === 11 && start.getUTCDate() === 5);
  test("no explicit year rolls forward into the same year as the reference date when still upcoming", start.getUTCFullYear() === 2026);
}

console.log("\n\x1b[1mparseEventDraft: time ranges\x1b[0m");

{
  const d = parseEventDraft({ subject: "Workshop", body: "Join us Monday from 2-3pm for the workshop.", date: REF });
  const start = new Date(d.start), end = new Date(d.end);
  test("range start hour inherits trailing meridiem", start.getUTCHours() === 14);
  test("range end hour parsed", end.getUTCHours() === 15);
}

{
  const d = parseEventDraft({ subject: "Standup", body: "Standup is on Wednesday at 9am, should take about 15 minutes.", date: REF });
  const start = new Date(d.start), end = new Date(d.end);
  test("single time with no explicit end defaults to a 1 hour block", end.getTime() - start.getTime() === 60 * 60 * 1000);
}

console.log("\n\x1b[1mparseEventDraft: location extraction\x1b[0m");

{
  const d = parseEventDraft({ subject: "Meeting", body: "Location: Conference Room B, 4th Floor\nMonday at 10am.", date: REF });
  test("explicit 'Location:' label wins", d.location === "Conference Room B, 4th Floor");
}

{
  const d = parseEventDraft({ subject: "Standup", body: "We'll meet in Room 204 on Tuesday at 9am.", date: REF });
  test("'Room ###' pattern detected", d.location === "Room 204");
}

{
  const d = parseEventDraft({ subject: "Kickoff", body: "Join via https://zoom.us/j/1234567890 on Monday at 1pm.", date: REF });
  test("meeting URL detected as location", d.location === "https://zoom.us/j/1234567890");
}

{
  const d = parseEventDraft({ subject: "Catch up", body: "Let's grab coffee sometime next week.", date: REF });
  test("no location found returns null", d.location === null);
}

console.log("\n\x1b[1mparseEventDraft: fallback when nothing is detected\x1b[0m");

{
  const d = parseEventDraft({ subject: "Random update", body: "Nothing time-related in this email at all.", date: REF });
  test("needsReview is true when no date/time is found", d.needsReview === true);
  test("description carries a review warning", d.description.includes("Could not detect"));
  test("start is still a valid ISO date", !isNaN(new Date(d.start).getTime()));
}

console.log("\n\x1b[1mparseEventDraft: title\x1b[0m");

{
  const d = parseEventDraft({ subject: "Re: Fwd: Team lunch", body: "Friday at noon.", date: REF });
  test("Re:/Fwd: prefixes are stripped from the title", d.title === "Team lunch");
}

{
  const d = parseEventDraft({ subject: "", body: "Meeting tomorrow.", date: REF });
  test("empty subject falls back to a placeholder title", d.title === "Untitled event");
}

console.log(`\n\x1b[1m${"─".repeat(40)}\x1b[0m`);
console.log(`\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed > 0 ? 1 : 0);
