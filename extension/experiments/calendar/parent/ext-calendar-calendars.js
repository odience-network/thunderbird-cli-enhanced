/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * ODIAA-2327 proof: read-only slice of the `calendar_calendars` Experiment API drafted at
 * https://github.com/thunderbird/webext-experiments/tree/main/calendar
 * (experiments/calendar/parent/ext-calendar-calendars.js, calendar_calendars.query),
 * pinned at commit b7f7cb3e76807903a785a03784d6e7df7b213f21.
 *
 * Adapted, not copied verbatim:
 *   1. Trimmed to `query` only (list calendars). Upstream also drafts get/create/update/remove/
 *      clear/synchronize and calendar.items (event/task CRUD); those vendor in ODIAA-2306c/d once
 *      the CTO/CEO decision in docs/decisions/calendar-backend.md is approved.
 *   Everything else — the `.sys.mjs`/`ChromeUtils.importESModule` imports and `cal.manager`
 *   accessor below — matches upstream `main` as of the pinned commit; comm-central migrated
 *   off `.jsm`/`cal.getCalendarManager()` in 2023, before our Thunderbird 128 floor, so no
 *   porting was needed there.
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
            return cal.manager
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

  // This is currently the only experiment_apis entry in the manifest, so it owns the
  // startup-cache invalidation Thunderbird's Experiments docs require on non-shutdown
  // unload (disable/update/reload) — see
  // https://developer.thunderbird.net/add-ons/mailextensions/experiments.
  onShutdown(isAppShutdown) {
    if (isAppShutdown) return;
    Services.obs.notifyObservers(null, "startupcache-invalidate");
  }
};
