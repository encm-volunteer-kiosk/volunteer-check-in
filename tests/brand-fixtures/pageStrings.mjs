// The text a page source file can put on the screen: its string literals, the text parts
// of backtick strings, and JSX text, read with the TypeScript parser. Class lists, keys,
// paths and other strings with no letter, and lower-case single words, are left out. JSX
// text is read with its entities decoded, as the screen shows it.

import ts from "typescript";

const ENTITIES = { "&apos;": "'", "&quot;": '"', "&amp;": "&", "&lt;": "<", "&gt;": ">" };
const CLASS_LIST = /^[-a-z0-9:[\]#/.%()_!&>*=,'"]+( [-a-z0-9:[\]#/.%()_!&>*=,'"]+)*$/;

/** The screen strings in one src file's text, in source order, whitespace collapsed. */
export function screenStrings(fileName, text) {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, kind);
  const out = [];
  const visit = (node) => {
    let s = null;
    if (ts.isStringTextContainingNode(node)) {
      s = node.text;
    } else if (ts.isJsxText(node)) {
      s = node.text
        .replace(/&(apos|quot|amp|lt|gt);/g, (e) => ENTITIES[e])
        .replace(/\s+/g, " ")
        .trim();
    }
    const words = s !== null && (/\S\s+\S/.test(s) || /^[A-Z][A-Za-z']*[.!?…]?$/.test(s.trim()));
    if (words && /[A-Za-z]/.test(s) && !CLASS_LIST.test(s.trim())) {
      out.push(s);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** True for a page source file whose text can reach the screen. */
export const isPageSource = (path) => /^src\/.*\.(ts|tsx)$/.test(path) && !path.endsWith(".d.ts");
