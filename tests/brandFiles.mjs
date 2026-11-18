// The brand files as the tests read them. A test whose expected text holds a brand value
// (the sender name, a milestone message) takes it from here, so the shared tests pass
// under whichever brand's files are in the tree.

import { readFileSync } from "node:fs";
import vm from "node:vm";

/** apps-script/Brand.js loaded on its own: BRAND.brandSenderName() and the rest. */
export const BRAND = {};
vm.runInNewContext(
  readFileSync(new URL("../apps-script/Brand.js", import.meta.url), "utf8"),
  BRAND,
);

/** A golden's text with each {senderName} filled from the brand. */
export function fillBrand(text) {
  return text.replaceAll("{senderName}", BRAND.brandSenderName());
}
