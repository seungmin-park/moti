import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../tools/pstack/", import.meta.url);
const source = JSON.parse(await readFile(new URL("source.json", root), "utf8"));
const manifest = JSON.parse(await readFile(new URL("integrity.json", root), "utf8"));
if (source.repository !== "https://github.com/cursor/plugins" || source.path !== "pstack") {
  throw new Error("pstack source must be the user-selected cursor/plugins/pstack");
}
const folders = await readdir(new URL("skills/", root), { withFileTypes: true });
const skills = folders.filter((entry) => entry.isDirectory());
if (skills.length !== source.skillCount || !skills.length) throw new Error("pstack skill count mismatch");
for (const skill of skills) {
  if (!manifest[`skills/${skill.name}/SKILL.md`]) throw new Error(`Missing skill entry: ${skill.name}`);
}
for (const [path, expected] of Object.entries(manifest)) {
  const data = await readFile(new URL(path, root));
  const actual = createHash("sha256").update(data).digest("hex");
  if (actual !== expected) throw new Error(`pstack source changed: ${path}`);
}
console.log(`Verified ${skills.length} original pstack skills and ${Object.keys(manifest).length} upstream files at ${source.commit}.`);
