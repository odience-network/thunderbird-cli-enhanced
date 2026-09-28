/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ODIAA-2328: event CRUD slice of the `calendar_items` Experiment API drafted at
 * https://github.com/thunderbird/webext-experiments (calendar/experiments/calendar/parent/
 * ext-calendar-items.js, `calendar.items` namespace), pinned commit
 * b7f7cb3e76807903a785a03784d6e7df7b213f21.
 *
 * Adapted, not copied verbatim:
 * 1. Trimmed to query/get/create/update/remove on events only — no tasks, no `move`,
 *    `getCurrent`, or the onCreated/onUpdated/onRemoved/onAlarm listeners. That surface is
 *    outside this issue's scope (ODIAA-2306c/d is events; tasks are a separate issue).
 * 2. Dropped upstream's calendar-*provider* metadata/cache branches (isOwnCalendar,
 *    getCachedCalendar, isCachedCalendar, the "#cache" calendar-id suffix): those exist so a
 *    calendar *implemented by* the extension itself (calendar.provider) can round-trip its
 *    own metadata. This add-on is a plain consumer of Thunderbird's built-in calendars
 *    (storage/caldav/ics), never a provider, so none of that applies.
 * 3. Replaced upstream's ical/jcal round-trip contract (propsToItem/convertItem, built on
 *    ICAL.js and a full RFC 5545 blob per item) with plain field getters/setters — title,
 *    start, end, allDay, location, description, status, transparency. Simpler for a JSON
 *    bridge API, and it's what /calendar/clashes needs. The underlying calendar.manager /
 *    calICalendar calls (getItemsAsArray, adoptItem, modifyItem, deleteItem, getItem) are
 *    unchanged from upstream.
 *
 * Everything else — the `.sys.mjs`/`ChromeUtils.importESModule` imports and `cal.manager`
 * accessor — matches upstream `main` at the pinned commit.
 */

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { ExtensionError } = ChromeUtils.importESModule("resource://gre/modules/ExtensionUtils.sys.mjs");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");
var { CalEvent } = ChromeUtils.importESModule("resource:///modules/CalEvent.sys.mjs");

var { ExtensionAPI } = ExtensionCommon;

// Thunderbird's WebExtensions bridge sanitizes plain `Error`s thrown from privileged
// (parent-scope) Experiment API code down to a generic "An unexpected error occurred"
// before they reach the background script — only `ExtensionError` messages survive
// that boundary. Every throw site here (and every calICalendar call that can reject
// with an internal NS_ERROR/Components.Exception) needs to go through this helper.
function asExtensionError(error) {
  return error instanceof ExtensionError ? error : new ExtensionError(String(error?.message || error));
}

function toCalDateTime(value, allDay) {
  if (allDay) {
    const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
    const dt = cal.dtz.jsDateToDateTime(new Date(Date.UTC(y, m - 1, d)), cal.dtz.floating);
    dt.isDate = true;
    return dt;
  }
  const jsDate = new Date(value);
  if (Number.isNaN(jsDate.getTime())) {
    throw new ExtensionError(`Invalid date/time: ${value}`);
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
  // calIDateTime dropped its `.jsDate` property; cal.dtz.dateTimeToJsDate() is the
  // documented replacement (see calDateTimeUtils.sys.mjs).
  return cal.dtz.dateTimeToJsDate(dt.getInTimezone(cal.dtz.UTC)).toISOString();
}

function propsToItem(properties) {
  const item = new CalEvent();
  item.title = properties.title || "";
  const allDay = !!properties.allDay;
  item.startDate = toCalDateTime(properties.start, allDay);
  item.endDate = toCalDateTime(properties.end, allDay);
  if (properties.description) item.setProperty("DESCRIPTION", properties.description);
  if (properties.location) item.setProperty("LOCATION", properties.location);
  if (properties.status) item.setProperty("STATUS", properties.status);
  if (properties.transparency) item.setProperty("TRANSP", properties.transparency);
  return item;
}

// Partial update: unlike upstream's propsToItem (a full replacement built from a complete
// ical/jcal blob every time), this only touches fields the caller actually sent, on a clone
// of `oldItem` — so an update that only changes `title` doesn't drop the item's location,
// alarms, categories, etc.
//
// The WebExtensions schema layer normalizes omitted optional properties on the `properties`
// object to explicit `null` (not `undefined`) by the time this reaches parent-scope code, so
// every "was this field sent?" check here must treat both as "not sent" — `!== undefined`
// alone silently overwrote fields with `null`/`false` on every update.
function isProvided(value) {
  return value !== undefined && value !== null;
}

function applyPropsToItem(item, oldItem, properties) {
  const allDay = isProvided(properties.allDay) ? !!properties.allDay : !!(oldItem.startDate?.isDate);
  item.title = isProvided(properties.title) ? properties.title : oldItem.title;
  if (isProvided(properties.start) || isProvided(properties.end) || isProvided(properties.allDay)) {
    const start = isProvided(properties.start) ? properties.start : fromCalDateTime(oldItem.startDate);
    const end = isProvided(properties.end) ? properties.end : fromCalDateTime(oldItem.endDate);
    item.startDate = toCalDateTime(start, allDay);
    item.endDate = toCalDateTime(end, allDay);
  }
  item.setProperty("DESCRIPTION", (isProvided(properties.description) ? properties.description : oldItem.getProperty("DESCRIPTION")) || "");
  item.setProperty("LOCATION", (isProvided(properties.location) ? properties.location : oldItem.getProperty("LOCATION")) || "");
  item.setProperty("STATUS", (isProvided(properties.status) ? properties.status : oldItem.getProperty("STATUS")) || "");
  item.setProperty("TRANSP", (isProvided(properties.transparency) ? properties.transparency : oldItem.getProperty("TRANSP")) || "");
  return item;
}

function convertItem(item) {
  if (!item) return null;
  const recurrenceId = item.recurrenceId ? fromCalDateTime(item.recurrenceId) : undefined;
  return {
    id: item.id,
    calendarId: item.calendar.id,
    calendarName: item.calendar.name,
    title: item.title || "",
    description: item.getProperty("DESCRIPTION") || "",
    location: item.getProperty("LOCATION") || "",
    start: fromCalDateTime(item.startDate),
    end: fromCalDateTime(item.endDate),
    allDay: !!item.startDate?.isDate,
    status: item.getProperty("STATUS") || "CONFIRMED",
    transparency: item.getProperty("TRANSP") || "OPAQUE",
    recurring: !!item.recurrenceInfo,
    ...(recurrenceId ? { recurrenceId } : {}),
  };
}

function resolveCalendar(calendarId) {
  const calendar = cal.manager.getCalendarById(calendarId);
  if (!calendar) throw new ExtensionError(`Invalid calendar: ${calendarId}`);
  return calendar;
}

this.calendar_items = class extends ExtensionAPI {
  getAPI() {
    return {
      calendar: {
        items: {
          async query({ calendarId, start, end, expand = true } = {}) {
            const calendars = calendarId
              ? [resolveCalendar(calendarId)]
              : cal.manager.getCalendars().filter((calendar) => !calendar.getProperty("disabled"));

            const rangeStart = start ? cal.dtz.jsDateToDateTime(new Date(start), cal.dtz.UTC) : null;
            const rangeEnd = end ? cal.dtz.jsDateToDateTime(new Date(end), cal.dtz.UTC) : null;

            let filter = Ci.calICalendar.ITEM_FILTER_TYPE_EVENT | Ci.calICalendar.ITEM_FILTER_COMPLETED_ALL;
            if (expand) filter |= Ci.calICalendar.ITEM_FILTER_CLASS_OCCURRENCES;

            const results = await Promise.all(
              calendars.map((calendar) => calendar.getItemsAsArray(filter, 0, rangeStart, rangeEnd))
            );
            return results.flat().map(convertItem);
          },
          async get(calendarId, id) {
            const calendar = resolveCalendar(calendarId);
            const item = await calendar.getItem(id);
            return convertItem(item);
          },
          async create(calendarId, properties) {
            const calendar = resolveCalendar(calendarId);
            const item = propsToItem(properties);
            item.calendar = calendar.superCalendar;
            try {
              const createdItem = await calendar.adoptItem(item);
              return convertItem(createdItem);
            } catch (error) {
              throw asExtensionError(error);
            }
          },
          async update(calendarId, id, properties) {
            const calendar = resolveCalendar(calendarId);
            const oldItem = await calendar.getItem(id);
            if (!oldItem) throw new ExtensionError(`Could not find item ${id}`);
            const newItem = applyPropsToItem(oldItem.clone(), oldItem, properties);
            try {
              const modifiedItem = await calendar.modifyItem(newItem, oldItem);
              return convertItem(modifiedItem);
            } catch (error) {
              throw asExtensionError(error);
            }
          },
          async remove(calendarId, id) {
            const calendar = resolveCalendar(calendarId);
            const item = await calendar.getItem(id);
            if (!item) throw new ExtensionError(`Could not find item ${id}`);
            try {
              await calendar.deleteItem(item);
            } catch (error) {
              throw asExtensionError(error);
            }
            return { id, calendarId };
          },
        },
      },
    };
  }
};
