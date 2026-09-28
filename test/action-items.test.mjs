#!/usr/bin/env node
/**
 * Unit tests for extension/src/action-items.js (deterministic action-item extraction).
 * The file is a classic background script, so it is loaded in a vm.
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import vm from "vm";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "extension", "src", "action-items.js");
const ctx = vm.createContext({});
vm.runInContext(readFileSync(SRC, "utf-8"), ctx, { filename: SRC });
const { extractActionItems, actionItemsToMarkdown } = ctx;

let passed = 0, failed = 0;
function test(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else {
    failed++;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`    expected: ${JSON.stringify(expected)}`);
    console.log(`    actual:   ${JSON.stringify(actual)}`);
  }
}

console.log("\n\x1b[1m=== action-items tests ===\x1b[0m");

// ─── checklist / bullets ─────────────────────────────────────────────────────

console.log("\n\x1b[1mextractActionItems: checklist & bullets\x1b[0m");

test(
  "unchecked checklist item",
  extractActionItems("- [ ] Send the invoice"),
  [{ text: "Send the invoice", checked: false, dueHint: null }]
);

test(
  "checked checklist item",
  extractActionItems("- [x] Book the flight"),
  [{ text: "Book the flight", checked: true, dueHint: null }]
);

test(
  "uppercase X checklist item",
  extractActionItems("* [X] Renew passport"),
  [{ text: "Renew passport", checked: true, dueHint: null }]
);

test(
  "plain dash bullet",
  extractActionItems("- Update the roadmap doc"),
  [{ text: "Update the roadmap doc", checked: false, dueHint: null }]
);

test(
  "plain asterisk bullet",
  extractActionItems("* Confirm the venue"),
  [{ text: "Confirm the venue", checked: false, dueHint: null }]
);

test(
  "numbered bullet",
  extractActionItems("1. Prepare the slides"),
  [{ text: "Prepare the slides", checked: false, dueHint: null }]
);

test(
  "numbered bullet with parenthesis",
  extractActionItems("2) Ship the package"),
  [{ text: "Ship the package", checked: false, dueHint: null }]
);

// ─── imperative sentences ─────────────────────────────────────────────────────

console.log("\n\x1b[1mextractActionItems: imperative sentences\x1b[0m");

test(
  "imperative verb at start of line",
  extractActionItems("Send the report to finance."),
  [{ text: "Send the report to finance", checked: false, dueHint: null }]
);

test(
  "non-imperative sentence is ignored",
  extractActionItems("The report was sent to finance yesterday."),
  []
);

test(
  "second sentence in a paragraph is still picked up",
  extractActionItems("Thanks for the update. Please confirm the budget by Friday."),
  [{ text: "Please confirm the budget by Friday", checked: false, dueHint: "Friday" }]
);

// ─── request phrases ─────────────────────────────────────────────────────

console.log("\n\x1b[1mextractActionItems: request phrases\x1b[0m");

test(
  "please phrase",
  extractActionItems("Please review the attached contract."),
  [{ text: "Please review the attached contract", checked: false, dueHint: null }]
);

test(
  "can you phrase",
  extractActionItems("Can you check the numbers again?"),
  [{ text: "Can you check the numbers again", checked: false, dueHint: null }]
);

test(
  "could you phrase",
  extractActionItems("Could you follow up with legal on this."),
  [{ text: "Could you follow up with legal on this", checked: false, dueHint: null }]
);

test(
  "need to phrase",
  extractActionItems("We need to schedule a call before launch."),
  [{ text: "We need to schedule a call before launch", checked: false, dueHint: null }]
);

// ─── date hints ─────────────────────────────────────────────────────

console.log("\n\x1b[1mextractActionItems: date hints\x1b[0m");

test(
  "by weekday",
  extractActionItems("Please send the invoice by Monday."),
  [{ text: "Please send the invoice by Monday", checked: false, dueHint: "Monday" }]
);

test(
  "by tomorrow",
  extractActionItems("Confirm the venue by tomorrow."),
  [{ text: "Confirm the venue by tomorrow", checked: false, dueHint: "tomorrow" }]
);

test(
  "by end of week",
  extractActionItems("Please finish the draft by end of week."),
  [{ text: "Please finish the draft by end of week", checked: false, dueHint: "end of week" }]
);

test(
  "by numeric date",
  extractActionItems("Submit the form by 10/31."),
  [{ text: "Submit the form by 10/31", checked: false, dueHint: "10/31" }]
);

test(
  "by month-day date",
  extractActionItems("Renew the license by Dec 5th."),
  [{ text: "Renew the license by Dec 5th", checked: false, dueHint: "Dec 5th" }]
);

test(
  "checklist items can still carry a date hint",
  extractActionItems("- [ ] Ship the package by Friday"),
  [{ text: "Ship the package by Friday", checked: false, dueHint: "Friday" }]
);

// ─── quoted reply / signature stripping ─────────────────────────────────────────────────────

console.log("\n\x1b[1mextractActionItems: quoted reply & signature stripping\x1b[0m");

test(
  "quoted lines are ignored",
  extractActionItems([
    "Please send the invoice.",
    "> Please ignore this quoted request.",
  ].join("\n")),
  [{ text: "Please send the invoice", checked: false, dueHint: null }]
);

test(
  "content after a signature delimiter is ignored",
  extractActionItems([
    "Please review the contract.",
    "--",
    "Please ignore this line in my signature.",
  ].join("\n")),
  [{ text: "Please review the contract", checked: false, dueHint: null }]
);

// ─── dedup ─────────────────────────────────────────────────────

console.log("\n\x1b[1mextractActionItems: dedup\x1b[0m");

test(
  "duplicate items (case-insensitive) are only kept once",
  extractActionItems([
    "- [ ] Send the invoice",
    "- send the INVOICE",
  ].join("\n")),
  [{ text: "Send the invoice", checked: false, dueHint: null }]
);

test(
  "no action items returns an empty array",
  extractActionItems("Just a regular update with no requests at all."),
  []
);

// ─── actionItemsToMarkdown ─────────────────────────────────────────────────────

console.log("\n\x1b[1mactionItemsToMarkdown\x1b[0m");

test("empty list renders empty string", actionItemsToMarkdown([]), "");

test(
  "unchecked item renders as an open checkbox",
  actionItemsToMarkdown([{ text: "Send the invoice", checked: false, dueHint: null }]),
  "- [ ] Send the invoice"
);

test(
  "checked item renders as a checked checkbox",
  actionItemsToMarkdown([{ text: "Book the flight", checked: true, dueHint: null }]),
  "- [x] Book the flight"
);

test(
  "due hint is appended in parentheses",
  actionItemsToMarkdown([{ text: "Send the invoice", checked: false, dueHint: "Friday" }]),
  "- [ ] Send the invoice (by Friday)"
);

test(
  "multiple items render as separate lines",
  actionItemsToMarkdown([
    { text: "Send the invoice", checked: false, dueHint: "Friday" },
    { text: "Book the flight", checked: true, dueHint: null },
  ]),
  "- [ ] Send the invoice (by Friday)\n- [x] Book the flight"
);

console.log(`\n\x1b[1m${"─".repeat(40)}\x1b[0m`);
console.log(`\x1b[1m${passed} passed, ${failed} failed\x1b[0m`);
process.exit(failed > 0 ? 1 : 0);
