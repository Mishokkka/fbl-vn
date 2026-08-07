import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const exists = file => fs.existsSync(path.join(root, file));
const walk = (dir, extension) => {
  const base = path.join(root, dir);
  const out = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const full = path.join(base, entry.name);
    if (entry.isDirectory() && entry.name !== ".git") out.push(...walk(path.relative(root, full), extension));
    else if (!extension || entry.name.endsWith(extension)) out.push(path.relative(root, full).replaceAll("\\", "/"));
  }
  return out;
};

const manifest = JSON.parse(read("module.json"));
for (const file of [...(manifest.styles || []), ...(manifest.scripts || []), ...(manifest.esmodules || []), manifest.readme, "LICENSE"].filter(Boolean)) {
  if (!exists(file)) errors.push(`Manifest references missing file: ${file}`);
}

for (const file of walk("scripts", ".js")) {
  const source = read(file);
  const imports = [...source.matchAll(/(?:from\s+|import\s+)["'](\.[^"']+)["']/g)].map(match => match[1]);
  for (const specifier of imports) {
    let target = path.resolve(root, path.dirname(file), specifier);
    if (!path.extname(target)) target += ".js";
    if (!fs.existsSync(target)) errors.push(`Broken import in ${file}: ${specifier}`);
  }
}

const editorSource = read("scripts/apps/vn-editor-app.js");
const expectedEditorParts = ["resources", "scenes", "frames", "sceneHead", "framePanel", "bottomActions", "empty"];
const partsBlock = editorSource.match(/VNEditorApp\.PARTS\s*=\s*\{([\s\S]*?)\n\};\s*$/m)?.[1] || "";
for (const partId of expectedEditorParts) {
  if (!new RegExp(`^\\s*${partId}:`, "m").test(partsBlock)) errors.push(`Missing editor PARTS entry: ${partId}`);
}
if (/^\s*main:/m.test(partsBlock)) errors.push("Legacy monolithic editor PARTS entry remains: main");
for (const match of partsBlock.matchAll(/templates\/([A-Za-z0-9_-]+\.hbs)/g)) {
  const template = `templates/${match[1]}`;
  if (!exists(template)) errors.push(`Editor PARTS references missing template: ${template}`);
}
if (exists("templates/editor.hbs")) errors.push("Legacy monolithic editor template must not ship: templates/editor.hbs");

const templateActions = new Set();
for (const file of walk("templates", ".hbs")) {
  const source = read(file);
  const openBlocks = (source.match(/{{#/g) || []).length;
  const closeBlocks = (source.match(/{{\//g) || []).length;
  if (openBlocks !== closeBlocks) errors.push(`Unbalanced Handlebars blocks in ${file}: ${openBlocks}/${closeBlocks}`);
  for (const match of source.matchAll(/data-action="([^"]+)"/g)) templateActions.add(match[1]);
}
const actionHandlers = new Set();
for (const file of walk("scripts/apps", ".js")) {
  const source = read(file);
  for (const match of source.matchAll(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(?:queuedEditorAction\()?\s*[A-Za-z0-9_$.]+\)?\s*,?\s*$/gm)) actionHandlers.add(match[1]);
}
for (const action of templateActions) {
  if (!actionHandlers.has(action)) errors.push(`Template action has no handler: ${action}`);
}

const branchActions = new Set();
for (const file of walk("templates", ".hbs")) {
  const source = read(file);
  for (const match of source.matchAll(/data-branch-action="([^"]+)"/g)) branchActions.add(match[1]);
}
const branchDispatch = new Set([...editorSource.matchAll(/action === "([^"]+)"/g)].map(match => match[1]));
for (const action of branchActions) {
  if (!branchDispatch.has(action)) errors.push(`Branch action has no dispatcher: ${action}`);
}
for (const required of ["addBranch", "renameBranch", "duplicateBranch", "deleteBranch"]) {
  if (!branchActions.has(required)) errors.push(`Missing branch panel action: ${required}`);
}
if (manifest.version !== "1.0.4") errors.push(`Unexpected release version: ${manifest.version}`);
if (!read("README.md").startsWith("# FBL Visual Novel Cutscenes 1.0.4")) errors.push("README release heading is out of sync with manifest");
for (const forbidden of [
  "_applyCharacterPreset(event.currentTarget",
  "_applyCharacterPortrait(event.currentTarget",
  "_handleHeaderAction(event))",
  "_onSelectBranch.call(this, event, event.currentTarget"
]) {
  if (editorSource.includes(forbidden)) errors.push(`Queued editor callback still depends on event.currentTarget: ${forbidden}`);
}
const socketSource = read("scripts/playback/vn-socket.js");
if (!/game\.socket\.on\(SOCKET_NAME, \(payload, senderId\) => this\._onMessage\(payload, senderId\)\)/.test(socketSource)) errors.push("Socket listener does not consume Foundry's trusted sender id callback argument");
if (/senderId\s*:\s*game\.user\.id/.test(socketSource)) errors.push("Socket payload still publishes a client-supplied senderId");
if (/clip\s*:\s*rect\(/.test(read("styles/editor-components.css"))) errors.push("Deprecated CSS clip property remains");

function splitSelectors(header) {
  const result = [];
  let buffer = "";
  let depth = 0;
  let quote = "";
  for (const char of header) {
    if (quote) {
      buffer += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      buffer += char;
    }
    else if (char === "(" || char === "[") {
      depth += 1;
      buffer += char;
    }
    else if (char === ")" || char === "]") {
      depth = Math.max(0, depth - 1);
      buffer += char;
    }
    else if (char === "," && depth === 0) {
      if (buffer.trim()) result.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    }
    else buffer += char;
  }
  if (buffer.trim()) result.push(buffer.trim().replace(/\s+/g, " "));
  return result;
}

function matchingBrace(source, openIndex) {
  let depth = 1;
  let quote = "";
  for (let index = openIndex + 1; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== "\\") quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function collectSelectors(source, output) {
  let cursor = 0;
  while (cursor < source.length) {
    const open = source.indexOf("{", cursor);
    if (open < 0) break;
    const header = source.slice(cursor, open).trim();
    const close = matchingBrace(source, open);
    if (close < 0) throw new Error("Unbalanced CSS braces");
    if (header.startsWith("@media") || header.startsWith("@supports") || header.startsWith("@layer") || header.startsWith("@container")) {
      collectSelectors(source.slice(open + 1, close), output);
    }
    else if (header && !header.startsWith("@")) {
      for (const selector of splitSelectors(header)) output.add(selector);
    }
    cursor = close + 1;
  }
}

const selectorOwners = new Map();
let importantCount = 0;
for (const file of walk("styles", ".css")) {
  const source = read(file).replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = new Set();
  try {
    collectSelectors(source, selectors);
  }
  catch (error) {
    errors.push(`${file}: ${error.message}`);
  }
  for (const selector of selectors) {
    if (!selector.includes(".fbl-vn-")) errors.push(`Unscoped CSS selector in ${file}: ${selector}`);
    if (!selectorOwners.has(selector)) selectorOwners.set(selector, new Set());
    selectorOwners.get(selector).add(file);
  }
  const count = (source.match(/!important\b/g) || []).length;
  importantCount += count;
  if (count && file !== "styles/player.css") errors.push(`!important outside fullscreen player: ${file} (${count})`);
  if (source.includes(".fbl-vn-choice-list")) errors.push(`Legacy shared choice-list selector remains in ${file}`);
}
for (const [selector, owners] of selectorOwners) {
  if (owners.size > 1) errors.push(`CSS selector has multiple owner files: ${selector} -> ${[...owners].join(", ")}`);
}
if (importantCount > 9) errors.push(`Unexpected !important growth: ${importantCount}`);

for (const file of walk(".", null)) {
  if (/\.bak$|~$|\.orig$/.test(file)) errors.push(`Backup file must not ship: ${file}`);
}

if (errors.length) {
  console.error(errors.map(error => `ERROR: ${error}`).join("\n"));
  process.exit(1);
}
console.log(`Verified ${manifest.id} ${manifest.version}: ${manifest.styles.length} styles, ${templateActions.size} actions, ${branchActions.size} branch actions, ${selectorOwners.size} owned selectors, ${importantCount} fullscreen overrides.`);
