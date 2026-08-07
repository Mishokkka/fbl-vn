import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

globalThis.window = {
  innerWidth: 1920,
  innerHeight: 1080,
  addEventListener() {},
  removeEventListener() {}
};
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(performance.now()), 0);
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
        async _prepareContext() { return {}; }
        async _preparePartContext(_partId, context) { return context; }
        _attachPartListeners() {}
        async render() { return this; }
        async close() { return this; }
      },
      HandlebarsApplicationMixin: Base => class extends Base {}
    },
    apps: {}
  },
  audio: { AudioHelper: {} }
};
const settingValues = new Map();
globalThis.game = {
  user: { id: "gm", isGM: true },
  users: [],
  settings: {
    settings: new Map(),
    register(moduleId, key, config) {
      this.settings.set(`${moduleId}.${key}`, config);
      if (!settingValues.has(`${moduleId}.${key}`)) settingValues.set(`${moduleId}.${key}`, structuredClone(config.default));
    },
    get(moduleId, key) { return settingValues.get(`${moduleId}.${key}`); },
    async set(moduleId, key, value) { settingValues.set(`${moduleId}.${key}`, structuredClone(value)); return value; }
  },
  i18n: { localize: key => key }
};
globalThis.Hooks = { callAll() {} };
globalThis.ui = { notifications: { info() {}, warn() {}, error() {} } };
globalThis.Audio = class {};
globalThis.Image = class {};

const { VNEditorApp } = await import("../scripts/apps/vn-editor-app.js");
const { VNGraphApp } = await import("../scripts/apps/vn-graph-app.js");
const { VNPlayerApp } = await import("../scripts/apps/vn-player-app.js");
const { VNSceneStore } = await import("../scripts/data/scene-store.js");
const { applyChoiceCounterEffect, createFrame, createScene, createSceneCounter, getFrameReferences, resolveFrameNextRouting, validateScene } = await import("../scripts/data/schema.js");
const { migrateData } = await import("../scripts/data/migrations.js");

VNSceneStore.registerSettings();
const scene = createScene();
scene.title = "Smoke";
const branchId = scene.branches[0].id;
scene.frameFolders = [
  { id: "folder-a", name: "A", branchId, parentId: "", sort: 0, collapsed: false, color: "#b68a4a" },
  { id: "folder-b", name: "B", branchId, parentId: "folder-a", sort: 0, collapsed: false, color: "#b68a4a" }
];
scene.frames[0].id = "frame-root";
scene.frames[0].branchId = branchId;
scene.frames[0].folderId = "";
scene.frames[0].sort = 1000;
const nested = createFrame("dialogue");
nested.id = "frame-nested";
nested.branchId = branchId;
nested.folderId = "folder-b";
nested.sort = 0;
scene.frames.push(nested);
scene.startFrame = "frame-root";
await VNSceneStore.setData({ schemaVersion: 6, version: 3, scenes: [scene], assets: [], characters: [] });

const stored = VNSceneStore.getScene(scene.id);
stored.title = "Mutated clone";
assert.equal(VNSceneStore.getScene(scene.id).title, "Smoke", "getScene must return a defensive clone");

const editor = Object.create(VNEditorApp.prototype);
editor.selectedSceneId = scene.id;
editor.selectedFrameId = "frame-root";
editor.selectedBranchId = branchId;
editor.selectedFolderId = null;
editor.editingFolderId = null;
const issues = validateScene(scene);
const index = editor._buildRenderIndex(scene, issues);
const views = editor._buildFrameViews(scene, index.issuesByFrame, branchId);
const rows = editor._buildFrameTreeRows(scene, views);
assert.equal(rows.filter(row => row.isFolder).length, 2);
assert.equal(rows.filter(row => row.isFrame).length, 2);
assert.equal(rows.find(row => row.id === "frame-nested").depth, 2);

const editorState = editor._prepareEditorState();
const scenesContext = editor._buildPartContext("scenes", editorState);
const framesContext = editor._buildPartContext("frames", editorState);
const panelContext = editor._buildPartContext("framePanel", editorState);
assert.equal(scenesContext.scenes.length, 1, "Scenes part must receive scene rows");
assert.equal(framesContext.frameTreeRows.length, 4, "Frames part must receive folder and frame rows");
assert.deepEqual(framesContext.branchOptions.map(option => option.value), [branchId], "Frames part must expose branch selector options");
assert.equal("branches" in framesContext, false, "Unused branch view payload must not return");
assert.equal("branchMoveOptions" in framesContext, false, "Unused branch move payload must not return");
assert.equal(panelContext.selectedTextBlocks.length >= 1, true, "Frame panel must receive text blocks");
assert.deepEqual(Object.keys(VNEditorApp.PARTS), ["resources", "scenes", "frames", "sceneHead", "framePanel", "bottomActions", "empty"]);
let renderOptions = null;
editor.rendered = true;
editor.element = {};
editor.render = async options => { renderOptions = options; return editor; };
await editor._renderEditorParts(["frames", "framePanel", "frames", "unknown"]);
assert.deepEqual(renderOptions, { parts: ["frames", "framePanel"] }, "Partial render must deduplicate and filter part IDs");
editor._markRenderParts(["scenes", "unknown"]);
await editor._renderEditorParts(["frames"]);
assert.deepEqual(renderOptions, { parts: ["frames", "scenes"] }, "Dirty form parts must be merged into the next partial render");

const largeScene = structuredClone(scene);
largeScene.frameFolders = [];
largeScene.frames = [];
for (let i = 0; i < 3000; i += 1) {
  largeScene.frames.push({
    id: `frame-${i}`,
    branchId,
    folderId: "",
    sort: i,
    type: "dialogue",
    title: `Frame ${i}`,
    text: "",
    textBlocks: [],
    choices: []
  });
}
const largeViews = largeScene.frames.map((frame, i) => ({ ...frame, label: frame.title, index: i + 1 }));
const start = performance.now();
const largeRows = editor._buildFrameTreeRows(largeScene, largeViews);
const elapsed = performance.now() - start;
assert.equal(largeRows.length, 3000);
assert.ok(elapsed < 1500, `Tree build took too long: ${elapsed.toFixed(1)}ms`);

const routeCounter = createSceneCounter("Route", 0);
scene.counters.push(routeCounter);
nested.isFinal = false;
nested.nextRouting = {
  enabled: true,
  counterId: routeCounter.id,
  operator: "gte",
  value: 2,
  trueFrameId: "frame-root",
  falseFrameId: ""
};
assert.deepEqual(resolveFrameNextRouting(nested, { [routeCounter.id]: 3 }), { enabled: true, matched: true, frameId: "frame-root" });
assert.deepEqual(resolveFrameNextRouting(nested, { [routeCounter.id]: 1 }), { enabled: true, matched: false, frameId: "" });
const routeIssues = validateScene(scene);
assert.equal(routeIssues.some(issue => issue.code === "frame-routing-missing-frame"), false);
const routeChoice = { effectCounterId: routeCounter.id, effectOperation: "add", effectValue: 2 };
const routedCounterState = applyChoiceCounterEffect(routeChoice, { [routeCounter.id]: 1 });
assert.equal(resolveFrameNextRouting(nested, routedCounterState).frameId, "frame-root", "Choice effects must be usable by conditional next routing");
assert.equal(getFrameReferences(scene, "frame-root").some(ref => ref.type === "counter-true" && ref.frameId === "frame-nested"), true, "Conditional outcomes must be reported as frame references");

const legacyScene = createScene();
const legacyYes = createFrame("dialogue");
legacyYes.id = "legacy-yes";
legacyYes.branchId = legacyScene.branches[0].id;
legacyScene.frames.push(legacyYes);
const legacySource = legacyScene.frames[0];
legacySource.isFinal = true;
legacySource.sceneRouting = {
  enabled: true,
  counterId: "legacy-counter",
  operator: "gte",
  value: 1,
  trueSceneId: "legacy-yes",
  falseSceneId: "scene-outside"
};
const migrated = migrateData({ schemaVersion: 5, version: 3, scenes: [legacyScene], assets: [], characters: [] });
const migratedFrame = migrated.scenes[0].frames[0];
assert.equal(migrated.schemaVersion, 6);
assert.equal(migratedFrame.nextRouting.enabled, true, "Legacy scene routing must become conditional next routing");
assert.equal(migratedFrame.nextRouting.trueFrameId, "legacy-yes", "A legacy target matching a local frame must be preserved");
assert.equal(migratedFrame.nextRouting.falseFrameId, "", "An external scene target cannot be converted to a frame and must be cleared");
assert.equal(migratedFrame.isFinal, false, "Migrated conditional next routing must not remain blocked by the old final flag");
assert.equal("sceneRouting" in migratedFrame, false, "Legacy frame routing field must be removed");


const player = Object.create(VNPlayerApp.prototype);
player.scene = scene;
player.counterState = { [routeCounter.id]: 3 };
player._buildPlaybackIndex();
assert.equal(player._getFrame("frame-root").id, "frame-root");
assert.equal(player._getNextFrameId(scene.frames[0]), "frame-nested");
assert.equal(player._getNextFrameId(nested), "frame-root", "Matched routing must select the configured frame");
player.counterState = { [routeCounter.id]: 1 };
assert.equal(player._getNextFrameId(nested), null, "An empty outcome on the last frame must fall back to sequential end");

const graph = Object.create(VNGraphApp.prototype);
graph.hideLinearFrames = false;
const graphData = graph._buildGraph(scene);
assert.equal(graphData.visibleFrameCount, 2);
assert.ok(graphData.edges.length >= 2);
assert.equal(graphData.edges.some(edge => edge.label === "Если да"), true, "Graph must show the true conditional edge");
assert.equal(graphData.edges.some(edge => edge.label === "Если нет"), true, "Graph must show the false conditional edge");

console.log(`Smoke tests passed. 3000-row tree: ${elapsed.toFixed(1)}ms.`);
