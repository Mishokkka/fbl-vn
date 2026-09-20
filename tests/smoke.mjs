import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import process from "node:process";

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
const { VNSocket } = await import("../scripts/playback/vn-socket.js");
const { applyChoiceCounterEffect, createFrame, createScene, createSceneCounter, createTextBlock, getFrameReferences, resolveFrameNextRouting, validateScene } = await import("../scripts/data/schema.js");
const { migrateData } = await import("../scripts/data/migrations.js");
const { PLAYER_MODES, TEXT_PRESENTATIONS } = await import("../scripts/utils/constants.js");
const { richTextFromPlainText, richTextToPlainText, sanitizeRichTextHtml } = await import("../scripts/utils/rich-text.js");
const { duplicateData, localize, mergeData, randomId } = await import("../scripts/utils/foundry-helpers.js");

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
assert.equal(nested.textPresentation, TEXT_PRESENTATIONS.BOX, "New frames must use the normal dialogue box by default");
const formattedBlock = createTextBlock("Hello\nworld");
assert.equal(formattedBlock.text, "Hello\nworld", "Rich text blocks must retain a plain-text representation");
assert.equal(formattedBlock.richText, richTextFromPlainText("Hello\nworld"), "Plain text must be migrated into safe rich text");
assert.equal(richTextToPlainText("<b>Hello</b><br>world"), "Hello\nworld", "Rich text plain-text conversion must preserve line breaks");
assert.equal(sanitizeRichTextHtml("<script>alert(1)</script><b>Hello</b>", { fallbackText: "Hello" }).includes("<script"), false, "Rich text sanitizer must never retain script markup");
nested.id = "frame-nested";
nested.branchId = branchId;
nested.folderId = "folder-b";
nested.sort = 0;
scene.frames.push(nested);
scene.startFrame = "frame-root";
await VNSceneStore.setData({ schemaVersion: 7, version: 3, scenes: [scene], assets: [], characters: [] });

const stored = VNSceneStore.getScene(scene.id);
stored.title = "Mutated clone";
assert.equal(VNSceneStore.getScene(scene.id).title, "Smoke", "getScene must return a defensive clone");

await Promise.all([
  VNSceneStore.mutateData(async data => {
    await new Promise(resolve => setTimeout(resolve, 5));
    data.scenes[0].title = "Queued title";
  }),
  VNSceneStore.mutateData(data => {
    data.scenes[0].defaultMode = PLAYER_MODES.VOTE;
  })
]);
const queuedScene = VNSceneStore.getScene(scene.id);
assert.equal(queuedScene.title, "Queued title", "Serialized mutations must preserve the first queued write");
assert.equal(queuedScene.defaultMode, PLAYER_MODES.VOTE, "Serialized mutations must re-read state after the previous write");
await VNSceneStore.setData({ schemaVersion: 7, version: 3, scenes: [scene], assets: [], characters: [] });

const editor = Object.create(VNEditorApp.prototype);
editor._pendingRenderParts = new Set();
editor._actionQueue = Promise.resolve();
editor._renderQueue = Promise.resolve();
editor._lastValidationSnapshot = null;
editor._lastFrameTargetSceneId = null;
editor._lastFrameTargetEntries = null;
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

let activeRenders = 0;
let maxActiveRenders = 0;
editor.render = async options => {
  renderOptions = options;
  activeRenders += 1;
  maxActiveRenders = Math.max(maxActiveRenders, activeRenders);
  await new Promise(resolve => setTimeout(resolve, 5));
  activeRenders -= 1;
  return editor;
};
await Promise.all([
  editor._renderEditorParts(["frames"]),
  editor._renderEditorParts(["framePanel"])
]);
assert.equal(maxActiveRenders, 1, "Editor partial renders must be serialized");
let queuedRenderFinished = false;
editor.render = async () => {
  await new Promise(resolve => setTimeout(resolve, 5));
  queuedRenderFinished = true;
  return editor;
};
await editor._enqueueEditorAction(() => {
  void editor._renderEditorParts(["frames"]);
});
assert.equal(queuedRenderFinished, true, "Editor action queue must wait for render work started by the action");

// DOM event data used by queued editor work must be captured synchronously.
let queuedCharacterOperation = null;
let appliedCharacterId = null;
const characterSelect = {
  value: "character-a",
  addEventListener(type, listener) { if (type === "change") this.listener = listener; }
};
const portraitSelect = {
  value: "portrait-a",
  addEventListener(type, listener) { if (type === "change") this.listener = listener; }
};
editor._enqueueEditorAction = operation => { queuedCharacterOperation = operation; return Promise.resolve(); };
editor._applyCharacterPreset = async characterId => { appliedCharacterId = characterId; };
editor._applyCharacterPortrait = async () => {};
editor._enableCharacterControls({
  querySelector(selector) {
    if (selector === "[data-character-select]") return characterSelect;
    if (selector === "[data-character-portrait-select]") return portraitSelect;
    return null;
  }
});
characterSelect.listener({ currentTarget: characterSelect });
characterSelect.value = "character-b";
await queuedCharacterOperation();
assert.equal(appliedCharacterId, "character-a", "Queued character selection must use the value captured during the change event");

const savedOpenGraph = VNEditorApp._onOpenGraph;
let headerTargetSeen = null;
VNEditorApp._onOpenGraph = async (_event, target) => { headerTargetSeen = target; };
const headerTarget = { dataset: { vnHeaderAction: "graph" } };
const deferredHeaderEvent = { currentTarget: null, preventDefault() {}, stopPropagation() {} };
await editor._handleHeaderAction(deferredHeaderEvent, headerTarget);
assert.equal(headerTargetSeen, headerTarget, "Queued header actions must use the captured button rather than event.currentTarget");
VNEditorApp._onOpenGraph = savedOpenGraph;

const unsavedPresetScene = structuredClone(scene);
unsavedPresetScene.frames[0].speaker = "";
let invalidPresetRenders = 0;
const presetEditor = Object.create(VNEditorApp.prototype);
presetEditor.selectedFrameId = unsavedPresetScene.frames[0].id;
presetEditor._commitFromForm = async () => unsavedPresetScene;
presetEditor._renderEditorParts = () => { invalidPresetRenders += 1; };
await VNEditorApp._onSaveCharacterPreset.call(presetEditor, { preventDefault() {} }, {});
assert.equal(invalidPresetRenders, 0, "Invalid character preset save must not re-render away pending form edits");

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
let largeRows;
let elapsed = null;
if (process.env.FBL_VN_PERF_CHECK === "1") {
  const start = performance.now();
  largeRows = editor._buildFrameTreeRows(largeScene, largeViews);
  elapsed = performance.now() - start;
  assert.ok(elapsed < 1500, `Tree build took too long: ${elapsed.toFixed(1)}ms`);
}
else largeRows = editor._buildFrameTreeRows(largeScene, largeViews);
assert.equal(largeRows.length, 3000);

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
  trueSceneId: "legacy-scene-yes",
  falseSceneId: "legacy-scene-no"
};
const migrated = migrateData({ schemaVersion: 5, version: 3, scenes: [legacyScene], assets: [], characters: [] });
const migratedFrame = migrated.scenes[0].frames[0];
assert.equal(migrated.schemaVersion, 7);
assert.equal(migratedFrame.nextRouting.enabled, false, "Legacy scene-to-scene routing cannot be converted into frame routing and must be disabled");
assert.equal(migratedFrame.nextRouting.trueFrameId, "", "Legacy scene ids must not be mistaken for frame ids");
assert.equal(migratedFrame.nextRouting.falseFrameId, "", "Legacy scene ids must not be mistaken for frame ids");
assert.equal(migratedFrame.isFinal, true, "Unconvertible legacy exit routing must preserve the terminal frame");
assert.equal("sceneRouting" in migratedFrame, false, "Legacy frame routing field must be removed");
assert.equal(migratedFrame.textPresentation, TEXT_PRESENTATIONS.BOX, "Legacy frames must migrate to normal box presentation");
assert.equal(typeof migratedFrame.textBlocks[0].richText, "string", "Legacy text blocks must gain rich text storage");

const legacyFrameScene = createScene();
const legacyFrameTarget = createFrame("dialogue");
legacyFrameTarget.id = "legacy-frame-target";
legacyFrameTarget.branchId = legacyFrameScene.branches[0].id;
legacyFrameScene.frames.push(legacyFrameTarget);
legacyFrameScene.frames[0].isFinal = true;
legacyFrameScene.frames[0].sceneRouting = {
  enabled: true,
  counterId: "legacy-counter",
  operator: "gte",
  value: 1,
  trueFrameId: "legacy-frame-target",
  falseFrameId: ""
};
const migratedFrameRoute = migrateData({ schemaVersion: 5, version: 3, scenes: [legacyFrameScene], assets: [], characters: [] }).scenes[0].frames[0];
assert.equal(migratedFrameRoute.nextRouting.enabled, true, "Already frame-addressed legacy routing should survive migration");
assert.equal(migratedFrameRoute.nextRouting.trueFrameId, "legacy-frame-target");
assert.equal(migratedFrameRoute.isFinal, false, "Valid migrated frame routing must be allowed to continue playback");

const invalidVersionMigrated = migrateData({ schemaVersion: "v5", version: 3, scenes: [{ id: "bad-version", frames: [], frameFolders: [] }], assets: [], characters: [] });
assert.equal(invalidVersionMigrated.schemaVersion, 7, "Invalid schemaVersion values must flow through migrations");
assert.equal(Array.isArray(invalidVersionMigrated.scenes[0].branches), true, "Baseline migrations must initialize branch data for invalid schemaVersion input");


const player = Object.create(VNPlayerApp.prototype);
player.scene = scene;
player.counterState = { [routeCounter.id]: 3 };
player._buildPlaybackIndex();
assert.equal(player._getFrame("frame-root").id, "frame-root");
assert.equal(player._getNextFrameId(scene.frames[0]), "frame-nested");
assert.equal(player._getNextFrameId(nested), "frame-root", "Matched routing must select the configured frame");
player.counterState = { [routeCounter.id]: 1 };
assert.equal(player._getNextFrameId(nested), null, "An empty outcome on the last frame must fall back to sequential end");

const closePolicyPlayer = Object.create(VNPlayerApp.prototype);
const savedCurrentUser = game.user;
const closePolicyUser = { id: "player-close", isGM: false };
game.user = closePolicyUser;
closePolicyPlayer.leaderId = "gm-close";
closePolicyPlayer.mode = PLAYER_MODES.INDIVIDUAL;
assert.equal(closePolicyPlayer._canCloseLocally(), true, "A non-leader player must be able to exit a shared INDIVIDUAL cutscene locally");
closePolicyPlayer.mode = PLAYER_MODES.GM;
assert.equal(closePolicyPlayer._canCloseLocally(), false, "A non-leader player must not gain the synchronized GM close authority");
closePolicyPlayer.leaderId = closePolicyUser.id;
assert.equal(closePolicyPlayer._canCloseLocally(), true, "The session leader must retain the close affordance");
game.user = savedCurrentUser;

const graph = Object.create(VNGraphApp.prototype);
graph.hideLinearFrames = false;
const graphData = graph._buildGraph(scene);
assert.equal(graphData.visibleFrameCount, 2);
assert.ok(graphData.edges.length >= 2);
assert.equal(graphData.edges.some(edge => edge.label === "Если да"), true, "Graph must show the true conditional edge");
assert.equal(graphData.edges.some(edge => edge.label === "Если нет"), true, "Graph must show the false conditional edge");
const cycleFrames = [{ id: "cycle-a" }, { id: "cycle-b" }];
const cycleOutgoing = new Map([
  ["cycle-a", [{ targetId: "cycle-b" }]],
  ["cycle-b", [{ targetId: "cycle-a" }]]
]);
const cycleLevels = graph._calculateLevels({ startFrame: "cycle-a" }, cycleFrames, cycleOutgoing);
assert.equal(cycleLevels.get("cycle-a"), 0, "Graph cycle start must keep level zero");
assert.equal(cycleLevels.get("cycle-b"), 1, "Graph cycle traversal must terminate and assign each reachable node once");
const largeCycleFrames = Array.from({ length: 3000 }, (_, index) => ({ id: `cycle-${index}` }));
const largeCycleOutgoing = new Map(largeCycleFrames.map((frame, index) => [
  frame.id,
  [{ targetId: largeCycleFrames[(index + 1) % largeCycleFrames.length].id }]
]));
const largeCycleLevels = graph._calculateLevels({ startFrame: "cycle-0" }, largeCycleFrames, largeCycleOutgoing);
assert.equal(largeCycleLevels.size, 3000, "Large cyclic graphs must visit every reachable frame exactly once");
assert.equal(largeCycleLevels.get("cycle-2999"), 2999, "Large cyclic graph levels must remain deterministic");

// Branch-local sequential routing must not depend on global frame interleaving.
const interleaved = createScene();
const branchA = interleaved.branches[0];
branchA.id = "branch-a";
const branchB = { id: "branch-b", name: "B", sort: 1000 };
interleaved.branches.push(branchB);
const a1 = interleaved.frames[0];
a1.id = "a1";
a1.branchId = branchA.id;
a1.isFinal = false;
a1.next = "";
const b1 = createFrame("dialogue");
b1.id = "b1"; b1.branchId = branchB.id; b1.isFinal = false;
const a2 = createFrame("dialogue");
a2.id = "a2"; a2.branchId = branchA.id; a2.isFinal = true;
const b2 = createFrame("dialogue");
b2.id = "b2"; b2.branchId = branchB.id; b2.isFinal = true;
interleaved.frames = [a1, b1, a2, b2];
interleaved.startFrame = a1.id;
const interleavedIssues = validateScene(interleaved);
assert.equal(interleavedIssues.some(issue => issue.code === "terminal-frame" && issue.frameId === a1.id), false, "A non-terminal frame must find the next frame inside its own branch");
assert.equal(interleavedIssues.some(issue => issue.code === "terminal-frame" && issue.frameId === b1.id), false, "Interleaved branch frames must use branch-local sequential routing");

// GM-command authorization is checked against the sender id carried by the socket envelope.
const gm1 = { id: "gm-1", isGM: true, active: true };
const gm2 = { id: "gm-2", isGM: true, active: true };
const playerUser = { id: "player-1", isGM: false, active: true };
const users = [gm1, gm2, playerUser];
users.get = id => users.find(user => user.id === id);
users.activeGM = gm1;
game.users = users;
game.user = gm1;
VNSocket.activeLeaders.clear();
VNSocket.activeLeaders.set("scene-auth", gm1.id);
assert.equal(VNSocket._isTrustedGmCommand("advance", { sceneId: "scene-auth" }, gm1.id), true);
assert.equal(VNSocket._isTrustedGmCommand("advance", { sceneId: "scene-auth" }, gm2.id), false, "A second active GM must not take over an active session");
assert.equal(VNSocket._isTrustedGmCommand("open", { sceneId: "scene-new" }, playerUser.id), false, "A normal player must not pass the GM-command guard under their real user id");
assert.equal(VNSceneStore._isStorageAuthority(), true, "Foundry activeGM should own private storage initialization");
game.user = gm2;
assert.equal(VNSceneStore._isStorageAuthority(), false, "A second GM must not race private storage creation");
game.user = gm1;

// Concurrent storage initialization must share a single in-flight operation.
const savedReady = game.ready;
const savedJournal = game.journal;
const savedInitializeStorageInner = VNSceneStore._initializeStorageInner;
game.ready = true;
game.journal = {};
VNSceneStore._storageReady = false;
VNSceneStore._storageDocument = null;
VNSceneStore._storageInitPromise = null;
let storageInitCalls = 0;
const storageDocument = { id: "storage-test" };
VNSceneStore._initializeStorageInner = async () => {
  storageInitCalls += 1;
  await new Promise(resolve => setTimeout(resolve, 5));
  return storageDocument;
};
const [storageA, storageB] = await Promise.all([VNSceneStore.initializeStorage(), VNSceneStore.initializeStorage()]);
assert.equal(storageInitCalls, 1, "Concurrent storage initialization must execute only once");
assert.equal(storageA, storageDocument);
assert.equal(storageB, storageDocument);
VNSceneStore._initializeStorageInner = savedInitializeStorageInner;
VNSceneStore._storageInitPromise = null;
VNSceneStore._storageReady = false;
VNSceneStore._storageDocument = null;
game.ready = savedReady;
game.journal = savedJournal;

// Privileged socket commands must use the sender id from the module envelope.
let trustedAdvanceCalls = 0;
VNSocket.handlers = { advance: () => { trustedAdvanceCalls += 1; } };
VNSocket.activeLeaders.clear();
VNSocket.activeLeaders.set("scene-auth", gm1.id);
game.user = gm2;
VNSocket._onMessage({ type: "advance", senderId: playerUser.id, data: { sceneId: "scene-auth" } });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(trustedAdvanceCalls, 0, "A non-GM envelope sender id must not authorize a GM command");
VNSocket._onMessage({ type: "advance", senderId: gm1.id, data: { sceneId: "scene-auth" } });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(trustedAdvanceCalls, 1, "The active GM envelope sender id must authorize the leader command");
game.user = gm1;

const votePlayer = Object.create(VNPlayerApp.prototype);
votePlayer.scene = scene;
votePlayer.mode = PLAYER_MODES.VOTE;
votePlayer.leaderId = gm1.id;
votePlayer.participantIds = [gm1.id];
votePlayer.currentFrameId = "frame-root";
votePlayer.currentTextIndex = 0;
votePlayer.started = true;
votePlayer.counterState = {};
votePlayer._localVote = null;
votePlayer._voteState = null;
votePlayer.element = {
  querySelectorAll() { return []; },
  querySelector() { return null; }
};
votePlayer._buildPlaybackIndex();
let voteRenders = 0;
votePlayer.render = async () => { voteRenders += 1; return votePlayer; };
votePlayer._applyVoteState({ sceneId: scene.id, frameId: "frame-root", textIndex: 0, voters: [gm1.id], choices: {}, total: 1 });
assert.equal(voteRenders, 0, "Vote-state synchronization must patch the DOM without requesting a full player render");

const savedFoundry = globalThis.foundry;
const savedGame = globalThis.game;
const savedUi = globalThis.ui;
globalThis.foundry = undefined;
globalThis.game = undefined;
globalThis.ui = undefined;
assert.match(randomId("fallback"), /^fallback-/, "randomId must retain a non-Foundry fallback");
assert.deepEqual(duplicateData({ a: 1 }), { a: 1 }, "duplicateData must work without Foundry globals");
assert.deepEqual(mergeData({ a: 1 }, { b: 2 }), { a: 1, b: 2 }, "mergeData must work without Foundry globals");
assert.equal(localize("TEST.KEY"), "TEST.KEY", "localize must fall back to the key without Foundry globals");
globalThis.foundry = savedFoundry;
globalThis.game = savedGame;
globalThis.ui = savedUi;

console.log(elapsed === null ? "Smoke tests passed." : `Smoke tests passed. 3000-row tree performance check: ${elapsed.toFixed(1)}ms.`);
