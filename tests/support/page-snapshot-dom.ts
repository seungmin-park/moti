import { parseDocument } from "htmlparser2";
import { PAGE_SNAPSHOT_SCRIPT } from "../../src/features/share/shortcut/page-snapshot-script";

// No DOM library is installed, so this is the smallest document the Safari Shortcut's script needs:
// getElementsByTagName, getAttribute, textContent, document.title and location.href, over htmlparser2's tree
// (attribute names lowercased, as in an HTML document).
type Node = { type: string; name?: string; attribs?: Record<string, string>; children?: Node[]; data?: string };

function textOf(node: Node): string {
  return node.type === "text" ? node.data ?? "" : (node.children ?? []).map(textOf).join("");
}

function elementsOf(node: Node, tag: string, found: Node[] = []): Node[] {
  for (const child of node.children ?? []) {
    if (child.name === tag) found.push(child);
    elementsOf(child, tag, found);
  }
  return found;
}

export function pageDocument(html: string) {
  const root = parseDocument(html) as unknown as Node;
  const element = (node: Node) => ({
    getAttribute: (name: string) => node.attribs?.[name.toLowerCase()] ?? null,
    get textContent() { return textOf(node); },
  });
  const title = elementsOf(root, "title")[0];
  return {
    title: title ? textOf(title).replace(/\s+/g, " ").trim() : "",
    getElementsByTagName: (tag: string) => elementsOf(root, tag.toLowerCase()).map(element),
  };
}

// Runs the script the way the Shortcut does: as a function body that must call completion once.
export function runPageSnapshotScript(document: unknown, href: string): unknown[] {
  const results: unknown[] = [];
  new Function("document", "location", "completion", PAGE_SNAPSHOT_SCRIPT)(document, { href }, (value: unknown) => results.push(value));
  return results;
}

// The JavaScript result the Shortcut sends as `page`: JSON text.
export function snapshotTextOf(html: string, href: string): string {
  const results = runPageSnapshotScript(pageDocument(html), href);
  if (results.length !== 1 || typeof results[0] !== "string") throw new Error("스크립트가 글 하나로 끝나지 않았습니다.");
  return results[0];
}
