/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ODIAA-2327 proof: read-only slice of the `calendar_calendars` Experiment API drafted at
 * https://github.com/thunderbird/webext-experiments/tree/master/calendar
 * (experiments/calendar/parent/ext-calendar-calendars.js, calendar_calendars.query).
 *
 * Adapted, not copied verbatim — two changes from upstream:
 *   1. Ported ChromeUtils.import(".../calUtils.jsm") to ChromeUtils.importESModule(".../calUtils.sys.mjs").
 *      comm-central renamed every calendar module from .jsm to .sys.mjs in 2023 (pre-dating our
 *      Thunderbird 128 floor); upstream's manifest still references the old .jsm paths, which no
 *      longer resolve, so the file as published does not load. See docs/decisions/calendar-backend.md.
 *   2. Trimmed to `query` only (list calendars). Upstream also drafts get/create/update/remove/
 *      clear/synchronize and calendar.items (event/task CRUD); those vendor in ODIAA-2306c/d once
 *      the CTO/CEO decision in docs/decisions/calendar-backend.md is approved.
 */

var { ExtensionCommon } = ChromeUtils.importESModule("resource://gre/modules/ExtensionCommon.sys.mjs");
var { cal } = ChromeUtils.importESModule("resource:///modules/calendar/calUtils.sys.mjs");

var { ExtensionAPI } = ExtensionCommon;

this.calendar_calendars = class extends ExtensionAPI {
  getAPI() {
    return {
      calendar: {
        calendars: {
          query: async function ({ type, readOnly, enabled } = {}) {
            const calmgr = cal.getCalendarManager();
            return calmgr
              .getCalendars()
              .filter((calendar) => {
                if (type && calendar.type !== type) return false;
                if (readOnly != null && calendar.readOnly !== readOnly) return false;
                if (enabled != null && !calendar.getProperty("disabled") !== enabled) return false;
                return true;
              })
              .map((calendar) => ({
                id: calendar.id,
                type: calendar.type,
                name: calendar.name,
                url: calendar.uri?.spec,
                readOnly: calendar.readOnly,
                enabled: !calendar.getProperty("disabled"),
                color: calendar.getProperty("color") || null,
              }));
          },
        },
      },
    };
  }
};
