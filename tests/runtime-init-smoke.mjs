import assert from "node:assert/strict";

const readyHooks = new Map();
globalThis.window = {
  innerWidth: 1920,
  innerHeight: 1080,
  addEventListener() {},
  removeEventListener() {}
};
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
globalThis.matchMedia = () => ({ matches: false });
globalThis.foundry = {
  utils: {
    deepClone: value => structuredClone(value),
    randomID: () => Math.random().toString(36).slice(2, 12),
    mergeObject: (target, source) => ({ ...target, ...source })
  },
  applications: {
    api: {
      ApplicationV2: class {
        async render() { return this; }
        async close() { return this; }
      },
      HandlebarsApplicationMixin: Base => class extends Base {}
    },
    apps: {}
  },
  audio: { AudioHelper: {} }
};
const settings = new Map();
const menus = new Map();
globalThis.game = {
  ready: false,
  user: { id: "gm", isGM: true },
  users: [],
  modules: new Map([["fbl-vn-cutscenes", { active: true, version: "1.0.4" }]]),
  settings: {
    settings,
    menus,
    register(moduleId, key, config) { settings.set(`${moduleId}.${key}`, config); },
    registerMenu(moduleId, key, config) { menus.set(`${moduleId}.${key}`, config); },
    get() { return null; }
  },
  i18n: { localize: key => key }
};
globalThis.Hooks = {
  events: { init: [() => {}] },
  once(name, callback) { readyHooks.set(name, callback); },
  on() {},
  callAll() {}
};
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
globalThis.Audio = class {};
globalThis.Image = class {};

const runtime = await import(`../scripts/main.js?runtime-init-smoke=${Date.now()}`);
assert.equal(typeof runtime.bootstrapFblVN, "function");
assert.ok(globalThis.game.fblVN?.__runtime, "Runtime should bootstrap during init without throwing");
assert.ok(readyHooks.has("ready"), "Runtime should defer storage/socket setup until ready");
console.log("Runtime init smoke tests passed.");
