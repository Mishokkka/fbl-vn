import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const bootSource = fs.readFileSync(new URL("../scripts/boot.js", import.meta.url), "utf8");
const hooks = new Map();
const moduleRecord = { active: true, version: "1.0.3" };
const context = {
  URL,
  console: { log() {}, error() {}, warn() {} },
  document: {
    currentScript: {
      src: "https://example.test/foundry-prefix/modules/fbl-vn-cutscenes/scripts/boot.js"
    }
  },
  location: { origin: "https://example.test" },
  game: {
    fblVN: null,
    modules: new Map([["fbl-vn-cutscenes", moduleRecord]])
  },
  Hooks: {
    once(name, callback) { hooks.set(name, callback); }
  },
  ui: { notifications: { error() {} } }
};
context.globalThis = context;
vm.runInNewContext(bootSource, context, { filename: "scripts/boot.js" });

assert.ok(context.game.fblVN, "Boot must install the public API stub synchronously");
context.document.currentScript = null;
const diagnostics = context.game.fblVN.diagnostics();
assert.equal(
  diagnostics.bootScript,
  "https://example.test/foundry-prefix/modules/fbl-vn-cutscenes/scripts/boot.js",
  "Boot diagnostics must retain currentScript.src after synchronous execution"
);
assert.equal(
  diagnostics.runtimeUrl,
  "https://example.test/foundry-prefix/modules/fbl-vn-cutscenes/scripts/main.js",
  "Runtime URL must preserve a Foundry routePrefix"
);
assert.equal(hooks.has("init"), true);
assert.equal(hooks.has("ready"), true);

console.log("Boot smoke tests passed.");
