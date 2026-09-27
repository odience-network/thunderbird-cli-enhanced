/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ODIAA-2329: task (VTODO) CRUD slice of the `calendar_items` Experiment API drafted at
 * https://github.com/thunderbird/webext-experiments (calendar/experiments/calendar/parent/
 * ext-calendar-items.js, `calendar.items` namespace), pinned commit
 * b7f7cb3e76807903a785a03784d6e7df7b213f21.
 *
 * Adapted, not copied verbatim:
 * 1. Given its own namespace (`calendar.tasks`, this file) rather than folding into upstream's
 *    combined `calendar.items` (events + tasks): the event half of that surface is a separate,
 *    concurrently in-flight issue (ODIAA-2306c) not yet on `main`, and this PR branches from
 *    `main` alone. A future cleanup can merge the two namespaces once both have landed.
 * 2. Trimmed to query/create/update on tasks only — no `get`, `remove`, `move`, `getCurrent`,
 *    or the onCreated/onUpdated/onRemoved/onAlarm listeners; outside this issue's scope
 *    (`POST /tasks/list|create|update`, no delete route).
 * 3. Dropped upstream's calendar-*provider* metadata/cache branches (isOwnCalendar,
 *    getCachedCalendar, isCachedCalendar, the "#cache" calendar-id suffix): those exist so a
 *    calendar *implemented by* the extension itself (calendar.provider) can round-trip its
 *    own metadata. This add-on is a plain consumer of Thunderbird's built-in calendars
 *    (storage/caldav/ics), never a provider, so none of that applies.
 * 4. Replaced upstream's ical/jcal round-trip contract (propsToItem/convertItem, built on
 *    ICAL.js and a full RFC 5545 blob per item) with plain field getters/setters — title,
 *    due, allDay, priority, completed, description — plus one custom `X-THUNDERBIRD-CLI-
 *    SOURCE-MESSAGE-ID` property (exposed as `source`) so a task can link back to the email
 *    it was created from, per this issue's scope. The underlying calendar.manager /
 *    calICalendar calls (getItemsAsArray, adoptItem, modifyItem, getItem) are unchanged from
 *    upstream.
 *
 * Everything else — the `.sys.mjs`/`ChromeUtils.importESModule` imports and `cal.manager`
 * accessor — matches upstream `main` at the pinned commit.
 */

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
var { CalTodo } = ChromeUtils.importESModule("resource:///modules/CalTodo.sys.mjs");

var { ExtensionAPI } = ExtensionCommon;

const SOURCE_MESSAGE_ID_PROPERTY = "X-THUNDERBIRD-CLI-SOURCE-MESSAGE-ID";

function toCalDateTime(value, allDay) {
  if (allDay) {
    const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
    const dt = cal.dtz.jsDateToDateTime(new Date(Date.UTC(y, m - 1, d)), cal.dtz.floating);
    dt.isDate = true;
    return dt;
  }
  const jsDate = new Date(value);
  if (Number.isNaN(jsDate.getTime())) {
    throw new Error(`Invalid date/time: ${value}`);
  }
  return cal.dtz.jsDateToDateTime(jsDate, cal.dtz.UTC);
}

function fromCalDateTime(dt) {
  if (!dt) return null;
  if (dt.isDate) {
    const y = String(dt.year).padStart(4, "0");
    const m = String(dt.month + 1).padStart(2, "0");
    const d = String(dt.day).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  // `dt.jsDate`/`dt.getInTimezone(...).jsDate` are unreliable (always undefined) on a
  // calIDateTime handed back by the storage calendar after an adoptItem/modifyItem round-trip,
  // even for a date that was set correctly — `nativeTime` (epoch microseconds) is always present.
  const ms = Number(dt.nativeTime) / 1000;
  if (!Number.isFinite(ms)) return null;
  // The storage calendar also round-trips an *unset* DUE/COMPLETED as an epoch-ish sentinel
  // (epoch shifted by the local UTC offset) rather than as null. No real due/completed date is
  // ever within a day of the Unix epoch, so treat that range as "no date".
  if (Math.abs(ms) < 24 * 60 * 60 * 1000) return null;
  return new Date(ms).toISOString();
}

function markCompletion(item, completed) {
  if (completed) {
    item.status = "COMPLETED";
    item.setProperty("PERCENT-COMPLETE", 100);
    item.completedDate = cal.dtz.jsDateToDateTime(new Date(), cal.dtz.UTC);
  } else {
    item.status = "NEEDS-ACTION";
    item.setProperty("PERCENT-COMPLETE", 0);
    item.completedDate = null;
  }
}

// The WebExtension schema layer normalizes the `CalendarTaskProperties` object by filling every
// optional field the caller didn't set with `null` before it reaches this Experiment API — it's
// never actually `undefined` here. So "did the caller mean to set this" must check `!= null`
// (which also still treats explicit `0`/`false`/`""` as real values), not `!== undefined`.
function propsToItem(properties) {
  const item = new CalTodo();
  item.title = properties.title || "";
  if (properties.due != null) item.dueDate = toCalDateTime(properties.due, !!properties.allDay);
  if (properties.description) item.setProperty("DESCRIPTION", properties.description);
  if (properties.priority != null) item.priority = properties.priority;
  if (properties.source) item.setProperty(SOURCE_MESSAGE_ID_PROPERTY, properties.source);
  if (properties.status != null) item.status = properties.status;
  if (properties.completed != null) markCompletion(item, !!properties.completed);
  return item;
}

// Partial update: unlike upstream's propsToItem (a full replacement built from a complete
// ical/jcal blob every time), this only touches fields the caller actually sent, on a clone
// of the existing item — so an update that only changes `completed` doesn't drop the task's
// due date, priority, etc.
function applyPropsToItem(item, properties) {
  if (properties.title != null) item.title = properties.title;
  if (properties.due != null) {
    const allDay = properties.allDay != null ? !!properties.allDay : !!(item.dueDate?.isDate);
    item.dueDate = toCalDateTime(properties.due, allDay);
  }
  if (properties.description != null) item.setProperty("DESCRIPTION", properties.description || "");
  if (properties.priority != null) item.priority = properties.priority;
  if (properties.source != null) item.setProperty(SOURCE_MESSAGE_ID_PROPERTY, properties.source || "");
  if (properties.completed != null) markCompletion(item, !!properties.completed);
  else if (properties.status != null) item.status = properties.status;
  return item;
}

function convertItem(item) {
  if (!item) return null;
  const percentComplete = Number(item.getProperty("PERCENT-COMPLETE") || 0);
  return {
    id: item.id,
    calendarId: item.calendar.id,
    calendarName: item.calendar.name,
    title: item.title || "",
    description: item.getProperty("DESCRIPTION") || "",
    due: fromCalDateTime(item.dueDate),
    allDay: !!item.dueDate?.isDate,
    priority: item.priority || 0,
    completed: item.status === "COMPLETED" || percentComplete >= 100,
    completedDate: fromCalDateTime(item.completedDate),
    status: item.status || "NEEDS-ACTION",
    source: item.getProperty(SOURCE_MESSAGE_ID_PROPERTY) || undefined,
  };
}

function resolveCalendar(calendarId) {
  const calendar = cal.manager.getCalendarById(calendarId);
  if (!calendar) throw new Error(`Invalid calendar: ${calendarId}`);
  return calendar;
}

this.calendar_tasks = class extends ExtensionAPI {
  getAPI() {
    return {
      calendar: {
        tasks: {
          async query({ calendarId, completed } = {}) {
            const calendars = calendarId
              ? [resolveCalendar(calendarId)]
              : cal.manager.getCalendars().filter((calendar) => !calendar.getProperty("disabled"));

            let filter = Ci.calICalendar.ITEM_FILTER_TYPE_TODO;
            filter |= completed === true
              ? Ci.calICalendar.ITEM_FILTER_COMPLETED_YES
              : completed === false
                ? Ci.calICalendar.ITEM_FILTER_COMPLETED_NO
                : Ci.calICalendar.ITEM_FILTER_COMPLETED_ALL;

            const results = await Promise.all(
              calendars.map((calendar) => calendar.getItemsAsArray(filter, 0, null, null))
            );
            return results.flat().map(convertItem);
          },
          async create(calendarId, properties) {
            const calendar = resolveCalendar(calendarId);
            const item = propsToItem(properties);
            item.calendar = calendar.superCalendar;
            const createdItem = await calendar.adoptItem(item);
            return convertItem(createdItem);
          },
          async update(calendarId, id, properties) {
            const calendar = resolveCalendar(calendarId);
            const oldItem = await calendar.getItem(id);
            if (!oldItem) throw new Error(`Could not find task ${id}`);
            const newItem = applyPropsToItem(oldItem.clone(), properties);
            const modifiedItem = await calendar.modifyItem(newItem, oldItem);
            return convertItem(modifiedItem);
          },
        },
      },
    };
  }
};
