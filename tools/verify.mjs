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
const graphSource = read("scripts/apps/vn-graph-app.js");
const mainSource = read("scripts/main.js");
const socketSource = read("scripts/playback/vn-socket.js");
const characterManagerSource = read("scripts/apps/vn-character-manager-app.js");
const counterManagerSource = read("scripts/apps/vn-counter-manager-app.js");
const playerSource = read("scripts/apps/vn-player-app.js");
const preloaderSource = read("scripts/playback/vn-preloader.js");
const schemaSource = read("scripts/data/schema.js");
const migrationSource = read("scripts/data/migrations.js");
const constantsSource = read("scripts/utils/constants.js");
const sceneStoreSource = read("scripts/data/scene-store.js");
const foundryHelpersSource = read("scripts/utils/foundry-helpers.js");
const characterTemplateSource = read("templates/character-manager.hbs");
const editorFrameTemplateSource = read("templates/editor-frame-panel.hbs");
const editorFramesTemplateSource = read("templates/editor-frames.hbs");
const editorScenesTemplateSource = read("templates/editor-scenes.hbs");
const graphTemplateSource = read("templates/graph.hbs");
const playerTemplateSource = read("templates/player.hbs");
const characterCssSource = read("styles/character-manager.css");
const editorFormsCssSource = read("styles/editor-forms.css");
const editorLayoutCssSource = read("styles/editor-layout.css");
const editorComponentsCssSource = read("styles/editor-components.css");
const graphCssSource = read("styles/graph.css");
const playerCssSource = read("styles/player.css");
const exportExamplePath = "examples/fbl-vn-export.example.json";
const exportFormatPath = "docs/EXPORT_FORMAT.md";
if (!exists(exportExamplePath)) errors.push("Export structure example is missing");
if (!exists(exportFormatPath)) errors.push("Export format documentation is missing");
if (exists(exportExamplePath)) {
  try {
    const example = JSON.parse(read(exportExamplePath));
    if (example.schemaVersion !== 14 || example.version !== 3) errors.push("Export example must use current schemaVersion 14 and storage version 3");
    if (!Array.isArray(example.scenes) || !example.scenes.length) errors.push("Export example must contain at least one scene");
    if (!Array.isArray(example.assets) || !Array.isArray(example.characters)) errors.push("Export example must show assets and characters arrays");
    const exampleScene = example.scenes?.[0] || null;
    const exampleFrames = Array.isArray(exampleScene?.frames) ? exampleScene.frames : [];
    const choiceFrame = exampleFrames.find(frame => frame?.type === "choice") || null;
    if (!exampleScene?.startFrame || !Array.isArray(exampleScene?.branches) || !Array.isArray(exampleScene?.counters) || !Array.isArray(exampleScene?.frameFolders)) {
      errors.push("Export example scene must document branches, counters, folders and startFrame");
    }
    if (!exampleFrames.some(frame => Array.isArray(frame?.textBlocks) && frame.textBlocks.length)) errors.push("Export example must document frame textBlocks");
    if (!exampleFrames.some(frame => Array.isArray(frame?.musicCues) && frame.musicCues.length) || !exampleFrames.some(frame => Array.isArray(frame?.sfxCues) && frame.sfxCues.length)) {
      errors.push("Export example must document music and SFX cue structures");
    }
    if (!choiceFrame || !Array.isArray(choiceFrame.choices) || !choiceFrame.choices.length || !Array.isArray(choiceFrame.nextRouting?.conditions)) {
      errors.push("Export example must document choices and compound next-routing conditions");
    }
    const nestedFolder = exampleScene?.frameFolders?.find(folder => folder?.parentId);
    if (!nestedFolder) errors.push("Export example must include at least one nested frame folder");
    const trustCounter = exampleScene?.counters?.find(counter => counter?.id === "counter-trust");
    const dialogueFrame = exampleFrames.find(frame => frame?.id === "frame-dialogue");
    const trustBeforeChoice = Number(trustCounter?.initial || 0)
      + (dialogueFrame?.effectCounterId === "counter-trust" && dialogueFrame?.effectOperation === "add" ? Number(dialogueFrame.effectValue || 0) : 0);
    const routingTrust = choiceFrame?.nextRouting?.conditions?.find(condition => condition?.counterId === "counter-trust" && condition?.operator === "gte");
    const secretChoice = choiceFrame?.choices?.find(choice => choice?.id === "choice-secret");
    const secretTrust = secretChoice?.conditions?.find(condition => condition?.counterId === "counter-trust" && condition?.operator === "gte");
    if (!routingTrust || trustBeforeChoice < Number(routingTrust.value || 0)) errors.push("Export example conditional routing must be reachable from its documented counter progression");
    if (!secretTrust || trustBeforeChoice < Number(secretTrust.value || 0)) errors.push("Export example conditional choice must be reachable from its documented counter progression");
    if (!Number.isFinite(Number(exampleScene?.audioExitFadeMs))) errors.push("Export example scene must document audioExitFadeMs");
    if (exampleFrames.some(frame => !Number.isFinite(Number(frame?.textSpeed)))) errors.push("Every export example frame must document textSpeed");
    const exampleAudioCues = exampleFrames.flatMap(frame => [...(frame?.musicCues || []), ...(frame?.sfxCues || [])]);
    for (const cue of exampleAudioCues) {
      for (const field of ["repeatCount", "repeatDelayMs", "startDelayMs", "fadeInMs", "fadeOutMs", "crossFadeMs", "continueRepeats"]) {
        if (!(field in cue)) errors.push(`Export example audio cue is missing schema v13 field: ${field}`);
      }
    }
  }
  catch (error) {
    errors.push(`Export structure example is not valid JSON: ${error.message}`);
  }
}
if (exists(exportFormatPath)) {
  const exportFormatSource = read(exportFormatPath);
  if (!exportFormatSource.includes("schemaVersion: 14") || !exportFormatSource.includes("fbl-vn-export.example.json")) {
    errors.push("Export format documentation must identify the current schema and example file");
  }
}
if (!playerTemplateSource.includes("fbl-vn-dialogue-scroll")) errors.push("Player dialogue must contain a dedicated scroll region");
if (!playerTemplateSource.includes("fbl-vn-dialogue-actions")) errors.push("Player dialogue must contain a fixed action row");
if (!playerTemplateSource.includes("fbl-vn-choice-overlay")) errors.push("Choice buttons must render outside the dialogue box");
if (!playerTemplateSource.includes('fbl-vn-choice-overlay {{#if isCenteredText}}is-centered-text{{/if}}')) errors.push("Centered-text choice overlays must expose a dedicated bottom-anchored class");
if (!/\.fbl-vn-choice-overlay\.is-centered-text\s*\{[\s\S]*?place-items:\s*end center;[\s\S]*?padding-bottom:\s*14px;/.test(playerCssSource) || !/\.fbl-vn-choice-overlay\.is-centered-text \.fbl-vn-player-choice-list\s*\{[\s\S]*?max-height:\s*42vh;/.test(playerCssSource)) errors.push("Centered-text choices must anchor at the bottom and grow upward without occupying the text center");
if (!/--vn-dialogue-height:\s*240px/.test(playerCssSource)) errors.push("Player dialogue must define a stable desktop height");
if (!/\.fbl-vn-portrait\s*\{[\s\S]*?bottom:\s*var\(--vn-dialogue-height\)/.test(playerCssSource)) errors.push("Portrait bottom must align to dialogue top");
if (!/\.fbl-vn-dialogue-scroll\s*\{[\s\S]*?overflow-y:\s*auto/.test(playerCssSource)) errors.push("Dialogue scroll region must retain vertical scrolling");
if (!/\.fbl-vn-dialogue\.is-centered-text\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?overflow:\s*hidden/.test(playerCssSource)) errors.push("Centered dialogue must reserve viewport space with a bounded flex column");
if (!/\.fbl-vn-dialogue\.is-centered-text \.fbl-vn-dialogue-scroll\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*auto/.test(playerCssSource)) errors.push("Centered dialogue text must scroll inside the remaining flex space");
if (!playerTemplateSource.includes("showScreenVignette") || !playerTemplateSource.includes("showTextVignette")) errors.push("Player template must support screen and local text vignette modes");
if (!/\.fbl-vn-speaker\.portrait-left\s*\{[\s\S]*?left:\s*var\(--vn-dialogue-inline\)/.test(playerCssSource)) errors.push("Left speaker badge must align with the dialogue edge");
if (!/\.fbl-vn-speaker\.portrait-right\s*\{[\s\S]*?right:\s*var\(--vn-dialogue-inline\)/.test(playerCssSource)) errors.push("Right speaker badge must align with the dialogue edge");
if (!/\.fbl-vn-dialogue\.is-centered-text\.has-text-vignette \.fbl-vn-text\s*\{[\s\S]*?background:\s*rgba\(0,\s*0,\s*0,\s*0\.72\)[\s\S]*?box-shadow:/.test(playerCssSource)) errors.push("Centered text vignette must use a compact opaque shadow without a clipped radial gradient");
if (!/\.fbl-vn-centered-actions\s*\{[\s\S]*?right:\s*calc\(var\(--vn-dialogue-inline\) \+ 20px\);[\s\S]*?bottom:\s*14px;/.test(playerCssSource)) errors.push("Centered text actions must stay in the normal bottom-right action position");
if (!playerTemplateSource.includes('class="fbl-vn-centered-actions"')) errors.push("Centered text actions wrapper is missing");
if (!/clean\.transition\s*=\s*\["none",\s*"fade",\s*"dark"\]\.includes\(clean\.transition\)\s*\?\s*clean\.transition\s*:\s*"none"/.test(schemaSource)) errors.push("Frame sanitization must reject unsupported transition values");
if (!/const transition\s*=\s*frame && \["none",\s*"fade",\s*"dark"\]\.includes\(frame\.transition\)\s*\?\s*frame\.transition\s*:\s*"none"/.test(playerSource)) errors.push("Player must reject unsupported transition classes from raw scene payloads");
if (!characterManagerSource.includes("this.expandedCharacterIds = new Set()")) errors.push("Character manager must start with every preset collapsed");
if (!characterManagerSource.includes("this.selectedScope = options.scope || this.editor?.selectedSceneId || CHARACTER_SCOPE_ALL")) errors.push("Character manager must default to the currently edited cutscene library");
if (!characterManagerSource.includes('["auto", "Стандарт / не задано"]')) errors.push("Character presets must expose an automatic/default side option");
if (!characterManagerSource.includes("copy.expanded = this.expandedCharacterIds.has(copy.id)")) errors.push("Character manager must preserve expanded cards across rerenders");
if (!characterManagerSource.includes('for (const row of this.element.querySelectorAll("[data-character-row]"))') || !characterManagerSource.includes("else this.expandedCharacterIds.delete(characterId);")) errors.push("Character manager capture must update only rendered rows so hidden-scope expansion state survives");
if (!characterManagerSource.includes("_sceneUsageIndex(data)") || !characterManagerSource.includes("frame?.additionalCharacters")) errors.push("Character manager must infer legacy preset cutscene usage from primary and additional frame characters");
if (!characterManagerSource.includes("const byId = new Map(storedCharacters.map(character => [character.id, character]))")) errors.push("Filtered character manager saves must preserve presets hidden by another cutscene scope");
if (!schemaSource.includes('clean.sceneId = String(clean.sceneId || "")')) errors.push("Character preset schema must preserve cutscene library assignment");
if (!characterTemplateSource.includes('data-action="toggleCharacter"') || !characterTemplateSource.includes("data-character-scope-filter")) errors.push("Character presets must use explicit disclosure buttons and expose a cutscene library filter");
if (characterTemplateSource.includes("<details") || characterTemplateSource.includes("<summary")) errors.push("Character manager must avoid native details/summary elements that can collapse under host-system CSS");
if (!/\.fbl-vn-character-card\[data-expanded="true"\] \.fbl-vn-character-chevron\s*\{[\s\S]*?transform:\s*rotate\(90deg\)/.test(characterCssSource)) errors.push("Expanded character cards must expose a visible disclosure state");
if (!/button\.fbl-vn-character-summary\s*\{[\s\S]*?min-height:\s*44px;[\s\S]*?display:\s*grid;/.test(characterCssSource)) errors.push("Character preset headers must keep a real clickable height instead of collapsing into separator lines");
if (!schemaSource.includes("export function createFrameCharacter")) errors.push("Frame schema must expose additional character records");
if (!schemaSource.includes("clean.additionalCharacters = Array.isArray(clean.additionalCharacters)")) errors.push("Frame sanitization must normalize additional characters");
if (!editorFrameTemplateSource.includes('data-action="addFrameCharacter"') || !editorFrameTemplateSource.includes('data-action="deleteFrameCharacter"') || !editorFrameTemplateSource.includes("data-additional-character-row")) errors.push("Frame editor must expose add/remove character rows");
if (!editorFrameTemplateSource.includes('name="frame.textSpeed"') || !editorSource.includes('frame.textSpeed = Number(this._readValue("frame.textSpeed"')) errors.push("Frame editor must expose and persist per-frame text speed");
if (!editorSource.includes('["auto", "По пресету / авто"]')) errors.push("Frame editor must expose preset/automatic portrait inheritance");
if (!schemaSource.includes('portraitPosition: "auto"') || !schemaSource.includes("clean.textSpeed = Math.max(TEXT_SPEED.MIN")) errors.push("Frame schema must default portrait inheritance and sanitize text speed");
if (!playerSource.includes("_resolvePrimaryPortraitPosition(frame)") || !playerSource.includes("_resetAutoPortraitSequence()") || !playerSource.includes("_resolveAdditionalPortraitPosition(character)")) errors.push("Player must resolve preset, automatic, and additional portrait sides");
if (!playerSource.includes("this._characterPresetPositions = normalizeCharacterPresetPositions(options.characterPresetPositions)") || !playerSource.includes("const position = this._characterPresetPositions?.[characterId]") || !socketSource.includes("characterPresetPositions")) errors.push("Networked playback must carry preset portrait positions instead of reading the GM-only character store on player clients");
if (!playerSource.includes("automaticPortraitState:") || !playerSource.includes("_restoreAutoPortraitState(state.automaticPortraitState)") || !playerSource.includes("_restoreAutoPortraitState(state)")) errors.push("Reconnect snapshots must serialize and restore automatic portrait alternation state");
if (!sceneStoreSource.includes('["left", "center", "right"].includes(frame.portraitPosition)') || !sceneStoreSource.includes(': character.defaultPosition || "auto"')) errors.push("Saving a character preset from an inherited frame must preserve its existing side");
if (!sceneStoreSource.includes('Object.prototype.hasOwnProperty.call(importedSnapshot, "schemaVersion")') || !sceneStoreSource.includes("? migrateData(importedSnapshot)") || !sceneStoreSource.includes("normalizedSnapshot")) errors.push("Versioned full-container imports must run schema migrations before merge sanitization");
if (!editorSource.includes("_applyAdditionalCharacterPreset") || !editorSource.includes("_applyAdditionalCharacterPortrait")) errors.push("Frame editor must bind presets and portraits for additional characters");
if (!playerTemplateSource.includes("{{#each frameCharacters}}")) errors.push("Player template must render multiple frame characters");
if (!playerSource.includes("frameCharacters.push")) errors.push("Player context must compose multiple visible characters");
if (!playerSource.includes("frame?.showSpeakerName !== false && !isCenteredText") || !playerSource.includes("character.showName !== false && !isCenteredText")) errors.push("Centered text must suppress all character name badges");
if (!editorSource.includes('if (!portraitId) {') || !editorSource.includes('entry.portrait = "";')) errors.push("Additional character portrait selection must support clearing the portrait");
if (!/\.fbl-vn-frame-character-card\s*\{/.test(editorFormsCssSource)) errors.push("Frame character editor cards must be styled");
if (!/\.fbl-vn-route-toggle\s*\{[\s\S]*?position:\s*relative;/.test(editorFormsCssSource) || !/\.fbl-vn-route-toggle input\s*\{[\s\S]*?inset:\s*0;[\s\S]*?inline-size:\s*100%;[\s\S]*?block-size:\s*100%;[\s\S]*?pointer-events:\s*auto;/.test(editorFormsCssSource)) errors.push("Counter-routing checkbox must stay inside the visible toggle hit area");
if (!schemaSource.includes('effectCounterId: ""') || !schemaSource.includes("export function applyFrameCounterEffect")) errors.push("Frame schema must support counter effects");
if (!schemaSource.includes("missing-frame-effect-counter")) errors.push("Scene validation must report missing frame-effect counters");
if (!editorFrameTemplateSource.includes('name="frame.effectCounterId"') || !editorFrameTemplateSource.includes('name="frame.effectOperation"') || !editorFrameTemplateSource.includes('name="frame.effectValue"')) errors.push("Frame editor must expose counter effect controls");
if (!editorSource.includes("frameEffectCounterOptions") || !editorSource.includes("frameEffectOperationOptions")) errors.push("Frame editor context must expose counter effect options");
if (!editorSource.includes("currentIndex + 1") || !editorSource.includes("this._normalizeTreeOrder(scene, frame.folderId || \"\", { type: \"frame\", id: frame.id }, insertIndex")) errors.push("New frames must insert immediately after the selected sibling instead of appending to the branch");
if (!editorSource.includes("_setFrameTargetFromList(input, frameId)") || !editorSource.includes("_enableFrameListTargetPicking(root = this.element)") || !editorSource.includes("event.stopImmediatePropagation?.()")) errors.push("Focused frame-target search must support mouse picking from the frame list without navigating");
if (!editorSource.includes("_frameOutgoingLinks(scene, frame, sequentialById = null)") || !editorSource.includes("_drawFrameListLinks(root)") || !editorFramesTemplateSource.includes("data-frame-link-svg") || !/\.fbl-vn-frame-link\s*\{/.test(editorComponentsCssSource)) errors.push("Frame list must render compact transition connectors for visible destinations");
if (!editorSource.includes("this.scenesCollapsed") || !editorFramesTemplateSource.includes('data-action="toggleScenesColumn"') || !editorScenesTemplateSource.includes('data-action="toggleScenesColumn"') || !/\.fbl-vn-editor\.is-scenes-collapsed\s*\{/.test(editorLayoutCssSource)) errors.push("Cutscene column must be collapsible with a restore control in the frame toolbar");
if (!editorSource.includes("this.secondaryBranchId") || !editorSource.includes("_activateBranchForSelection(branchId)") || !editorFramesTemplateSource.includes("data-secondary-branch-select") || !editorFramesTemplateSource.includes("secondaryFrameTreeRows") || !/\.fbl-vn-frame-columns\.is-dual\s*\{/.test(editorComponentsCssSource)) errors.push("Editor must support two simultaneously visible branch columns");
if (!editorSource.includes("_frameSequentialTarget(scene, frame)") || !editorSource.includes('item.branchId || "") === (frame.branchId || "")')) errors.push("Inline implicit links must follow the same per-branch sequential fallback as playback");
const moveTreeBlock = editorSource.match(/async _moveTreeItem\([\s\S]*?\n\s*_treeRecord\(/)?.[0] || "";
if (!moveTreeBlock.includes("_activateBranchForSelection(newBranchId)") || moveTreeBlock.includes("this.selectedBranchId = newBranchId")) errors.push("Cross-branch frame/folder moves must preserve the two visible branch columns");
const commitFormBlock = editorSource.match(/async _commitFromForm\([\s\S]*?\n\s*_readValue\(/)?.[0] || "";
if (!commitFormBlock.includes("_activateBranchForSelection(currentFrame.branchId)") || commitFormBlock.includes("else this.selectedBranchId = currentFrame.branchId")) errors.push("Frame branch changes committed from the panel must preserve the two visible branch columns");
if (!commitFormBlock.includes("cleanFrame = sanitizeFrame(frame)") || !commitFormBlock.includes("const frameChanged =") || !commitFormBlock.includes("if (!frameChanged && !metadataChanged)")) errors.push("Unchanged editor commits must stop after current-frame comparison instead of sanitizing the whole scene");
if (!commitFormBlock.includes("return persist ? originalScene : duplicateData(originalScene)")) errors.push("Non-persisting no-op editor commits must return an isolated draft instead of the cached selected scene");
if (!editorSource.includes("VNSceneStore.sceneSummaries") || editorSource.includes("VNSceneStore.scenes")) errors.push("Editor scene rails must use lightweight scene summaries instead of cloning every full scene");
if (!editorSource.includes("cached?.sceneId === scene.id && cached.revision === revision") || !editorSource.includes("this._lastValidationSnapshot = { sceneId: scene.id, revision, issues: state.issues }")) errors.push("Editor validation must be cached by scene id and store revision");
if (!editorSource.includes("_syncFrameSelectionDom(frameId, folderId = \"\")") || !editorSource.includes('fastSelection ? ["framePanel"] : ["frames", "framePanel"]')) errors.push("Unchanged same-branch frame selection must avoid rerendering the full frame list");
if (!sceneStoreSource.includes("static get sceneSummaries()") || !sceneStoreSource.includes("frameCount: Array.isArray(scene.frames) ? scene.frames.length : 0")) errors.push("Scene store must expose lightweight scene summaries for the editor");
if (!sceneStoreSource.includes("static get revision()") || !sceneStoreSource.includes("this._revision = Number(this._revision || 0) + 1")) errors.push("Scene store must expose a monotonic cache revision for safe editor memoization");
if (!sceneStoreSource.includes("static async _persistCleanData(clean)") || !sceneStoreSource.includes("upsertScene(scene, { sanitized = false, knownChanged = false } = {})")) errors.push("Prepared scene upserts must avoid full-store resanitization while keeping generic mutations unchanged");
if (!foundryHelpersSource.includes("export function serializeJson(data, { pretty = false } = {})") || !foundryHelpersSource.includes("pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)")) errors.push("JSON downloads must use compact serialization by default");
const frameLinkScheduleBlock = editorSource.match(/_scheduleFrameLinkDraw\(root\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*_drawFrameListLinks/)?.[1] || "";
if (frameLinkScheduleBlock.includes('addEventListener("scroll"')) errors.push("Frame transition overlay must not redraw on scroll when using content-relative coordinates");
if (!frameLinkScheduleBlock.includes("this._frameLinkDrawRaf") || !frameLinkScheduleBlock.includes("this._frameLinkDrawRoot")) errors.push("Frame transition overlay redraw requests must be coalesced into one animation frame");
const frameLinkDrawBlock = editorSource.match(/_drawFrameListLinks\(root\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*_enableFrameDrag/)?.[1] || "";
if (!frameLinkDrawBlock.includes("const sequentialById = new Map()") || !frameLinkDrawBlock.includes("const previousByBranch = new Map()") || !frameLinkDrawBlock.includes("frameRects.set(id, node.getBoundingClientRect())") || !frameLinkDrawBlock.includes("const pathSpecs = []")) errors.push("Frame transition overlay must precompute sequential targets and batch geometry reads before SVG writes");
if (!/@media \(max-width: 1000px\) \{[\s\S]*?\.fbl-vn-editor\.is-dual-branch:not\(\.is-scenes-collapsed\)\s*\{[\s\S]*?grid-template-columns:\s*190px minmax\(0, 1fr\);[\s\S]*?grid-template-areas:/.test(editorLayoutCssSource)) errors.push("Expanded dual-branch editor must fall back to the narrow two-column grid below 1000px");
if (!/@media \(max-width: 720px\) \{[\s\S]*?\.fbl-vn-editor\.is-dual-branch:not\(\.is-scenes-collapsed\)\s*\{[\s\S]*?grid-template-columns:\s*150px minmax\(0, 1fr\);/.test(editorLayoutCssSource)) errors.push("Expanded dual-branch editor must use the narrowest scene rail below 720px");
if (!playerSource.includes("this._applyFrameEffect(frame);") || !playerSource.includes("applyFrameCounterEffect")) errors.push("Player must apply a frame counter effect on frame entry");
if (!playerSource.includes("static async previewFrame(scene, frameId, options = {})") || !playerSource.includes("async startFramePreview(frameId, options = {})") || !playerSource.includes("_findBranchPreviewPath(targetFrameId, branchId = \"\")") || !playerSource.includes("_findPreviewPath(targetFrameId)") || !playerSource.includes("_warmFramePreview(previewPath)")) errors.push("Player must support selected-frame preview with current-branch inherited state and graph fallback");
if (!playerSource.includes("AUDIO_ACTIONS") || !playerSource.includes('_applyPreviewCueState(music, frame.musicCues, "music")') || !playerSource.includes('_applyPreviewCueState(sfx, frame.sfxCues, "sfx")')) errors.push("Selected-frame preview must reconstruct inherited audio channel state");
if (!playerSource.includes('.filter(frame => (frame.branchId || "") === currentBranchId)') || !playerSource.includes('return { steps, counterState, branchId: currentBranchId, source: "branch" }')) errors.push("Selected-frame preview must reconstruct deterministic inherited state from preceding frames in the current editor branch");
if (!editorSource.includes('["previewFrame", "Просмотреть выбранный кадр"') || !editorSource.includes("static async _onPreviewFrame(event, target)") || !editorSource.includes("const branchId = this.selectedBranchId || frame.branchId || \"\"") || !editorSource.includes("VNPlayerApp.previewFrame(scene, frame.id, { branchId })")) errors.push("Editor header must preview the selected frame in the current editor branch through the real player");
if (!playerSource.includes("_isGmVoteOverride()") || !playerSource.includes("return this._resolveGmVoteOverride({ action: \"continue\" })") || !playerSource.includes('return this._resolveGmVoteOverride({ action: "choice", choiceId })')) errors.push("Vote mode must give the leader GM an immediate override path without treating the GM as a voter");
if (!playerSource.includes("_voteParticipantIds()") || !playerSource.includes("user.isGM !== true") || !socketSource.includes("mode === PLAYER_MODES.VOTE ? players : [game.user.id, ...players]")) errors.push("Vote quorum must contain non-GM players only");
if (!playerSource.includes("this._participantConnectionState = new Map()") || !playerSource.includes("this._participantConnectionState.set(user.id, connected === true)") || !playerSource.includes("this._participantConnectionState.get(id) === true") || !playerSource.includes("_onParticipantLeave(userId)")) errors.push("Vote leader must use authoritative connection-hook state and discard stale votes on disconnect/leave");
if (!playerSource.includes("async requestClose()") || !playerSource.includes("VNSocket.leave(this.scene.id, this.leaderId)") || !socketSource.includes('return this.emit("leave", data)')) errors.push("Vote participants must be able to leave locally and notify the leader");
if (!socketSource.includes("_removeSessionParticipant(sceneId, userId)") || !mainSource.includes("leave: (payload, senderId) => VNPlayerApp.handleParticipantLeave(payload.sceneId, senderId)")) errors.push("Socket session membership must remove explicit leavers from quorum and reconnect targets");
if (!playerSource.includes("participantIds: this._voteParticipantIds()") || !playerSource.includes("if (Array.isArray(payload.participantIds))") || !playerSource.includes("this.participantIds = uniqueIds(payload.participantIds)")) errors.push("Vote-state synchronization must carry player-only current membership to all remaining clients");
if (!socketSource.includes('return this.emit("leave", data)') || !socketSource.includes('return this.emit("rejoin", data)')) errors.push("Vote leave/rejoin transport must target the current leader without dropping trust while manual return remains available");
if (!socketSource.includes('Object.prototype.hasOwnProperty.call(data, "targetIds")') || !socketSource.includes("const hasTargetSet = this.activeTargets.has(sceneId)") || !socketSource.includes("return hasTargetSet ? Object.assign(payload, { targetIds }) : payload")) errors.push("Synchronized sessions must preserve explicit empty target lists so a zero-player vote session never broadcasts to former participants");
if (!socketSource.includes("_sendSessionStatusToUser(sceneId, session, user.id)") || !socketSource.includes("eligibleTargetIds.includes(userId)") || !socketSource.includes("resumeState: session.started ? resumeState : null")) errors.push("Disconnected vote participants must remain eligible for reconnect and synchronized resume");
if (!socketSource.includes("const currentSession = this.activeSessions.get(scene.id)") || !socketSource.includes("const currentTargets = Array.isArray(currentSession.targetIds) ? currentSession.targetIds : []") || !socketSource.includes("currentTargets.filter(id => ready.has(id)).length")) errors.push("Preload readiness must use the live session target roster so leaving players cannot force the full timeout");
if (!socketSource.includes("eligibleTargetIds: [...targetIds]") || !socketSource.includes("_restoreSessionParticipant(sceneId, userId)") || !socketSource.includes("_handleRejoinRequest(data, senderId)") || !socketSource.includes("_eligibleTargetIdsForScene(sceneId)")) errors.push("Vote sessions must preserve original return eligibility while separating it from active synchronization targets");
if (!mainSource.includes("rejoin: (payload, senderId) => VNPlayerApp.handleParticipantRejoin(payload.sceneId, senderId)")) errors.push("Main socket routing must deliver explicit vote rejoin requests to the leader player");
if (!playerSource.includes("VNPlayerApp.offerRejoin(this.scene, this.leaderId)") || !playerSource.includes("static requestRejoin(sceneId)") || !playerSource.includes("VNPlayerApp.rejoinOffers = new Map()") || !playerSource.includes("_onParticipantRejoin(userId)")) errors.push("Vote players must receive a persistent manual return control and the leader must restore their roster membership");
if (!socketSource.includes('case "rejoinOffer":') || !socketSource.includes('type === "open" || type === "rejoinOffer"') || !socketSource.includes('this.emit("rejoinOffer"') || !mainSource.includes("rejoinOffer: payload => VNPlayerApp.handleRejoinOffer(payload)") || !playerSource.includes("static handleRejoinOffer(payload)")) errors.push("Explicit leavers who reconnect must recover a trusted manual-return offer without auto-opening the cutscene");
if (!socketSource.includes('return this.emit("sessionStatusRequest", {})') || !socketSource.includes('case "sessionStatusRequest":') || !socketSource.includes("_handleSessionStatusRequest(senderId)") || !socketSource.includes("_sendSessionStatusToUser(sceneId, session, user.id)")) errors.push("Reloaded players must query the GM for active session status after socket registration so return offers cannot be lost");
if (!socketSource.includes("static _scheduleSessionStatusRecovery()") || !socketSource.includes("SESSION_STATUS_RECOVERY_DELAYS = Object.freeze([0, 750, 2500, 6000, 12000])") || !socketSource.includes("_scheduleSessionStatusTail(") || !socketSource.includes("_clearSessionStatusRecovery()")) errors.push("Session-status recovery must retry across startup/reconnect races, continue for a confirmed pending session, and cancel once a trusted GM response is handled successfully");
if (!socketSource.includes("static _isUserConnected(userId)") || !socketSource.includes("this._connectionState.set(user.id, connected === true)") || !socketSource.includes("this._connectionState.set(senderId, true)")) errors.push("GM recall must prefer observed socket connectivity over a potentially stale Foundry user.active flag");
if (!playerSource.includes("const result = await this.close({ force: true, fadeOutMs: Number(this.scene?.audioExitFadeMs || 0) })") || !playerSource.includes("VNPlayerApp._renderRejoinControl();")) errors.push("Voluntary vote-mode leave must render the return control again after the fullscreen player closes");
if (!/\.fbl-vn-rejoin\s*\{[\s\S]*?z-index:\s*100100;/.test(playerCssSource)) errors.push("The persistent return-to-cutscene control must render above Foundry fullscreen and UI layers");
if (!playerTemplateSource.includes('data-action="recallPlayers"') || !playerTemplateSource.includes("Вернуть игроков") || !playerSource.includes("static async _onRecallPlayers") || !playerSource.includes("static async recallScene(payload)") || !socketSource.includes("static async recallPlayers(sceneId)") || !socketSource.includes('this.emit("recall"') || !mainSource.includes("recall: payload => VNPlayerApp.recallScene(payload)")) errors.push("GM synchronized playback must expose a trusted non-disruptive recall path for eligible connected players");
if (!mainSource.includes("open: payload => VNPlayerApp.recallScene(payload)")) errors.push("Duplicate open recovery must route through recallScene so repeated status delivery is idempotent");
if (!playerSource.includes("if (!existing || existing._disposed === true) return VNPlayerApp.openScene(payload)") || !playerSource.includes("const needsPlaybackResume =") || !playerSource.includes("if (stateChanged || participantsChanged) await existing.render()")) errors.push("Existing cutscene players must be reused and synchronized in place without replaying the current frame unnecessarily");
if (!playerSource.includes("this._recallRevision = 0") || !playerSource.includes("const recallRevision = Math.max(0, Number(existing._recallRevision || 0)) + 1") || !playerSource.includes("existing._recallRevision === recallRevision") || !playerSource.includes("await existing.resume(state, { recallRevision })")) errors.push("Recall synchronization must use monotonic revisions so older async recovery work cannot overwrite newer state");
if (!playerSource.includes("async resume(state = {}, options = {})") || !playerSource.includes("const isCurrentResume = () =>") || !playerSource.includes("if (!isCurrentResume()) return;")) errors.push("Reconnect resume must abandon superseded work before rendering stale state");
if (!playerSource.includes("Cutscene startup failed.") || !playerSource.includes("Failed to close player after startup error.") || !playerSource.includes("await app.close({ force: true });")) errors.push("Player startup failures must close the rendered app before propagating the original error");
const openSceneBlock = playerSource.match(/static async openScene\(payload\)[\s\S]*?\n\s*static async previewFrame/)?.[0] || "";
const previewFrameBlock = playerSource.match(/static async previewFrame\(scene, frameId, options = \{\}\)[\s\S]*?\n\s*static async recallScene/)?.[0] || "";
if (!/try\s*\{\s*await app\.render\(true\);/.test(openSceneBlock) || !/try\s*\{\s*await app\.render\(true\);/.test(previewFrameBlock)) errors.push("Initial player and frame-preview renders must be inside startup cleanup guards");
if (!socketSource.includes("const currentSession = this.activeSessions.get(sceneId)") || !socketSource.includes("if (currentSession !== session || currentSession.leaderId !== game.user.id) return 0")) errors.push("GM recall must revalidate the active session after awaited roster restoration");
if (!socketSource.includes("currentSession !== session || currentSession.leaderId !== game.user?.id || !currentSession.targetIds.includes(senderId)")) errors.push("Explicit rejoin must revalidate the same active session after awaited roster restoration before reopening playback");
if (!socketSource.includes('this.emit("close", { sceneId, leaderId, targetIds })') || !socketSource.includes("const targetIds = this._eligibleTargetIdsForScene(sceneId)")) errors.push("GM close must reach locally departed eligible players so their return controls are removed");
if (!playerSource.includes("voteState: app.mode === PLAYER_MODES.VOTE ? app._buildVoteStateFromLeaderVotes() : null") || !playerSource.includes("if (this.mode === PLAYER_MODES.VOTE && state.voteState) this._applyVoteState(state.voteState)")) errors.push("Vote reconnect must restore current quorum and remaining players' votes without restoring the disconnected player's stale vote");
if (!playerTemplateSource.includes("Продолжить (ГМ)") || !playerSource.includes('isVoteOverride ? "Продолжить (ГМ)"')) errors.push("Vote UI must identify the GM priority Continue control");
if (!counterManagerSource.includes("frameEffects") || !counterManagerSource.includes("frame.effectCounterId === counterId")) errors.push("Counter manager must count and clear frame counter effects");
if (!constantsSource.includes('COUNTER_CONDITION_LOGIC') || !constantsSource.includes('ALL: "and"') || !constantsSource.includes('ANY: "or"')) errors.push("Counter condition logic constants must expose AND and OR");
if (!schemaSource.includes("export function createCounterCondition") || !schemaSource.includes("export function evaluateCounterConditions") || !schemaSource.includes("conditionLogic") || !schemaSource.includes("conditions: []")) errors.push("Schema must support canonical compound counter condition groups");
if (!schemaSource.includes("const matched = evaluateCounterConditions(routing.conditions, routing.conditionLogic, counterState)") || !schemaSource.includes("const matched = evaluateCounterConditions(clean.conditions, clean.conditionLogic, counterState)")) errors.push("Runtime routing and choice availability must evaluate compound condition groups");
if (!editorSource.includes("_buildCounterConditionViews(conditions, renderIndex)") || !editorSource.includes("_readCounterConditions(root, rowSelector)") || !editorSource.includes("_counterConditionLogicOptions")) errors.push("Editor must build and read reusable compound counter conditions");
if (!editorFrameTemplateSource.includes('data-action="addNextRoutingCondition"') || !editorFrameTemplateSource.includes('data-next-routing-condition-row') || !editorFrameTemplateSource.includes('name="frame.nextRouting.conditionLogic"')) errors.push("Frame routing UI must expose multiple AND/OR counter conditions");
if (!editorFrameTemplateSource.includes('data-action="addChoiceCondition"') || !editorFrameTemplateSource.includes('data-choice-condition-row') || !editorFrameTemplateSource.includes('data-choice-condition-logic')) errors.push("Choice UI must expose multiple AND/OR availability conditions");
if (!counterManagerSource.includes("for (const condition of Array.isArray(choice.conditions)") || !counterManagerSource.includes("for (const condition of Array.isArray(frame.nextRouting.conditions)")) errors.push("Counter manager must count every compound condition reference");
if (!counterManagerSource.includes(".filter(condition => condition.counterId !== counterId)") || !counterManagerSource.includes("frame.nextRouting.conditions.length === 0")) errors.push("Deleting a counter must remove matching condition rows and disable empty routing");
const treeRowsBlock = editorSource.match(/_buildFrameTreeRows\(scene, frameViews, branchId = ""\)\s*\{([\s\S]*?)\n\s*return rows;\n\s*\}/)?.[1] || "";
if (!treeRowsBlock.includes("shouldRecoverUnvisitedFolder") || !treeRowsBlock.includes("if (folder.collapsed === true) return { hidden: true, broken: false }") || !treeRowsBlock.includes("!shouldRecoverUnvisitedFolder(folder)")) errors.push("Collapsed parent folders must keep nested unvisited folders hidden instead of recovering them at root");
if (!graphSource.includes("const isBranchPoint = links.length !== 1 || links.some(link => link.kind === \"condition\")")) errors.push("Compact graph must keep non-linear counter-routing frames visible");
const compactVisibilityBlock = graphSource.match(/_compactVisibleFrameIds\(scene, frames, outgoing\)\s*\{([\s\S]*?)\n\s*return visible;\n\s*\}/)?.[1] || "";
if (/branchId/.test(compactVisibilityBlock)) errors.push("Compact visibility must not keep linear frames merely because a link crosses editor branches");
if (!compactVisibilityBlock.includes("this._resolveVisibleTarget(link.targetId, visible, outgoing, frameMap)")) errors.push("Compact graph must promote only unresolved hidden cycle stops instead of rendering them as broken links");
if (!graphSource.includes("const frame = record.frame || record;") || graphSource.includes("record.frame.type === FRAME_TYPES.CHOICE")) errors.push("Compact graph resolver must accept both indexed frame records and raw frame values");
if (!graphTemplateSource.includes("data-compact-toggle") || graphTemplateSource.includes('data-action="toggleLinearFrames"')) errors.push("Compact graph control must be a native checkbox without ApplicationV2 action dispatch");
if (!graphSource.includes("_attachPartListeners(partId, htmlElement, options)") || !graphSource.includes('if (partId !== "main") return;') || !graphSource.includes("this._bindCompactToggle(htmlElement)")) errors.push("Compact graph checkbox must bind in the Handlebars part-listener lifecycle");
if (!graphSource.includes('toggle.addEventListener("change"') || !graphSource.includes("event.currentTarget?.checked === true") || !graphSource.includes("await this.render(true)")) errors.push("Compact graph checkbox must read native checked state and force a full rerender");
if (graphSource.includes("toggleLinearFrames: VNGraphApp._onToggleLinearFrames")) errors.push("Compact graph checkbox must not depend on ApplicationV2 action dispatch");
if (!graphSource.includes("this._compactPositions = new Map()") || !graphSource.includes("const stored = compact ? (this._compactPositions.get(frame.id) || null)") || !graphSource.includes("this._compactPositions.set(id, { x, y })")) errors.push("Compact graph must keep a separate session-local position map from the persistent full layout");
if (!graphSource.includes("if (this.hideLinearFrames === true) {\n            this._compactPositions.clear();")) errors.push("Compact graph auto-layout/reset must clear only compact session positions");
if (!graphSource.includes("Kosaraju with explicit stacks") || !graphSource.includes("componentById") || !graphSource.includes("componentEdges") || !graphSource.includes("_calculateAutoPositions")) errors.push("Graph auto-layout must use cycle-aware component ranking and branch lanes");
if (!graphSource.includes("RETURN_EDGE_GAP") || !graphSource.includes("const isReturn = targetLeft <= sourceRight + 18") || !graphSource.includes(" H ") || !graphSource.includes(" V ")) errors.push("Graph edges must use bounded orthogonal routing with a dedicated return lane");
if (!graphSource.includes("let maxReturnIndex = 0") || !graphSource.includes("if (edge.isReturn) maxReturnIndex = Math.max(maxReturnIndex, edge.sourceIndex || 0)") || !graphSource.includes("maxReturnIndex * 16 + 150")) errors.push("Graph canvas must reserve enough width for high-index return lanes");
if (!graphTemplateSource.includes("{{#if isReturn}}is-return{{/if}}") || !/\.graph-edge\.is-return\s*\{/.test(graphCssSource)) errors.push("Return edges must expose a distinct graph class");
const nextRoutingControlBlock = editorSource.match(/_enableNextRoutingControls\(root = this\.element\)\s*\{([\s\S]*?)\n\s*\}\n\n\s*async _persistNextRoutingState/)?.[1] || "";
if (!nextRoutingControlBlock.includes("_enqueueEditorAction") || !nextRoutingControlBlock.includes("_persistNextRoutingState")) errors.push("Counter-routing toggle must persist through the editor action queue");
if (!nextRoutingControlBlock.includes("directFields.hidden = enabled") || !nextRoutingControlBlock.includes("routingFields.hidden = !enabled")) errors.push("Counter-routing toggle must switch its two field groups locally");
if (nextRoutingControlBlock.includes("_renderPendingEditorParts") || nextRoutingControlBlock.includes("_renderEditorParts") || nextRoutingControlBlock.includes("_commitFromForm")) errors.push("Counter-routing toggle must not rerender or recommit the ApplicationV2 editor");
if (!editorSource.includes("async _persistNextRoutingState(enabled)") || !editorSource.includes("await VNSceneStore.upsertScene(clean, { sanitized: true, knownChanged: true })")) errors.push("Counter-routing state must persist without a panel rerender");
if (!nextRoutingControlBlock.includes('toggle.addEventListener("pointerdown", captureBeforeActivation)') || !nextRoutingControlBlock.includes("toggle.blur?.()") || !nextRoutingControlBlock.includes("_captureEditorPosition()") || !nextRoutingControlBlock.includes("_stabilizeEditorPosition(position)")) errors.push("Counter-routing toggle must capture geometry before focus, drop checkbox focus, and preserve ApplicationV2 geometry");
if (!editorSource.includes("_captureEditorPosition()") || !editorSource.includes("_restoreEditorPosition(position)") || !editorSource.includes("this.setPosition(clean)") || !editorSource.includes("globalThis.requestAnimationFrame")) errors.push("Editor must provide an explicit position lock for counter-routing layout changes");
const editorWindowContentRule = editorLayoutCssSource.match(/\.fbl-vn-editor-app\s*>\s*\.window-content\.fbl-vn-editor\s*\{([^}]*)\}/)?.[1] || "";
if (!/flex:\s*1 1 0;/.test(editorWindowContentRule) || !/height:\s*auto;/.test(editorWindowContentRule) || !/min-height:\s*0;/.test(editorWindowContentRule) || !/overflow:\s*hidden;/.test(editorWindowContentRule) || !/contain:\s*size layout paint;/.test(editorWindowContentRule)) errors.push("Editor window-content must use native ApplicationV2 sizing with bounded content containment");
const editorGridRule = editorLayoutCssSource.match(/(?:^|\n)\.fbl-vn-editor\s*\{([^}]*)\}/)?.[1] || "";
if (/height:\s*100%;/.test(editorGridRule)) errors.push("Editor grid must not claim 100% of the framed ApplicationV2 height");
if (!/\.fbl-vn-character-manager\s*\{[\s\S]*?height:\s*100%;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/.test(characterCssSource)) errors.push("Character manager must constrain its grid so the preset list can scroll");
if (!/\.fbl-vn-character-list\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*auto;/.test(characterCssSource)) errors.push("Character preset list must retain vertical scrolling");
if (!constantsSource.includes("DATA_SCHEMA_VERSION = 14")) errors.push("Data schema version must be 14");
if (!migrationSource.includes("function migrateToV11")) errors.push("Schema v11 migration is missing");
if (!migrationSource.includes("function migrateToV12") || !migrationSource.includes("schemaVersion < 12")) errors.push("Schema v12 compound-condition migration is missing");
if (!migrationSource.includes("function migrateToV13") || !migrationSource.includes("schemaVersion < 13") || !migrationSource.includes("audioExitFadeMs")) errors.push("Schema v13 audio timing migration is missing");
if (!migrationSource.includes("function migrateToV14") || !migrationSource.includes("schemaVersion < 14") || !migrationSource.includes("textSpeed") || !migrationSource.includes('portraitPosition === "left"')) errors.push("Schema v14 portrait inheritance/text speed migration is missing");
if (!playerSource.includes("splitTextGraphemes(plainText).length > 900") || !playerSource.includes("splitTextGraphemes(child.data)")) errors.push("Typewriter must count and reveal Unicode grapheme clusters");
if (!playerSource.includes("const charsPerMs = textSpeed / 1000") || !playerSource.includes("_textSpeedForFrame(frame)")) errors.push("Typewriter must honor per-frame text speed");
if (!read("scripts/utils/rich-text.js").includes("export function splitTextGraphemes")) errors.push("Shared grapheme segmentation helper is missing");
if (!schemaSource.includes("export function collectFrameAssetPaths") || !schemaSource.includes("export function collectFrameEntryAssetPaths")) errors.push("Schema must expose full-frame and frame-entry asset collection for progressive preload");
if (!preloaderSource.includes("collectWindowFrameIds") || !preloaderSource.includes("collectWindowPaths") || !preloaderSource.includes("collectStartupWindowPaths")) errors.push("Preloader must build bounded startup and nearby-frame windows");
if (!preloaderSource.includes("STARTUP_WINDOW_DEPTH = 2") || !preloaderSource.includes("STARTUP_WINDOW_MAX_FRAMES = 12")) errors.push("Startup preload window must remain bounded");
if (!preloaderSource.includes("FAR_WARM_DEFAULT_DEPTH = 10") || !preloaderSource.includes("FAR_WARM_MAX_FRAMES = 12") || !preloaderSource.includes("async warmAhead")) errors.push("Preloader must support bounded low-priority deep warming beyond the startup window");
if (!preloaderSource.includes("this.warmGeneration = 0") || !preloaderSource.includes("const generation = ++this.warmGeneration") || !preloaderSource.includes("generation === this.warmGeneration")) errors.push("Deep preload must reprioritize when playback advances");
if (!constantsSource.includes('PRELOAD_AHEAD_DEPTH: "preloadAheadDepth"') || !sceneStoreSource.includes("SETTINGS.PRELOAD_AHEAD_DEPTH") || !sceneStoreSource.includes("default: 10")) errors.push("Long-range preload depth must be configurable as a world setting with default 10");
if (preloaderSource.includes("startBackgroundImages()") || playerSource.includes("startBackgroundImages()")) errors.push("Player must not run an independent whole-scene image sweep alongside bounded graph warming");
if (!preloaderSource.includes("AUDIO_WARMER_LIMIT = 32") || !preloaderSource.includes("this.audioWarmers = new Map()") || !preloaderSource.includes("_retainAudioWarmer(path, audio)") || !preloaderSource.includes("if (this.cancelled)")) errors.push("Audio preload must retain a bounded hidden media cache and release late completions after cancellation");
if (!preloaderSource.includes("this.loaded.delete(oldestPath)")) errors.push("Evicted audio warmers must leave the loaded set so the same path can be warmed again later");
if (!preloaderSource.includes("this.inflight = new Map()") || !preloaderSource.includes("if (this.inflight.has(path))") || !preloaderSource.includes("const result = await this.inflight.get(path)")) errors.push("Preloader must deduplicate concurrent asset requests");
if (!preloaderSource.includes("result?.cancelled && !this.cancelled && (critical || currentGeneration)") || !preloaderSource.includes("generationNumber === this.warmGeneration")) errors.push("Current or critical callers must retry a shared inflight request canceled by stale speculative reprioritization");
if (!preloaderSource.includes("promise.cancel = () => cancelLoad()") || !preloaderSource.includes("_cancelStaleSpeculativeLoads(generation)") || !preloaderSource.includes("for (const cancel of [...this.activeCancels])")) errors.push("Browser asset preloads must be cancellable on timeout, close, and stale speculative generations");
if (!preloaderSource.includes("decodeImages = false") || !preloaderSource.includes("_ensureDecodedImage(path)") || !preloaderSource.includes("image.decode()")) errors.push("Critical image preload must explicitly decode images before first paint while speculative preload remains download-only");
if (preloaderSource.includes("collectBackgroundImagePaths(scene)") || playerSource.includes("_backgroundPreloadPromise")) errors.push("Obsolete whole-scene background preload state must not remain after bounded graph warming");
if (preloaderSource.includes("this.failed = new Map()") || preloaderSource.includes("this.failed.has(path)") || preloaderSource.includes("this.failed.set(path")) errors.push("Transient preload failures must not be cached permanently");
if (!preloaderSource.includes("collectStartupWindowPaths(this.scene, startFrameId") || !preloaderSource.includes("for (const path of VNPreloader.collectFramePaths(frame)) paths.add(path)")) errors.push("Nearby warming must preload all current-frame assets but only frame-entry assets for future frames");
if (!playerSource.includes("this._playbackQueue = Promise.resolve()") || !playerSource.includes("_enqueuePlaybackOperation(operation)") || !playerSource.includes("_applyRemoteAdvance(frameId")) errors.push("Player must serialize remote playback transitions");
if (!playerSource.includes("return app._enqueuePlaybackOperation(() => app._applyRemoteAdvance")) errors.push("Live socket advances must enter the serialized playback queue");
if (!playerSource.includes("app.loading || !app.started || app._starting || app._resuming")) errors.push("Remote advances must stay buffered while startup or reconnect restore is settling");
if (!playerSource.includes("while (this._pendingRemoteFrames.length && !this._disposed)")) errors.push("Pending remote advances must be fully drained, including messages received during the drain");
if (!playerSource.includes("const failedPaths = results.filter") || !playerSource.includes("await this._preloader.ensurePaths(failedPaths")) errors.push("Critical asset preload must immediately retry transient failures once");
if (!playerSource.includes("VNPreloader.collectStartupWindowPaths(this.scene") || playerSource.includes("this._preloader.startBackgroundImages()")) errors.push("Player startup must wait only for the bounded entry-asset window and avoid a separate whole-scene image sweep");
if (!playerSource.includes("await this._ensureFrameAssets(frame, nextTextIndex);") || !playerSource.includes("await this._ensureTextBlockAssets(frame, index);") || !playerSource.includes("this._warmUpcomingAssets(frame);")) errors.push("Frame and text transitions must prioritize only immediately required assets while warming nearby content");
if (!playerSource.includes("this._preloader.warmAhead(frame.id") || !playerSource.includes("SETTINGS.PRELOAD_AHEAD_DEPTH") || !playerSource.includes("Math.max(12, depth + 2)")) errors.push("Player must use configurable deep warming with a bounded total frame window");
if (!schemaSource.includes("repeatCount") || !schemaSource.includes("repeatDelayMs") || !schemaSource.includes("startDelayMs") || !schemaSource.includes("fadeInMs") || !schemaSource.includes("fadeOutMs") || !schemaSource.includes("crossFadeMs") || !schemaSource.includes("continueRepeats")) errors.push("Schema v13 audio cues must expose repeat, delay, fade, crossfade and continuation fields");
const audioControllerSource = read("scripts/playback/vn-audio.js");
if (!audioControllerSource.includes("_retiring = new Set()") || !audioControllerSource.includes("_frameGeneration = 0") || !audioControllerSource.includes("_fadeEntry(entry") || !audioControllerSource.includes("_onEntryEnded(entry)")) errors.push("Audio controller must support overlapping crossfades and generation-bound finite repeats");
const audioFadeBlock = audioControllerSource.match(/_fadeEntry\(entry, targetGain, durationMs\)[\s\S]*?\n\s*pauseExternalAudio\(\)/)?.[0] || "";
if (!audioFadeBlock.includes("setTimeout") || !audioFadeBlock.includes("clearTimeout") || /\brequestAnimationFrame\s*\(/.test(audioFadeBlock) || /\bcancelAnimationFrame\s*\(/.test(audioFadeBlock)) errors.push("Audio fades must use timer-based progression so hidden tabs cannot suspend fade completion");
if (!audioControllerSource.includes("bank.get(entry.channel) !== entry") || !audioControllerSource.includes("this.voice !== voice")) errors.push("Audio playback promises must re-check channel/voice ownership after asynchronous play() resolution");
if (!audioControllerSource.includes("entry.kind === \"music\" ? this.getMusicVolume() : this.getSfxVolume()") || !audioControllerSource.includes("base * Math.max(0, Math.min(1, Number(entry.gain")) errors.push("Audio fades must multiply channel gain over the current Foundry/VN volume");
if (!audioControllerSource.includes("async fadeOutAll") || !playerSource.includes("audioExitFadeMs") || !playerSource.includes("this.audio.fadeOutAll(fadeOutMs)") || !playerSource.includes("this._audioShutdownPromise = audioShutdown.finally")) errors.push("Scene exit must support non-blocking configurable audio fade-out");
if (!audioControllerSource.includes("_externalPauseOwners = new Set()") || !audioControllerSource.includes("VNAudioController._externalPauseOwners.add(this)") || !audioControllerSource.includes("if (VNAudioController._externalPauseOwners.size) return")) errors.push("Overlapping VN audio controllers must share external Foundry audio pause ownership");
if (!editorFrameTemplateSource.includes('data-action="previewAudioCue"') || !editorFrameTemplateSource.includes('data-action="stopAudioPreview"') || !editorFrameTemplateSource.includes("data-audio-repeat-count") || !editorFrameTemplateSource.includes("data-audio-cross-fade") || !editorFrameTemplateSource.includes("На входе (по порядку ветки)")) errors.push("Editor must expose inline audition, advanced audio timing controls, and inherited audio state");
if (!editorSource.includes("_audioStateBeforeFrame") || !editorSource.includes("_audioChangesForFrame") || !editorSource.includes("_onPreviewAudioCue") || !editorSource.includes("_secondsToMs")) errors.push("Editor logic must build audio state summaries and persist second-based timing inputs");
if (editorSource.includes("await this._audioPreview.applyCue")) errors.push("Editor cue audition must not block the action queue while browser play() is pending");
if (!read("templates/editor-scene-head.hbs").includes('name="scene.audioExitFadeSeconds"')) errors.push("Scene editor must expose exit audio fade control");
const preloadInnerBlock = playerSource.match(/async _preloadInner\([\s\S]*?\n\s*async _ensureCriticalPaths/)?.[0] || "";
const preloadRenderIndex = preloadInnerBlock.indexOf("await this.render();");
const preloadReadyIndex = preloadInnerBlock.indexOf("VNSocket.signalReady(this.scene.id, this.leaderId)");
if (preloadRenderIndex < 0 || preloadReadyIndex < 0 || preloadReadyIndex < preloadRenderIndex) errors.push("Client must finish the loading-state render before signaling ready");
if (!playerSource.includes("this._preloader?.cancel()")) errors.push("Closing the player must cancel further background preload scheduling");
const playerCloseBlock = playerSource.match(/async close\(options = \{\}\)[\s\S]*?\n\s*static _onNext/)?.[0] || "";
if (!playerCloseBlock.includes("this._closing = false") || !playerCloseBlock.includes("this._finishing = false")) errors.push("ApplicationV2 close failures must release close/finish guards so the rendered window can be closed on retry");
if (!playerSource.includes("payload.resumeState.visualState?.background") || !playerSource.includes("payload.resumeState.visualState?.portrait") || !playerSource.includes("options.extraPaths || []") || !playerSource.includes("_ensureVisualStateAssets(state = this.visualState)") || !playerSource.includes("this.visualState.background || \"\"") || !playerSource.includes("await existing._ensureVisualStateAssets?.(nextVisualState)")) errors.push("Resume, preview, and in-place reconnect recovery must preload inherited visual-state assets");
if (!playerTemplateSource.includes("Подготовка стартовых ассетов")) errors.push("Loading UI must describe the bounded startup preload rather than the whole scene");
if (!socketSource.includes("options?.reenter === true") || !socketSource.includes("data.reenter = true")) errors.push("Socket advance payload must preserve explicit frame re-entry");
if (!socketSource.includes("[0, 750, 2500, 6000, 12000]")) errors.push("Player session recovery must retry across a longer simultaneous reconnect window");
if (!socketSource.includes("dispatch.then(success =>") || !socketSource.includes("else if (!game.user?.isGM) this._scheduleSessionStatusRecovery()")) errors.push("Reconnect retry timers must remain active until the local recovery handler succeeds");
if (!socketSource.includes("_recoveryDispatchGeneration") || !socketSource.includes("dispatchGeneration !== this._recoveryDispatchGeneration")) errors.push("Recovery dispatch completion must be generation-guarded so older success cannot cancel newer failure recovery");
if (!socketSource.includes('case "sessionStatusPending":') || !socketSource.includes('this.emit("sessionStatusPending"') || !socketSource.includes("_markSessionStatusPending()") || !socketSource.includes("_sessionStatusPersistent")) errors.push("A confirmed active session without a resume snapshot must keep status recovery alive past the initial retry window");
const pendingStatusBlock = socketSource.match(/case "sessionStatusPending":[\s\S]*?break;/)?.[0] || "";
if (!pendingStatusBlock.includes("this._recoveryDispatchGeneration += 1")) errors.push("Pending-session status must invalidate older recovery dispatch completions");
if (!socketSource.includes("user?.id === game.user?.id || user?.isGM === true")) errors.push("Players must restart status recovery when a GM connects after their initial recovery window");
if (!socketSource.includes("currentTargets.filter(id => this._isUserConnected(id))") || !socketSource.includes("this._isUserConnected(user.id)")) errors.push("Launch readiness and target discovery must use the explicit connection-state fallback instead of trusting stale user.active alone");
if (!socketSource.includes("if (session.started && !resumeState)")) errors.push("Started-session recovery must wait for a usable GM resume snapshot instead of opening a stuck client");
if (!mainSource.includes("reenter: payload.reenter === true")) errors.push("Socket handler must forward the frame re-entry flag to the player");
if (!playerSource.includes("const reenter = this.currentFrameId === frame.id") || !playerSource.includes("this.currentFrameId === frameId && options?.reenter !== true")) errors.push("Player must distinguish synchronized self-loop re-entry from same-frame text advances");
if (/\.fbl-vn-speaker\s*\{[\s\S]*?min-width:\s*180px/.test(playerCssSource)) errors.push("Speaker badge must not retain the old fixed minimum width");
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
if (manifest.version !== "1.7.0") errors.push(`Unexpected release version: ${manifest.version}`);
if (!read("README.md").startsWith("# FBL Visual Novel Cutscenes 1.7.0")) errors.push("README release heading is out of sync with manifest");
for (const forbidden of [
  "_applyCharacterPreset(event.currentTarget",
  "_applyCharacterPortrait(event.currentTarget",
  "_handleHeaderAction(event))",
  "_onSelectBranch.call(this, event, event.currentTarget"
]) {
  if (editorSource.includes(forbidden)) errors.push(`Queued editor callback still depends on event.currentTarget: ${forbidden}`);
}
if (!/socketMessageHandler\s*=\s*payload\s*=>\s*this\._onMessage\(payload\)/.test(socketSource) || !/game\.socket\.on\(SOCKET_NAME,\s*socketMessageHandler\)/.test(socketSource)) errors.push("Socket listener must consume the module payload as Foundry's single callback argument");
if (!/const senderId\s*=\s*game\.user\?\.id/.test(socketSource) || !/senderId,\s*\n\s*data/.test(socketSource)) errors.push("Socket payload must publish the current Foundry user id in the module envelope");
if (/game\.socket\.on\(SOCKET_NAME,\s*\(payload,\s*senderId\)/.test(socketSource)) errors.push("Socket listener still relies on a second callback sender-id argument");
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
