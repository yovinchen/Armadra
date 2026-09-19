/**
 * The staged-update announcement: the tray item and the one notification
 * (design §4.1, last rule). ported from the Rust shell's notify suite,
 * all 5 test functions.
 */
import { expect, it } from "vitest";

import {
  localeFromEnvironment,
  notificationBody,
  notificationTitle,
  restartMenuLabel,
  stagedCleared,
  stagedReady,
  wantsNotification,
  type Locale,
} from "./notify";

const LOCALES: Locale[] = ["zhCn", "en"];

it("the notification is on unless the settings say otherwise", () => {
  expect(
    wantsNotification('{"updates":{"notify":true,"channel":"stable"}}'),
  ).toBe(true);
  expect(wantsNotification('{"updates":{"notify":false}}')).toBe(false);
});

it("an unreadable or silent document still notifies", () => {
  // Every one of these is "nobody said no". Being told twice is recoverable;
  // never learning that a restart is waiting is the failure this exists to
  // prevent, so the default has to be on.
  for (const document of [
    "",
    "not json at all",
    "[]",
    "{}",
    '{"updates":{}}',
    // A value of the wrong type is a broken document, not a choice.
    '{"updates":{"notify":"no"}}',
    '{"updates":{"notify":null}}',
    // A `notify` that belongs to some other section says nothing about updates.
    '{"notify":false}',
  ]) {
    expect(wantsNotification(document), document).toBe(true);
    // The Runtime answers in bytes; both shapes read the same document.
    expect(wantsNotification(Buffer.from(document, "utf8")), document).toBe(
      true,
    );
  }
});

it("both languages have every string", () => {
  for (const locale of LOCALES) {
    expect(restartMenuLabel(locale)).not.toBe("");
    expect(notificationTitle(locale)).not.toBe("");
    expect(notificationBody(locale, "0.2.0")).toContain("0.2.0");
    // A missing version must not render as an empty gap in the sentence.
    const anonymous = notificationBody(locale, "  ");
    expect(anonymous).not.toBe("");
    expect(anonymous).not.toContain("  ");
  }
});

it("the two languages differ", () => {
  // A copied string is how a locale silently stops being translated.
  expect(restartMenuLabel("zhCn")).not.toBe(restartMenuLabel("en"));
  expect(notificationTitle("zhCn")).not.toBe(notificationTitle("en"));
});

it("the announcement round trips as the tray reads it", () => {
  const ready = JSON.parse(JSON.stringify(stagedReady("0.2.0")));
  expect(ready).toEqual(stagedReady("0.2.0"));
  expect(ready.ready).toBe(true);

  // A retraction carries no version: there is nothing staged to name.
  const cleared = JSON.parse(JSON.stringify(stagedCleared()));
  expect(cleared.ready).toBe(false);
  expect(cleared.version).toBe("");
});

/**
 * Not in the Rust suite: the Rust shell read the locale through
 * `usage::Locale::from_environment`, which this port does not have yet (the
 * tray and its locale are W2.1's). The fallback still has to pick a language
 * rather than none.
 */
it("the locale falls back to english for anything that is not chinese", () => {
  expect(localeFromEnvironment({ LANG: "zh_CN.UTF-8" })).toBe("zhCn");
  expect(localeFromEnvironment({ LC_ALL: "zh_TW" })).toBe("zhCn");
  expect(localeFromEnvironment({ LANG: "en_GB.UTF-8" })).toBe("en");
  expect(localeFromEnvironment({})).toBe("en");
  // LC_ALL wins over LANG, as the C library resolves it.
  expect(localeFromEnvironment({ LC_ALL: "en_US", LANG: "zh_CN" })).toBe("en");
});
