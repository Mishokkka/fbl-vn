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
globalThis.Audio = class {
  constructor(src = "") {
    this.src = src;
    this.paused = true;
    this.currentTime = 0;
    this.loop = false;
    this.volume = 1;
    this._listeners = new Map();
  }
  addEventListener(type, listener) { this._listeners.set(type, listener); }
  removeEventListener(type, listener) {
    if (this._listeners.get(type) === listener) this._listeners.delete(type);
  }
  async play() { this.paused = false; }
  pause() { this.paused = true; }
  load() {}
  emit(type) { this._listeners.get(type)?.(); }
};
globalThis.Image = class {};

const { VNCharacterManagerApp } = await import("../scripts/apps/vn-character-manager-app.js");
const { VNCounterManagerApp } = await import("../scripts/apps/vn-counter-manager-app.js");
const { VNEditorApp } = await import("../scripts/apps/vn-editor-app.js");
const { VNGraphApp } = await import("../scripts/apps/vn-graph-app.js");
const { VNPlayerApp } = await import("../scripts/apps/vn-player-app.js");
const { VNSceneStore } = await import("../scripts/data/scene-store.js");
const { VNSocket } = await import("../scripts/playback/vn-socket.js");
const { VNAudioController } = await import("../scripts/playback/vn-audio.js");
const { VNPreloadController, VNPreloader } = await import("../scripts/playback/vn-preloader.js");
const { applyChoiceCounterEffect, applyFrameCounterEffect, collectAssetPaths, collectFrameAssetPaths, collectFrameEntryAssetPaths, createAudioCue, createCharacterPreset, createFrame, createFrameCharacter, createScene, createSceneCounter, createTextBlock, getFrameReferences, resolveFrameNextRouting, sanitizeFrame, validateScene } = await import("../scripts/data/schema.js");
const { migrateData } = await import("../scripts/data/migrations.js");
const { AUDIO_ACTIONS, COUNTER_EFFECTS, PLAYER_MODES, TEXT_PRESENTATIONS, VIGNETTE_MODES } = await import("../scripts/utils/constants.js");
const { richTextFromPlainText, richTextToPlainText, sanitizeRichTextHtml, splitTextGraphemes } = await import("../scripts/utils/rich-text.js");
const { duplicateData, localize, mergeData, randomId } = await import("../scripts/utils/foundry-helpers.js");

VNSceneStore.registerSettings();

const characterManager = new VNCharacterManagerApp();
assert.equal(characterManager.expandedCharacterIds.size, 0, "Character presets must be collapsed when the manager first opens");
characterManager.element = {
  querySelectorAll(selector) {
    assert.equal(selector, "details[data-character-row][open]");
    return [
      { dataset: { characterId: "character-a" } },
      { dataset: { characterId: "character-b" } }
    ];
  }
};
characterManager._captureExpandedCharacters();
assert.deepEqual([...characterManager.expandedCharacterIds], ["character-a", "character-b"], "Expanded character cards must be captured before a manager rerender");

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
scene.frames[0].musicCues = [
  createAudioCue("music", { channel: "music-1", src: "music-a.ogg", loop: true }),
  createAudioCue("music", { channel: "music-2", src: "music-b.ogg", loop: true })
];
scene.frames[0].sfxCues = [
  createAudioCue("sfx", { channel: "wind", src: "wind.ogg", loop: true })
];
assert.deepEqual(new Set(collectAssetPaths(scene)), new Set(["music-a.ogg", "music-b.ogg", "wind.ogg"]), "Preload collection must include every playable audio cue");
const nested = createFrame("dialogue");
assert.equal(nested.textPresentation, TEXT_PRESENTATIONS.BOX, "New frames must use the normal dialogue box by default");
assert.equal(nested.portraitPosition, "left", "New frames must default portraits to the left");
assert.equal(nested.vignetteMode, VIGNETTE_MODES.NONE, "New frames must disable the vignette by default");
assert.equal(nested.transition, "none", "New frames must disable visual transitions by default");
assert.equal(nested.showSpeakerName, true, "New frames must show the primary character name by default");
assert.deepEqual(nested.additionalCharacters, [], "New frames must start with no additional characters");
assert.equal(nested.effectCounterId, "", "New frames must not change a counter by default");
assert.equal(nested.effectOperation, COUNTER_EFFECTS.NONE, "New frames must disable frame counter effects by default");
assert.equal(nested.effectValue, 0, "New frame counter effects must start at zero");
const extraCharacter = createFrameCharacter({ name: "Companion", portrait: "companion.png", portraitPosition: "right" });
assert.equal(extraCharacter.showName, true, "Additional frame characters must show their names by default");
scene.frames[0].additionalCharacters.push(extraCharacter);
assert.equal(collectAssetPaths({ frames: [scene.frames[0]] }).includes("companion.png"), true, "Additional character portraits must be preloaded");
assert.equal(createCharacterPreset("Left default").defaultPosition, "left", "New character presets must default to the left");
const invalidPositionFrame = sanitizeFrame({ ...nested, portraitPosition: "diagonal", vignetteMode: "invalid", transition: "legacy" });
assert.equal(invalidPositionFrame.portraitPosition, "left", "Invalid portrait positions must sanitize to left");
assert.equal(invalidPositionFrame.vignetteMode, VIGNETTE_MODES.NONE, "Invalid vignette modes must sanitize to none");
assert.equal(invalidPositionFrame.transition, "none", "Unsupported transition values must sanitize to none");
const formattedBlock = createTextBlock("Hello\nworld");
assert.equal(formattedBlock.text, "Hello\nworld", "Rich text blocks must retain a plain-text representation");
assert.equal(formattedBlock.richText, richTextFromPlainText("Hello\nworld"), "Plain text must be migrated into safe rich text");
assert.equal(richTextToPlainText("<b>Hello</b><br>world"), "Hello\nworld", "Rich text plain-text conversion must preserve line breaks");
const cursedSample = "A\u0301\u0323B\u0334\u035C";
assert.deepEqual(splitTextGraphemes(cursedSample), ["A\u0301\u0323", "B\u0334\u035C"], "Typewriter grapheme segmentation must keep combining cursed-text marks attached to their visible letters");
assert.equal(sanitizeRichTextHtml("<script>alert(1)</script><b>Hello</b>", { fallbackText: "Hello" }).includes("<script"), false, "Rich text sanitizer must never retain script markup");
nested.id = "frame-nested";
nested.branchId = branchId;
nested.folderId = "folder-b";
nested.sort = 0;
scene.frames.push(nested);
scene.startFrame = "frame-root";

const preloadScene = createScene();
const preloadRoot = preloadScene.frames[0];
preloadRoot.id = "preload-root";
preloadRoot.background = "preload-root.webp";
preloadRoot.textBlocks[0].voice = "preload-root.ogg";
preloadRoot.isFinal = false;
const preloadA = createFrame("dialogue");
preloadA.id = "preload-a";
preloadA.branchId = preloadRoot.branchId;
preloadA.background = "preload-a.webp";
preloadA.musicCues = [createAudioCue("music", { channel: "score", src: "preload-a.ogg", loop: true })];
preloadA.next = "preload-deep";
const preloadB = createFrame("choice");
preloadB.id = "preload-b";
preloadB.branchId = preloadRoot.branchId;
preloadB.background = "preload-b.webp";
preloadB.choices = [{ id: "preload-choice", text: "Branch", next: "preload-choice-target" }];
const preloadDeep = createFrame("dialogue");
preloadDeep.id = "preload-deep";
preloadDeep.branchId = preloadRoot.branchId;
preloadDeep.background = "preload-deep.webp";
preloadDeep.next = "preload-beyond";
const preloadChoiceTarget = createFrame("dialogue");
preloadChoiceTarget.id = "preload-choice-target";
preloadChoiceTarget.branchId = preloadRoot.branchId;
preloadChoiceTarget.background = "preload-choice.webp";
const preloadBeyond = createFrame("dialogue");
preloadBeyond.id = "preload-beyond";
preloadBeyond.branchId = preloadRoot.branchId;
preloadBeyond.background = "preload-beyond.webp";
preloadBeyond.textBlocks[0].voice = "preload-beyond.ogg";
preloadRoot.nextRouting = {
  enabled: true,
  counterId: "preload-counter",
  operator: "gte",
  value: 1,
  trueFrameId: preloadA.id,
  falseFrameId: preloadB.id
};
preloadScene.frames = [preloadRoot, preloadA, preloadB, preloadDeep, preloadChoiceTarget, preloadBeyond];
preloadScene.startFrame = preloadRoot.id;

assert.deepEqual(
  VNPreloader.collectWindowFrameIds(preloadScene, preloadRoot.id, { depth: 2, maxFrames: 12 }),
  ["preload-root", "preload-a", "preload-b", "preload-deep", "preload-choice-target"],
  "Startup preload must walk nearby direct, conditional, and choice branches without loading the whole scene"
);
assert.deepEqual(
  VNPreloader.collectWindowFrameIds(preloadScene, preloadRoot.id, { depth: 2, maxFrames: 3 }),
  ["preload-root", "preload-a", "preload-b"],
  "Startup preload must cap pathological branch fan-out"
);
const startupPaths = VNPreloader.collectWindowPaths(preloadScene, preloadRoot.id, { depth: 2, maxFrames: 12 });
assert.equal(startupPaths.includes("preload-root.webp"), true);
assert.equal(startupPaths.includes("preload-root.ogg"), true, "Startup window must include audio for immediately reachable frames");
assert.equal(startupPaths.includes("preload-choice.webp"), true, "Startup window must include assets behind nearby choices");
assert.equal(startupPaths.includes("preload-beyond.webp"), false, "Startup window must not block on distant frame images");
assert.equal(startupPaths.includes("preload-beyond.ogg"), false, "Startup window must not block on distant audio");
assert.deepEqual(collectFrameAssetPaths(preloadRoot).sort(), ["preload-root.ogg", "preload-root.webp"]);
const voicedFrame = createFrame("dialogue");
voicedFrame.background = "voiced.webp";
voicedFrame.textBlocks = [
  createTextBlock("One"),
  createTextBlock("Two"),
  createTextBlock("Three")
];
voicedFrame.textBlocks[0].voice = "voice-1.ogg";
voicedFrame.textBlocks[1].voice = "voice-2.ogg";
voicedFrame.textBlocks[2].voice = "voice-3.ogg";
assert.deepEqual(
  collectFrameEntryAssetPaths(voicedFrame, 1).sort(),
  ["voice-2.ogg", "voiced.webp"],
  "Critical frame entry preload must wait only for the requested text block voice rather than every long voice in the frame"
);
const startupVoiceScene = createScene();
startupVoiceScene.frames = [voicedFrame];
startupVoiceScene.startFrame = voicedFrame.id;
const startupVoicePaths = VNPreloader.collectStartupWindowPaths(startupVoiceScene, voicedFrame.id, { depth: 2, maxFrames: 12 });
assert.equal(startupVoicePaths.includes("voice-1.ogg"), true, "Startup preload must include the first immediately playable voice");
assert.equal(startupVoicePaths.includes("voice-2.ogg"), false, "Startup preload must not block on later voices from the same frame");
assert.equal(startupVoicePaths.includes("voice-3.ogg"), false, "Startup preload must not block on all long voices from the same frame");
const voicedNext = createFrame("dialogue");
voicedNext.id = "voiced-next";
voicedNext.branchId = voicedFrame.branchId;
voicedNext.textBlocks = [createTextBlock("Next one"), createTextBlock("Next two")];
voicedNext.textBlocks[0].voice = "next-voice-1.ogg";
voicedNext.textBlocks[1].voice = "next-voice-2.ogg";
voicedFrame.isFinal = false;
voicedFrame.next = voicedNext.id;
startupVoiceScene.frames.push(voicedNext);
const backgroundImages = VNPreloader.collectBackgroundImagePaths(preloadScene);
assert.equal(backgroundImages.includes("preload-beyond.webp"), true, "Distant images must be eligible for low-priority background preload");
assert.equal(backgroundImages.some(path => path.endsWith(".ogg")), false, "Long-form audio must not be swept into the whole-scene background preload");

const savedPreloadPath = VNPreloader.preloadPath;
const preloadCalls = [];
VNPreloader.preloadPath = async path => { preloadCalls.push(path); };
const preloadController = new VNPreloadController(preloadScene);
await Promise.all([
  preloadController.ensurePaths(["preload-root.webp", "preload-a.webp"], { concurrency: 2 }),
  preloadController.ensurePaths(["preload-a.webp", "preload-b.webp"], { concurrency: 2 })
]);
assert.equal(preloadCalls.filter(path => path === "preload-a.webp").length, 1, "Concurrent priority preloads must share one in-flight request per asset");
const backgroundController = new VNPreloadController(preloadScene);
preloadCalls.length = 0;
await backgroundController.startBackgroundImages();
assert.equal(preloadCalls.includes("preload-beyond.webp"), true, "Background preload must eventually warm distant images");
assert.equal(preloadCalls.some(path => path.endsWith(".ogg")), false, "Background preload must leave distant audio for nearby-frame warming");
preloadCalls.length = 0;
const voiceWarmController = new VNPreloadController(startupVoiceScene);
await voiceWarmController.warmWindow(voicedFrame.id, { depth: 2, maxFrames: 12, concurrency: 4 });
assert.equal(preloadCalls.includes("voice-1.ogg"), true, "Nearby warming must include the current frame's first voice");
assert.equal(preloadCalls.includes("voice-2.ogg"), true, "Nearby warming must fill later voices for the current frame in the background");
assert.equal(preloadCalls.includes("voice-3.ogg"), true, "Nearby warming must fill all remaining voices for the current frame in the background");
assert.equal(preloadCalls.includes("next-voice-1.ogg"), true, "Nearby warming must include the entry voice of an upcoming frame");
assert.equal(preloadCalls.includes("next-voice-2.ogg"), false, "Nearby warming must not sweep every long voice from future frames");

let transientAttempts = 0;
VNPreloader.preloadPath = async path => {
  if (path !== "transient.webp") return path;
  transientAttempts += 1;
  if (transientAttempts === 1) throw new Error("transient");
  return path;
};
const transientController = new VNPreloadController(preloadScene);
const transientFirst = await transientController.ensurePaths(["transient.webp"]);
const transientSecond = await transientController.ensurePaths(["transient.webp"]);
assert.equal(transientFirst[0].ok, false, "A transient preload failure must be reported to the caller");
assert.equal(transientSecond[0].ok, true, "A later preload request must retry an asset that previously failed");
assert.equal(transientAttempts, 2, "Failed preload results must not be cached permanently");

let criticalAttempts = 0;
VNPreloader.preloadPath = async path => {
  criticalAttempts += 1;
  if (criticalAttempts === 1) throw new Error("critical transient");
  return path;
};
const criticalPlayer = Object.create(VNPlayerApp.prototype);
criticalPlayer._disposed = false;
criticalPlayer._preloader = new VNPreloadController(preloadScene);
const criticalResults = await criticalPlayer._ensureFrameAssets({ background: "critical.webp", textBlocks: [], musicCues: [], sfxCues: [], additionalCharacters: [] });
assert.equal(criticalResults[0].ok, true, "Critical frame assets must receive one immediate retry before the transition proceeds");
assert.equal(criticalAttempts, 2, "Critical frame preload must retry a transient failure exactly once");
VNPreloader.preloadPath = savedPreloadPath;

await VNSceneStore.setData({ schemaVersion: 11, version: 3, scenes: [scene], assets: [], characters: [] });

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
await VNSceneStore.setData({ schemaVersion: 11, version: 3, scenes: [scene], assets: [], characters: [] });

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
assert.equal(typeof panelContext.selectedTextBlocks[0].richText, "string", "Frame panel text blocks must expose rich text");
assert.equal(panelContext.textPresentationOptions.some(option => option.value === TEXT_PRESENTATIONS.CENTER), true, "Frame panel must offer centered text presentation");
assert.equal(panelContext.additionalFrameCharacters.length, 1, "Frame panel must expose additional characters for editing");
assert.equal(panelContext.additionalFrameCharacters[0].portraitInputName.includes(extraCharacter.id), true, "Additional character portrait fields must have stable unique names");
assert.equal(panelContext.frameEffectCounterOptions.some(option => option.value === ""), true, "Frame panel must expose an empty frame-effect counter option");
assert.equal(panelContext.frameEffectOperationOptions.some(option => option.value === COUNTER_EFFECTS.ADD), true, "Frame panel must expose frame counter effect operations");
assert.deepEqual(panelContext.vignetteOptions.map(option => option.value), [VIGNETTE_MODES.AUTO, VIGNETTE_MODES.SCREEN, VIGNETTE_MODES.TEXT, VIGNETTE_MODES.NONE], "Frame panel must expose all vignette modes");
assert.equal(panelContext.selectedMusicCues.length, 2, "Frame panel must expose all music cues");
assert.equal(panelContext.selectedSfxCues.length, 1, "Frame panel must expose all SFX cues");
assert.deepEqual(panelContext.musicChannelOptions.map(option => option.value), ["music-1", "music-2"], "Music channel suggestions must include channels used by the scene");
assert.deepEqual(panelContext.sfxChannelOptions.map(option => option.value), ["wind"], "SFX channel suggestions must include channels used by the scene");
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

let routingToggleListener = null;
let routingCommitCount = 0;
let routingRenderCount = 0;
let routingQueued = null;
const routingToggle = {
  checked: false,
  addEventListener(type, listener) { if (type === "change") routingToggleListener = listener; }
};
const routingEditor = Object.create(VNEditorApp.prototype);
routingEditor.element = { querySelector(selector) { return selector === "[name='frame.nextRouting.enabled']" ? routingToggle : null; } };
routingEditor._enqueueEditorAction = operation => {
  routingQueued = Promise.resolve().then(operation);
  return routingQueued;
};
routingEditor._commitFromForm = async () => { routingCommitCount += 1; };
routingEditor._renderPendingEditorParts = async () => { routingRenderCount += 1; };
routingEditor._enableNextRoutingControls({ querySelector(selector) { return selector === "[name='frame.nextRouting.enabled']" ? routingToggle : null; } });
routingToggle.checked = true;
routingToggleListener();
await routingQueued;
assert.equal(routingCommitCount, 1, "Counter-routing toggle must persist through the editor action queue");
assert.equal(routingRenderCount, 1, "Counter-routing toggle must rerender cleanly instead of mutating the panel layout in place");
assert.equal(routingToggle.checked, true, "Counter-routing rerender must preserve the requested toggle value");

const positionScene = createScene();
positionScene.frames[0].portraitPosition = "right";
const positionEditor = Object.create(VNEditorApp.prototype);
positionEditor.selectedFrameId = positionScene.frames[0].id;
positionEditor._commitFromForm = async () => positionScene;
positionEditor._renderEditorParts = () => {};
const savedGetCharacter = VNSceneStore.getCharacter;
const savedUpsertScene = VNSceneStore.upsertScene;
VNSceneStore.getCharacter = () => ({
  id: "position-character",
  name: "Position Character",
  defaultPosition: "center",
  portraits: [{ id: "portrait-position", label: "Main", path: "portrait.png" }]
});
VNSceneStore.upsertScene = async value => value;
await positionEditor._applyCharacterPreset("position-character", "portrait-position");
assert.equal(positionScene.frames[0].portraitPosition, "right", "Applying a character preset must not overwrite the frame portrait position");
VNSceneStore.getCharacter = savedGetCharacter;
VNSceneStore.upsertScene = savedUpsertScene;

const clearPortraitScene = createScene();
const clearPortraitEntry = createFrameCharacter({
  id: "clear-extra",
  characterId: "clear-character",
  portraitId: "clear-portrait",
  name: "Clear Character",
  portrait: "clear-me.png",
  portraitPosition: "right"
});
clearPortraitScene.frames[0].additionalCharacters.push(clearPortraitEntry);
const clearPortraitEditor = Object.create(VNEditorApp.prototype);
clearPortraitEditor.selectedFrameId = clearPortraitScene.frames[0].id;
clearPortraitEditor._commitFromForm = async () => clearPortraitScene;
clearPortraitEditor._renderEditorParts = () => {};
VNSceneStore.getCharacter = () => ({
  id: "clear-character",
  name: "Clear Character",
  portraits: [{ id: "clear-portrait", label: "Main", path: "clear-me.png" }]
});
VNSceneStore.upsertScene = async value => value;
await clearPortraitEditor._applyAdditionalCharacterPortrait("clear-extra", "");
assert.equal(clearPortraitEntry.portraitId, "", "Choosing no portrait must clear an additional character portrait id");
assert.equal(clearPortraitEntry.portrait, "", "Choosing no portrait must clear an additional character portrait path");
VNSceneStore.getCharacter = savedGetCharacter;
VNSceneStore.upsertScene = savedUpsertScene;

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
const frameEffect = { effectCounterId: routeCounter.id, effectOperation: COUNTER_EFFECTS.ADD, effectValue: 2 };
const frameEffectState = applyFrameCounterEffect(frameEffect, { [routeCounter.id]: 1 });
assert.equal(frameEffectState[routeCounter.id], 3, "Any frame must be able to change a counter when entered");
assert.equal(resolveFrameNextRouting(nested, frameEffectState).frameId, "frame-root", "Frame effects must be visible to conditional routing after the frame is entered");
const counterUsageManager = Object.create(VNCounterManagerApp.prototype);
const frameEffectUsage = counterUsageManager._buildCounterUsage({
  counters: [routeCounter],
  frames: [{
    effectCounterId: routeCounter.id,
    effectOperation: COUNTER_EFFECTS.ADD,
    effectValue: 2,
    choices: [],
    nextRouting: { enabled: false, counterId: "" }
  }]
}).get(routeCounter.id);
assert.equal(frameEffectUsage.frameEffects, 1, "Counter manager usage must count effects attached directly to frames");
assert.equal(getFrameReferences(scene, "frame-root").some(ref => ref.type === "counter-true" && ref.frameId === "frame-nested"), true, "Conditional outcomes must be reported as frame references");

const legacyScene = createScene();
const legacyYes = createFrame("dialogue");
legacyYes.id = "legacy-yes";
legacyYes.branchId = legacyScene.branches[0].id;
legacyScene.frames.push(legacyYes);
const legacySource = legacyScene.frames[0];
delete legacySource.textPresentation;
for (const block of legacySource.textBlocks || []) delete block.richText;
delete legacySource.musicCues;
delete legacySource.sfxCues;
legacySource.musicMode = "play";
legacySource.music = "legacy-music.ogg";
legacySource.sfx = "legacy-bell.wav";
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
assert.equal(migrated.schemaVersion, 11);
assert.equal(migratedFrame.nextRouting.enabled, false, "Legacy scene-to-scene routing cannot be converted into frame routing and must be disabled");
assert.equal(migratedFrame.nextRouting.trueFrameId, "", "Legacy scene ids must not be mistaken for frame ids");
assert.equal(migratedFrame.nextRouting.falseFrameId, "", "Legacy scene ids must not be mistaken for frame ids");
assert.equal(migratedFrame.isFinal, true, "Unconvertible legacy exit routing must preserve the terminal frame");
assert.equal("sceneRouting" in migratedFrame, false, "Legacy frame routing field must be removed");
assert.equal(migratedFrame.textPresentation, TEXT_PRESENTATIONS.BOX, "Legacy frames must migrate to normal box presentation");
assert.equal(migratedFrame.vignetteMode, VIGNETTE_MODES.AUTO, "Legacy frames must migrate to automatic vignette behavior");
assert.equal(migratedFrame.showSpeakerName, true, "Legacy frames must show the primary name after migration");
assert.deepEqual(migratedFrame.additionalCharacters, [], "Legacy frames must migrate with no additional characters");
assert.equal(migratedFrame.effectCounterId, "", "Legacy frames must migrate with no frame counter effect");
assert.equal(migratedFrame.effectOperation, COUNTER_EFFECTS.NONE, "Legacy frame counter effects must be disabled");
assert.equal(migratedFrame.effectValue, 0, "Legacy frame counter effect value must default to zero");

const legacyCenteredMigration = migrateData({
  schemaVersion: 9,
  version: 3,
  scenes: [{ id: "legacy-centered", frames: [{ id: "legacy-centered-frame", textPresentation: "center", additionalCharacters: undefined }], frameFolders: [], branches: [] }],
  assets: [],
  characters: []
});
assert.equal(legacyCenteredMigration.scenes[0].frames[0].showSpeakerName, false, "Schema v10 migration must preserve the old centered-text behavior where speaker names were hidden");
assert.deepEqual(legacyCenteredMigration.scenes[0].frames[0].additionalCharacters, [], "Schema v10 migration must initialize an empty additional-character list");
assert.equal(typeof migratedFrame.textBlocks[0].richText, "string", "Legacy text blocks must gain rich text storage");
assert.equal(migratedFrame.musicCues.length, 1, "Legacy music must migrate into one channel cue");
assert.equal(migratedFrame.musicCues[0].channel, "music-1");
assert.equal(migratedFrame.musicCues[0].src, "legacy-music.ogg");
assert.equal(migratedFrame.musicCues[0].loop, true);
assert.equal(migratedFrame.sfxCues.length, 1, "Legacy SFX must migrate into one channel cue");
assert.equal(migratedFrame.sfxCues[0].src, "legacy-bell.wav");
assert.equal("musicMode" in migratedFrame, false, "Legacy music mode must be removed after migration");
assert.equal("music" in migratedFrame, false, "Legacy music path must be removed after migration");
assert.equal("sfx" in migratedFrame, false, "Legacy SFX path must be removed after migration");

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
assert.equal(invalidVersionMigrated.schemaVersion, 11, "Malformed legacy schemaVersion strings must retain the baseline migration fallback");
assert.equal(Array.isArray(invalidVersionMigrated.scenes[0].branches), true, "Baseline migrations must initialize branch data for malformed legacy schemaVersion input");
for (const invalidSchemaVersion of [-1, 7.5, 12]) {
  assert.throws(
    () => migrateData({ schemaVersion: invalidSchemaVersion, version: 3, scenes: [], assets: [], characters: [] }),
    /unsupported schemaVersion/,
    `Unsupported numeric schemaVersion ${invalidSchemaVersion} must be rejected instead of relabeled`
  );
}
assert.throws(
  () => VNSceneStore._sanitizeData({ schemaVersion: 12, version: 3, scenes: [], assets: [], characters: [] }),
  /unsupported schemaVersion/,
  "The scene store must not silently downgrade future-schema data to an empty current-schema save"
);

const malformedAudioFrame = createFrame("dialogue");
malformedAudioFrame.musicCues = [
  { id: "duplicate-audio", action: AUDIO_ACTIONS.PLAY, channel: "score", src: "score-a.ogg", loop: true },
  { id: "duplicate-audio", action: AUDIO_ACTIONS.PLAY, channel: "drone", src: "drone-a.ogg", loop: true },
  "broken-cue",
  []
];
malformedAudioFrame.sfxCues = [
  { id: "duplicate-sfx", action: AUDIO_ACTIONS.PLAY, channel: "rain", src: "rain-a.ogg", loop: true },
  { id: "duplicate-sfx", action: AUDIO_ACTIONS.PLAY, channel: "bell", src: "bell-a.wav", loop: false }
];
const sanitizedAudioFrame = sanitizeFrame(malformedAudioFrame);
assert.equal(new Set(sanitizedAudioFrame.musicCues.map(cue => cue.id)).size, sanitizedAudioFrame.musicCues.length, "Music cue IDs must be unique after sanitization");
assert.equal(new Set(sanitizedAudioFrame.sfxCues.map(cue => cue.id)).size, sanitizedAudioFrame.sfxCues.length, "SFX cue IDs must be unique after sanitization");
assert.equal(sanitizedAudioFrame.musicCues.every(cue => cue && typeof cue === "object" && !Array.isArray(cue)), true, "Malformed primitive or array music cues must normalize into cue objects");
assert.equal(sanitizedAudioFrame.musicCues[0].id, "duplicate-audio", "The first valid unique cue ID should be preserved");
assert.notEqual(sanitizedAudioFrame.musicCues[1].id, "duplicate-audio", "A duplicate cue ID must be regenerated");

const audio = new VNAudioController();
await audio.applyFrame({
  musicCues: [
    createAudioCue("music", { channel: "score", src: "score.ogg", loop: true }),
    createAudioCue("music", { channel: "drone", src: "drone.ogg", loop: true })
  ],
  sfxCues: [
    createAudioCue("sfx", { channel: "rain", src: "rain.ogg", loop: true }),
    createAudioCue("sfx", { channel: "bell", src: "bell.wav", loop: false })
  ]
});
assert.equal(audio.music.size, 2, "Two music channels must be able to play concurrently");
assert.equal(audio.sfx.size, 2, "Two SFX channels must be able to play concurrently");
const originalScore = audio.music.get("score").audio;
await audio.applyFrame({
  musicCues: [createAudioCue("music", { channel: "score", src: "score-2.ogg", loop: true })],
  sfxCues: []
});
assert.equal(audio.music.size, 2, "Replacing one music channel must leave other channels running");
assert.equal(originalScore.paused, true, "Replacing a channel must stop its previous sound");
assert.equal(audio.music.get("score").path, "score-2.ogg");
await audio.applyFrame({
  musicCues: [createAudioCue("music", { action: AUDIO_ACTIONS.STOP, channel: "score" })],
  sfxCues: [createAudioCue("sfx", { action: AUDIO_ACTIONS.STOP, channel: "bell" })]
});
assert.equal(audio.music.has("score"), false, "Stopping one music channel must remove only that channel");
assert.equal(audio.music.has("drone"), true, "Stopping one music channel must keep the other music channel");
assert.equal(audio.sfx.has("bell"), false, "Stopping one SFX channel must remove only that channel");
assert.equal(audio.sfx.has("rain"), true, "Stopping one SFX channel must keep the other SFX channel");
await audio.applyFrame({
  musicCues: [createAudioCue("music", { action: AUDIO_ACTIONS.STOP_ALL })],
  sfxCues: [createAudioCue("sfx", { action: AUDIO_ACTIONS.STOP_ALL })]
});
assert.equal(audio.music.size, 0, "Stop-all must clear every music channel");
assert.equal(audio.sfx.size, 0, "Stop-all must clear every SFX channel");
audio.destroy();

const transitionBoundaryPlayer = Object.create(VNPlayerApp.prototype);
transitionBoundaryPlayer.currentFrameId = "bad-transition";
transitionBoundaryPlayer.currentTextIndex = 0;
transitionBoundaryPlayer.started = false;
transitionBoundaryPlayer.mode = PLAYER_MODES.INDIVIDUAL;
transitionBoundaryPlayer.scene = {
  id: "transition-scene",
  frames: [{
    id: "bad-transition",
    type: "dialogue",
    transition: "legacy",
    speaker: "Primary",
    showSpeakerName: true,
    additionalCharacters: [
      createFrameCharacter({ id: "companion", name: "Companion", portrait: "companion.png", portraitPosition: "right", showName: true })
    ],
    textBlocks: [createTextBlock("Test")],
    choices: []
  }]
};
transitionBoundaryPlayer.visualState = { background: "", portrait: "", portraitPosition: "left" };
transitionBoundaryPlayer.participantIds = [];
transitionBoundaryPlayer.loading = false;
transitionBoundaryPlayer.preloadDone = 0;
transitionBoundaryPlayer.preloadTotal = 0;
transitionBoundaryPlayer.counterState = {};
transitionBoundaryPlayer._localVote = null;
transitionBoundaryPlayer._voteState = transitionBoundaryPlayer._emptyVoteState("bad-transition", 0);
transitionBoundaryPlayer._leaderVotes = new Map();
transitionBoundaryPlayer._volumePanelOpen = false;
transitionBoundaryPlayer._localVolumeValues = new Map();
transitionBoundaryPlayer._buildPlaybackIndex();
transitionBoundaryPlayer._activeParticipantIds = () => [];
transitionBoundaryPlayer._isLeader = () => false;
transitionBoundaryPlayer._canCloseLocally = () => true;
transitionBoundaryPlayer._volumeLevels = () => [];
transitionBoundaryPlayer._prefersReducedMotion = () => false;
const originalPrepareContext = Object.getPrototypeOf(VNPlayerApp.prototype)._prepareContext;
Object.getPrototypeOf(VNPlayerApp.prototype)._prepareContext = async () => ({});
const transitionBoundaryContext = await transitionBoundaryPlayer._prepareContext({});
Object.getPrototypeOf(VNPlayerApp.prototype)._prepareContext = originalPrepareContext;
assert.equal(transitionBoundaryContext.transitionClass, "transition-none", "Player boundary must reject unsupported transition classes from raw scene payloads");
assert.equal(transitionBoundaryContext.frameCharacters.length, 2, "Player context must expose primary and additional frame characters together");
assert.equal(transitionBoundaryContext.frameCharacters[0].name, "Primary");
assert.equal(transitionBoundaryContext.frameCharacters[1].portraitSrc, "companion.png");
assert.equal(transitionBoundaryContext.frameCharacters[1].showName, true, "Additional character names must obey their per-character visibility flag");
transitionBoundaryPlayer.scene.frames[0].textPresentation = TEXT_PRESENTATIONS.CENTER;
const centeredCharacterContext = await transitionBoundaryPlayer._prepareContext({});
assert.equal(centeredCharacterContext.frameCharacters[0].showName, false, "Centered text must suppress the primary character name");
assert.equal(centeredCharacterContext.frameCharacters[1].showName, false, "Centered text must suppress additional character names");

const visualStatePlayer = Object.create(VNPlayerApp.prototype);
visualStatePlayer.visualState = { background: "old-bg.png", portrait: "old-portrait.png", portraitPosition: "center" };
visualStatePlayer._applyVisualState({ background: "", clearBackground: false, portrait: "", hidePortrait: false, portraitPosition: "right" });
assert.equal(visualStatePlayer.visualState.portrait, "old-portrait.png", "A frame without a new portrait must keep the previous portrait image");
assert.equal(visualStatePlayer.visualState.portraitPosition, "right", "Portrait position must update even when the frame keeps the previous portrait image");

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

let focusHidden = false;
const showControl = { setAttribute(name, value) { this[name] = value; } };
const hideControl = { setAttribute(name, value) { this[name] = value; } };
const focusPlayer = Object.create(VNPlayerApp.prototype);
focusPlayer.element = {
  matches(selector) { return selector === ".fbl-vn-player"; },
  classList: { toggle(name, enabled) { if (name === "is-content-hidden") focusHidden = enabled; } },
  querySelector(selector) {
    if (selector === ".fbl-vn-show-content") return showControl;
    if (selector === ".fbl-vn-hide-content") return hideControl;
    return null;
  }
};
focusPlayer._setContentHidden(true);
assert.equal(focusHidden, true, "Focus view must hide the dialogue UI locally");
assert.equal(focusPlayer._contentHidden, true);
focusPlayer._setContentHidden(false);
assert.equal(focusHidden, false, "Focus view must be reversible");

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

// Synchronized self-loops must remain true frame re-entries on remote clients.
const syncSceneId = "scene-self-loop-sync";
const syncPlayer = Object.create(VNPlayerApp.prototype);
syncPlayer.currentFrameId = "loop-frame";
syncPlayer.loading = false;
syncPlayer.started = true;
syncPlayer._disposed = false;
let syncTextBlockCalls = 0;
let syncFrameEntryCalls = 0;
syncPlayer._goToTextBlockNow = async () => { syncTextBlockCalls += 1; };
syncPlayer._goToFrameNow = async () => { syncFrameEntryCalls += 1; };
syncPlayer._applyChoiceEffectById = () => {};
VNPlayerApp.active.set(syncSceneId, syncPlayer);
await VNPlayerApp.advanceScene(syncSceneId, "loop-frame", 1, {});
assert.equal(syncTextBlockCalls, 1, "A normal same-frame text advance must stay a text-block advance");
assert.equal(syncFrameEntryCalls, 0, "A normal same-frame text advance must not re-enter the frame");
await VNPlayerApp.advanceScene(syncSceneId, "loop-frame", 0, { reenter: true });
assert.equal(syncFrameEntryCalls, 1, "An explicit synchronized self-loop must re-enter the frame on the remote client");
VNPlayerApp.active.delete(syncSceneId);

const queuedSyncPlayer = Object.create(VNPlayerApp.prototype);
queuedSyncPlayer.currentFrameId = "loop-frame";
queuedSyncPlayer._disposed = false;
queuedSyncPlayer._pendingRemoteFrames = [
  { frameId: "loop-frame", textIndex: 1, options: {} },
  { frameId: "loop-frame", textIndex: 0, options: { reenter: true } }
];
let queuedTextBlockCalls = 0;
let queuedFrameEntryCalls = 0;
queuedSyncPlayer._goToTextBlockNow = async () => { queuedTextBlockCalls += 1; };
queuedSyncPlayer._goToFrameNow = async () => { queuedFrameEntryCalls += 1; };
queuedSyncPlayer._applyChoiceEffectById = () => {};
await queuedSyncPlayer._flushPendingRemoteFrames();
assert.equal(queuedTextBlockCalls, 1, "Queued same-frame text advances must not replay frame effects after preload");
assert.equal(queuedFrameEntryCalls, 1, "Queued explicit self-loops must retain frame re-entry after preload");

const startupBufferPlayer = Object.create(VNPlayerApp.prototype);
startupBufferPlayer.loading = false;
startupBufferPlayer.started = true;
startupBufferPlayer._starting = true;
startupBufferPlayer._resuming = false;
startupBufferPlayer._pendingRemoteFrames = [];
VNPlayerApp.active.set("scene-startup-buffer", startupBufferPlayer);
VNPlayerApp.advanceScene("scene-startup-buffer", "frame-a", 0, {});
assert.equal(startupBufferPlayer._pendingRemoteFrames.length, 1, "Remote advances arriving while the startup frame is still settling must remain buffered");
startupBufferPlayer._starting = false;
VNPlayerApp.active.delete("scene-startup-buffer");

const resumeBufferPlayer = Object.create(VNPlayerApp.prototype);
resumeBufferPlayer.loading = false;
resumeBufferPlayer.started = true;
resumeBufferPlayer._starting = false;
resumeBufferPlayer._resuming = true;
resumeBufferPlayer._pendingRemoteFrames = [];
VNPlayerApp.active.set("scene-resume-buffer", resumeBufferPlayer);
VNPlayerApp.advanceScene("scene-resume-buffer", "frame-b", 0, {});
assert.equal(resumeBufferPlayer._pendingRemoteFrames.length, 1, "Remote advances arriving while a reconnect state is being restored must remain buffered");
resumeBufferPlayer._resuming = false;
VNPlayerApp.active.delete("scene-resume-buffer");

const drainPlayer = Object.create(VNPlayerApp.prototype);
drainPlayer._disposed = false;
drainPlayer._pendingRemoteFrames = [
  { frameId: "one", textIndex: 0, options: {} }
];
const drainedFrames = [];
drainPlayer._enqueuePlaybackOperation = async operation => operation();
drainPlayer._applyRemoteAdvance = async frameId => {
  drainedFrames.push(frameId);
  if (frameId === "one") drainPlayer._pendingRemoteFrames.push({ frameId: "two", textIndex: 0, options: {} });
};
await drainPlayer._flushPendingRemoteFrames();
assert.deepEqual(drainedFrames, ["one", "two"], "Pending-advance drain must include messages that arrive while startup or resume buffering is being flushed");

const serialSceneId = "scene-serialized-remote";
const serialPlayer = Object.create(VNPlayerApp.prototype);
serialPlayer.currentFrameId = "serial-start";
serialPlayer.loading = false;
serialPlayer.started = true;
serialPlayer._disposed = false;
serialPlayer._applyChoiceEffectById = () => {};
const serialOrder = [];
serialPlayer._goToFrameNow = async frameId => {
  serialOrder.push(`start:${frameId}`);
  if (frameId === "serial-a") await new Promise(resolve => setTimeout(resolve, 8));
  serialPlayer.currentFrameId = frameId;
  serialOrder.push(`end:${frameId}`);
};
serialPlayer._goToTextBlockNow = async () => {};
VNPlayerApp.active.set(serialSceneId, serialPlayer);
const serialA = VNPlayerApp.advanceScene(serialSceneId, "serial-a", 0, {});
const serialB = VNPlayerApp.advanceScene(serialSceneId, "serial-b", 0, {});
await Promise.all([serialA, serialB]);
assert.deepEqual(serialOrder, ["start:serial-a", "end:serial-a", "start:serial-b", "end:serial-b"], "Remote frame transitions must be serialized so a slow older preload cannot overwrite a newer advance");
assert.equal(serialPlayer.currentFrameId, "serial-b", "Serialized remote advances must finish on the latest requested frame");
VNPlayerApp.active.delete(serialSceneId);

const savedSocketEmit = VNSocket.emit;
const savedWithSceneTargets = VNSocket._withSceneTargets;
let emittedAdvance = null;
VNSocket._withSceneTargets = (_sceneId, data) => data;
VNSocket.emit = (type, data) => { emittedAdvance = { type, data }; return true; };
VNSocket.advance(syncSceneId, "loop-frame", 0, { reenter: true });
assert.equal(emittedAdvance.type, "advance");
assert.equal(emittedAdvance.data.reenter, true, "Socket advance payload must carry an explicit frame re-entry flag");
VNSocket.advance(syncSceneId, "loop-frame", 1, {});
assert.equal("reenter" in emittedAdvance.data, false, "Normal text advances must not be mislabeled as frame re-entry");
VNSocket.emit = savedSocketEmit;
VNSocket._withSceneTargets = savedWithSceneTargets;

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
