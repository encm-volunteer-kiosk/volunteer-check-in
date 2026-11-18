// This brand's own values, held to the literal strings the kiosk used before they moved
// into the brand files. A tablet keeps its stored access code, list and save queue only
// while every storage key and Web Lock name stays byte for byte what it was.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { BRAND } from "./brandFiles.mjs";
import { brandKey, BRAND_ORGANIZATION_NAME, BRAND_THANKS_LINE } from "../src/brand.ts";
import { LIST_STORE_KEY } from "../src/listStore.ts";
import { SAVE_QUEUE_KEY, SAVE_QUEUE_LOCK, SAVE_RUNNER_LOCK } from "../src/saveQueue.ts";

const src = new URL("../src/", import.meta.url);

test("the stored names are the ones the live tablet holds", () => {
  assert.equal(LIST_STORE_KEY, "encm-kiosk-volunteer-list");
  assert.equal(SAVE_QUEUE_KEY, "encm-kiosk-save-queue");
  assert.equal(SAVE_QUEUE_LOCK, "encm-kiosk-save-queue");
  assert.equal(SAVE_RUNNER_LOCK, "encm-kiosk-save-runner");
  assert.equal(brandKey("kiosk-access-code"), "encm-kiosk-access-code");
});

test("every storage key and lock name the page makes is one the kiosk used before", () => {
  const before = new Set([
    "encm-kiosk-access-code",
    "encm-kiosk-volunteer-list",
    "encm-kiosk-save-queue",
    "encm-kiosk-save-runner",
    "encm-volunteer-kiosk-v1",
    "encm-fail-next-save",
  ]);
  const made = new Set();
  for (const file of readdirSync(src)) {
    if (!/\.tsx?$/.test(file)) continue;
    const text = readFileSync(new URL(file, src), "utf8");
    for (const m of text.matchAll(/brandKey\("([^"]+)"\)/g)) made.add(brandKey(m[1]));
  }
  assert.deepEqual([...made].sort(), [...before].sort());
});

test("the names and lines shown are the brand's", () => {
  assert.equal(BRAND.brandSenderName(), "ENCM Volunteer Kiosk");
  assert.equal(BRAND.brandOrganizationName(), "East Nashville Care Market");
  assert.equal(BRAND_ORGANIZATION_NAME, "East Nashville Care Market");
  assert.equal(BRAND_THANKS_LINE, "Thanks for showing up for your East Nashville neighbors.");
  assert.equal(
    BRAND.brandMilestoneMessages()["hours-100"],
    "100 hours logged here, making East Nashville stronger.",
  );
});
