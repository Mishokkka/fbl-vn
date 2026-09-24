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
const characterTemplateSource = read("templates/character-manager.hbs");
const editorFrameTemplateSource = read("templates/editor-frame-panel.hbs");
const graphTemplateSource = read("templates/graph.hbs");
const playerTemplateSource = read("templates/player.hbs");
const characterCssSource = read("styles/character-manager.css");
const editorFormsCssSource = read("styles/editor-forms.css");
const editorLayoutCssSource = read("styles/editor-layout.css");
const graphCssSource = read("styles/graph.css");
const playerCssSource = read("styles/player.css");
if (!playerTemplateSource.includes("fbl-vn-dialogue-scroll")) errors.push("Player dialogue must contain a dedicated scroll region");
if (!playerTemplateSource.includes("fbl-vn-dialogue-actions")) errors.push("Player dialogue must contain a fixed action row");
if (!playerTemplateSource.includes("fbl-vn-choice-overlay")) errors.push("Choice buttons must render outside the dialogue box");
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
if (!characterManagerSource.includes("copy.expanded = this.expandedCharacterIds.has(copy.id)")) errors.push("Character manager must preserve expanded cards across rerenders");
if (!characterTemplateSource.includes('<details class="fbl-vn-character-card"') || !characterTemplateSource.includes('<summary class="fbl-vn-character-summary">')) errors.push("Character presets must render as collapsible details/summary cards");
if (!characterTemplateSource.includes("{{#if expanded}}open{{/if}}")) errors.push("Character preset open state must be conditional rather than always expanded");
if (!/\.fbl-vn-character-card\[open\] \.fbl-vn-character-chevron\s*\{[\s\S]*?transform:\s*rotate\(90deg\)/.test(characterCssSource)) errors.push("Expanded character cards must expose a visible disclosure state");
if (!schemaSource.includes("export function createFrameCharacter")) errors.push("Frame schema must expose additional character records");
if (!schemaSource.includes("clean.additionalCharacters = Array.isArray(clean.additionalCharacters)")) errors.push("Frame sanitization must normalize additional characters");
if (!editorFrameTemplateSource.includes('data-action="addFrameCharacter"') || !editorFrameTemplateSource.includes('data-action="deleteFrameCharacter"') || !editorFrameTemplateSource.includes("data-additional-character-row")) errors.push("Frame editor must expose add/remove character rows");
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
if (!playerSource.includes("this._applyFrameEffect(frame);") || !playerSource.includes("applyFrameCounterEffect")) errors.push("Player must apply a frame counter effect on frame entry");
if (!playerSource.includes("static async previewFrame(scene, frameId, options = {})") || !playerSource.includes("async startFramePreview(frameId, options = {})") || !playerSource.includes("_findBranchPreviewPath(targetFrameId, branchId = \"\")") || !playerSource.includes("_findPreviewPath(targetFrameId)") || !playerSource.includes("_warmFramePreview(previewPath)")) errors.push("Player must support selected-frame preview with current-branch inherited state and graph fallback");
if (!playerSource.includes("AUDIO_ACTIONS") || !playerSource.includes('_applyPreviewCueState(music, frame.musicCues, "music")') || !playerSource.includes('_applyPreviewCueState(sfx, frame.sfxCues, "sfx")')) errors.push("Selected-frame preview must reconstruct inherited audio channel state");
if (!playerSource.includes('.filter(frame => (frame.branchId || "") === currentBranchId)') || !playerSource.includes('return { steps, counterState, branchId: currentBranchId, source: "branch" }')) errors.push("Selected-frame preview must reconstruct deterministic inherited state from preceding frames in the current editor branch");
if (!editorSource.includes('["previewFrame", "Просмотреть выбранный кадр"') || !editorSource.includes("static async _onPreviewFrame(event, target)") || !editorSource.includes("const branchId = this.selectedBranchId || frame.branchId || \"\"") || !editorSource.includes("VNPlayerApp.previewFrame(scene, frame.id, { branchId })")) errors.push("Editor header must preview the selected frame in the current editor branch through the real player");
if (!playerSource.includes("_isGmVoteOverride()") || !playerSource.includes("return this._resolveGmVoteOverride({ action: \"continue\" })") || !playerSource.includes('return this._resolveGmVoteOverride({ action: "choice", choiceId })')) errors.push("Vote mode must give the leader GM an immediate override path without treating the GM as a voter");
if (!playerSource.includes("_voteParticipantIds()") || !playerSource.includes("user.isGM !== true") || !socketSource.includes("mode === PLAYER_MODES.VOTE ? players : [game.user.id, ...players]")) errors.push("Vote quorum must contain non-GM players only");
if (!playerSource.includes("this._inactiveParticipantIds = new Set()") || !playerSource.includes("this._inactiveParticipantIds.add(user.id)") || !playerSource.includes("this._inactiveParticipantIds.delete(user.id)") || !playerSource.includes("_onParticipantLeave(userId)")) errors.push("Vote leader must track disconnects explicitly and discard stale votes on disconnect/leave");
if (!playerSource.includes("async requestClose()") || !playerSource.includes("VNSocket.leave(this.scene.id, this.leaderId)") || !socketSource.includes('return this.emit("leave", data)')) errors.push("Vote participants must be able to leave locally and notify the leader");
if (!socketSource.includes("_removeSessionParticipant(sceneId, userId)") || !mainSource.includes("leave: (payload, senderId) => VNPlayerApp.handleParticipantLeave(payload.sceneId, senderId)")) errors.push("Socket session membership must remove explicit leavers from quorum and reconnect targets");
if (!playerSource.includes("participantIds: this._voteParticipantIds()") || !playerSource.includes("if (Array.isArray(payload.participantIds))") || !playerSource.includes("this.participantIds = uniqueIds(payload.participantIds)")) errors.push("Vote-state synchronization must carry player-only current membership to all remaining clients");
if (!socketSource.includes('this.activeLeaders.delete(sceneId)') || !socketSource.includes('const sent = this.emit("leave", data)')) errors.push("A client that explicitly leaves a vote session must clear stale local leader trust");
if (!socketSource.includes('Object.prototype.hasOwnProperty.call(data, "targetIds")') || !socketSource.includes("const hasTargetSet = this.activeTargets.has(sceneId)") || !socketSource.includes("return hasTargetSet ? Object.assign(payload, { targetIds }) : payload")) errors.push("Synchronized sessions must preserve explicit empty target lists so a zero-player vote session never broadcasts to former participants");
if (!socketSource.includes("session.targetIds.includes(user.id)") || !socketSource.includes("resumeState: session.started ? resumeState : null")) errors.push("Disconnected vote participants must remain eligible for reconnect and synchronized resume");
if (!playerSource.includes("voteState: app.mode === PLAYER_MODES.VOTE ? app._buildVoteStateFromLeaderVotes() : null") || !playerSource.includes("if (this.mode === PLAYER_MODES.VOTE && state.voteState) this._applyVoteState(state.voteState)")) errors.push("Vote reconnect must restore current quorum and remaining players' votes without restoring the disconnected player's stale vote");
if (!playerTemplateSource.includes("Продолжить (ГМ)") || !playerSource.includes('isVoteOverride ? "Продолжить (ГМ)"')) errors.push("Vote UI must identify the GM priority Continue control");
if (!counterManagerSource.includes("frameEffects") || !counterManagerSource.includes("frame.effectCounterId === counterId")) errors.push("Counter manager must count and clear frame counter effects");
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
if (!editorSource.includes("async _persistNextRoutingState(enabled)") || !editorSource.includes("await VNSceneStore.upsertScene(clean)")) errors.push("Counter-routing state must persist without a panel rerender");
if (!nextRoutingControlBlock.includes('toggle.addEventListener("pointerdown", captureBeforeActivation)') || !nextRoutingControlBlock.includes("toggle.blur?.()") || !nextRoutingControlBlock.includes("_captureEditorPosition()") || !nextRoutingControlBlock.includes("_stabilizeEditorPosition(position)")) errors.push("Counter-routing toggle must capture geometry before focus, drop checkbox focus, and preserve ApplicationV2 geometry");
if (!editorSource.includes("_captureEditorPosition()") || !editorSource.includes("_restoreEditorPosition(position)") || !editorSource.includes("this.setPosition(clean)") || !editorSource.includes("globalThis.requestAnimationFrame")) errors.push("Editor must provide an explicit position lock for counter-routing layout changes");
const editorWindowContentRule = editorLayoutCssSource.match(/\.fbl-vn-editor-app\s*>\s*\.window-content\.fbl-vn-editor\s*\{([^}]*)\}/)?.[1] || "";
if (!/flex:\s*1 1 0;/.test(editorWindowContentRule) || !/height:\s*auto;/.test(editorWindowContentRule) || !/min-height:\s*0;/.test(editorWindowContentRule) || !/overflow:\s*hidden;/.test(editorWindowContentRule) || !/contain:\s*size layout paint;/.test(editorWindowContentRule)) errors.push("Editor window-content must use native ApplicationV2 sizing with bounded content containment");
const editorGridRule = editorLayoutCssSource.match(/(?:^|\n)\.fbl-vn-editor\s*\{([^}]*)\}/)?.[1] || "";
if (/height:\s*100%;/.test(editorGridRule)) errors.push("Editor grid must not claim 100% of the framed ApplicationV2 height");
if (!/\.fbl-vn-character-manager\s*\{[\s\S]*?height:\s*100%;[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/.test(characterCssSource)) errors.push("Character manager must constrain its grid so the preset list can scroll");
if (!/\.fbl-vn-character-list\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*auto;/.test(characterCssSource)) errors.push("Character preset list must retain vertical scrolling");
if (!constantsSource.includes("DATA_SCHEMA_VERSION = 11")) errors.push("Data schema version must be 11");
if (!migrationSource.includes("function migrateToV11")) errors.push("Schema v11 migration is missing");
if (!playerSource.includes("splitTextGraphemes(plainText).length > 900") || !playerSource.includes("splitTextGraphemes(child.data)")) errors.push("Typewriter must count and reveal Unicode grapheme clusters");
if (!read("scripts/utils/rich-text.js").includes("export function splitTextGraphemes")) errors.push("Shared grapheme segmentation helper is missing");
if (!schemaSource.includes("export function collectFrameAssetPaths") || !schemaSource.includes("export function collectFrameEntryAssetPaths")) errors.push("Schema must expose full-frame and frame-entry asset collection for progressive preload");
if (!preloaderSource.includes("collectWindowFrameIds") || !preloaderSource.includes("collectWindowPaths") || !preloaderSource.includes("collectStartupWindowPaths")) errors.push("Preloader must build bounded startup and nearby-frame windows");
if (!preloaderSource.includes("STARTUP_WINDOW_DEPTH = 2") || !preloaderSource.includes("STARTUP_WINDOW_MAX_FRAMES = 12")) errors.push("Startup preload window must remain bounded");
if (!preloaderSource.includes("BACKGROUND_CONCURRENCY = 1") || !preloaderSource.includes("collectBackgroundImagePaths")) errors.push("Whole-scene background preload must be image-only and leave network headroom");
if (!preloaderSource.includes("this.inflight = new Map()") || !preloaderSource.includes("if (this.inflight.has(path)) return this.inflight.get(path)")) errors.push("Preloader must deduplicate concurrent asset requests");
if (preloaderSource.includes("this.failed = new Map()") || preloaderSource.includes("this.failed.has(path)") || preloaderSource.includes("this.failed.set(path")) errors.push("Transient preload failures must not be cached permanently");
if (!preloaderSource.includes("collectStartupWindowPaths(this.scene, startFrameId") || !preloaderSource.includes("for (const path of VNPreloader.collectFramePaths(frame)) paths.add(path)")) errors.push("Nearby warming must preload all current-frame assets but only frame-entry assets for future frames");
if (!playerSource.includes("this._playbackQueue = Promise.resolve()") || !playerSource.includes("_enqueuePlaybackOperation(operation)") || !playerSource.includes("_applyRemoteAdvance(frameId")) errors.push("Player must serialize remote playback transitions");
if (!playerSource.includes("return app._enqueuePlaybackOperation(() => app._applyRemoteAdvance")) errors.push("Live socket advances must enter the serialized playback queue");
if (!playerSource.includes("app.loading || !app.started || app._starting || app._resuming")) errors.push("Remote advances must stay buffered while startup or reconnect restore is settling");
if (!playerSource.includes("while (this._pendingRemoteFrames.length && !this._disposed)")) errors.push("Pending remote advances must be fully drained, including messages received during the drain");
if (!playerSource.includes("const failedPaths = results.filter") || !playerSource.includes("await this._preloader.ensurePaths(failedPaths")) errors.push("Critical asset preload must immediately retry transient failures once");
if (!playerSource.includes("VNPreloader.collectStartupWindowPaths(this.scene") || !playerSource.includes("this._preloader.startBackgroundImages()")) errors.push("Player startup must wait only for entry assets in the critical window and then background-load images");
if (!playerSource.includes("await this._ensureFrameAssets(frame, nextTextIndex);") || !playerSource.includes("await this._ensureTextBlockAssets(frame, index);") || !playerSource.includes("this._warmUpcomingAssets(frame);")) errors.push("Frame and text transitions must prioritize only immediately required assets while warming nearby content");
if (!playerSource.includes("warmWindow(frame.id, { depth: 2, maxFrames: 12, concurrency: 2 })")) errors.push("Speculative nearby preload must leave browser network headroom for critical requests");
const preloadInnerBlock = playerSource.match(/async _preloadInner\([\s\S]*?\n\s*async _ensureCriticalPaths/)?.[0] || "";
const preloadRenderIndex = preloadInnerBlock.indexOf("await this.render();");
const preloadReadyIndex = preloadInnerBlock.indexOf("VNSocket.signalReady(this.scene.id, this.leaderId)");
if (preloadRenderIndex < 0 || preloadReadyIndex < 0 || preloadReadyIndex < preloadRenderIndex) errors.push("Client must finish the loading-state render before signaling ready");
if (!playerSource.includes("this._preloader?.cancel()")) errors.push("Closing the player must cancel further background preload scheduling");
if (!playerSource.includes("payload.resumeState.visualState?.background") || !playerSource.includes("payload.resumeState.visualState?.portrait") || !playerSource.includes("options.extraPaths || []")) errors.push("Resume preload must include inherited visual-state assets");
if (!playerTemplateSource.includes("Подготовка стартовых ассетов")) errors.push("Loading UI must describe the bounded startup preload rather than the whole scene");
if (!socketSource.includes("options?.reenter === true") || !socketSource.includes("data.reenter = true")) errors.push("Socket advance payload must preserve explicit frame re-entry");
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
if (manifest.version !== "1.6.12") errors.push(`Unexpected release version: ${manifest.version}`);
if (!read("README.md").startsWith("# FBL Visual Novel Cutscenes 1.6.12")) errors.push("README release heading is out of sync with manifest");
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
