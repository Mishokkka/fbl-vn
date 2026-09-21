import { VNSceneStore } from "../data/scene-store.js";
import { clearFrameReferences, createAudioCue, createChoice, createFrame, createFrameCharacter, createFrameFolder, createSampleScene, createScene, createSceneBranch, createTextBlock, frameDisplayName, getFrameReferences, getFrameTextBlocks, sanitizeFolderColor, sanitizeScene, validateScene } from "../data/schema.js";
import { VNSocket } from "../playback/vn-socket.js";
import { VNPlayerApp } from "./vn-player-app.js";
import { VNAssetPickerApp } from "./asset-picker-app.js";
import { VNCharacterManagerApp } from "./vn-character-manager-app.js";
import { VNCounterManagerApp } from "./vn-counter-manager-app.js";
import { VNGraphApp } from "./vn-graph-app.js";
import { AUDIO_ACTIONS, COUNTER_EFFECTS, COUNTER_OPERATORS, FRAME_TYPES, MODULE_ID, PLAYER_MODES, TEXT_PRESENTATIONS, VIGNETTE_MODES } from "../utils/constants.js";
import { confirmDialog, downloadJson, duplicateData, escapeHtml, formDialog, notify, notifyError, notifyWarn, randomId, readJsonFile } from "../utils/foundry-helpers.js";
import { richTextFromPlainText, richTextToPlainText, sanitizeRichTextHtml } from "../utils/rich-text.js";

const ApplicationV2 = foundry.applications.api.ApplicationV2;
const HandlebarsApplicationMixin = foundry.applications.api.HandlebarsApplicationMixin;

const EDITOR_CONTEXT_STATE = Symbol("fblVnEditorContextState");
const EDITOR_PART_IDS = Object.freeze([
    "resources",
    "scenes",
    "frames",
    "sceneHead",
    "framePanel",
    "bottomActions",
    "empty"
]);
const EDITOR_WORKSPACE_PART_IDS = Object.freeze(["resources", "scenes", "frames", "sceneHead", "framePanel"]);

function queuedEditorAction(handler) {
    return function queuedAction(event, target) {
        return this._enqueueEditorAction(() => handler.call(this, event, target));
    };
}

export class VNEditorApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(options = {}) {
        super(options);
        const scenes = VNSceneStore.scenes;
        const firstScene = scenes[0] ? scenes[0] : null;
        this.selectedSceneId = options.sceneId !== undefined ? options.sceneId : (firstScene ? firstScene.id : null);
        const selectedScene = VNSceneStore.getScene(this.selectedSceneId);
        this.selectedFrameId = options.frameId !== undefined ? options.frameId : (selectedScene ? selectedScene.startFrame : null);
        this.selectedBranchId = options.branchId !== undefined ? options.branchId : null;
        this.selectedFolderId = options.folderId !== undefined ? options.folderId : null;
        this.editingFolderId = options.editingFolderId !== undefined ? options.editingFolderId : null;
        this._dragFrameId = null;
        this._dragTreeItem = null;
        this._pendingRenderParts = new Set();
        this._actionQueue = Promise.resolve();
        this._renderQueue = Promise.resolve();
        this._lastValidationSnapshot = null;
        this._lastFrameTargetSceneId = null;
        this._lastFrameTargetEntries = null;
    }

    _enqueueEditorAction(operation) {
        const execute = async () => {
            const result = await operation();
            await this._renderQueue;
            return result;
        };
        const run = this._actionQueue.then(execute, execute);
        this._actionQueue = run.catch(error => {
            console.error(`${MODULE_ID} | Editor action failed.`, error);
        });
        return run;
    }

    get selectedScene() {
        return VNSceneStore.getScene(this.selectedSceneId);
    }

    get selectedFrame() {
        const scene = this.selectedScene;
        if (!scene || !Array.isArray(scene.frames) || !scene.frames.length) return null;
        const found = scene.frames.find(frame => frame.id === this.selectedFrameId);
        return found || scene.frames[0];
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const state = this._prepareEditorState();
        const issues = state.selectedScene ? this._issuesForState(state) : [];
        this._lastValidationSnapshot = { sceneId: state.selectedScene?.id || null, issues };
        Object.defineProperty(context, EDITOR_CONTEXT_STATE, { value: state, configurable: true });
        return Object.assign(context, {
            selectedScene: state.selectedScene,
            selectedFrame: state.selectedFrame,
            hasScenes: state.scenes.length > 0
        });
    }

    async _preparePartContext(partId, context, options) {
        const partContext = await super._preparePartContext(partId, context, options);
        const state = context[EDITOR_CONTEXT_STATE] || this._prepareEditorState();
        return Object.assign(partContext, {
            selectedScene: state.selectedScene,
            selectedFrame: state.selectedFrame,
            hasScenes: state.scenes.length > 0
        }, this._buildPartContext(partId, state));
    }

    _prepareEditorState() {
        const scenes = VNSceneStore.scenes;
        let selectedScene = scenes.find(scene => scene.id === this.selectedSceneId) || scenes[0] || null;
        if (selectedScene && selectedScene.id !== this.selectedSceneId) this.selectedSceneId = selectedScene.id;
        let selectedFrame = selectedScene && Array.isArray(selectedScene.frames)
            ? selectedScene.frames.find(frame => frame.id === this.selectedFrameId) || selectedScene.frames[0] || null
            : null;
        this._syncSelectedBranch(selectedScene, selectedFrame);
        if (selectedScene && selectedFrame && selectedFrame.branchId !== this.selectedBranchId) {
            const branchFrame = (selectedScene.frames || []).find(frame => frame.branchId === this.selectedBranchId);
            if (branchFrame) {
                this.selectedFrameId = branchFrame.id;
                selectedFrame = branchFrame;
            }
            else {
                this.selectedFrameId = null;
                selectedFrame = null;
            }
        }
        if (selectedFrame && selectedFrame.id !== this.selectedFrameId) this.selectedFrameId = selectedFrame.id;
        const activeBranch = this._activeBranch(selectedScene);
        const activeBranchId = activeBranch ? activeBranch.id : "";
        this._syncSelectedFolder(selectedScene, selectedFrame);
        return {
            scenes,
            selectedScene,
            selectedFrame,
            activeBranch,
            activeBranchId,
            issues: null,
            renderIndex: null,
            frameViews: null,
            characters: null,
            characterById: null
        };
    }

    _issuesForState(state) {
        if (!state.issues) state.issues = validateScene(state.selectedScene);
        return state.issues;
    }

    _renderIndexForState(state) {
        if (!state.renderIndex) state.renderIndex = this._buildRenderIndex(state.selectedScene, this._issuesForState(state));
        this._lastFrameTargetSceneId = state.selectedScene?.id || null;
        this._lastFrameTargetEntries = state.renderIndex.frameTargetEntries;
        return state.renderIndex;
    }

    _frameViewsForState(state) {
        if (!state.frameViews) {
            const renderIndex = this._renderIndexForState(state);
            state.frameViews = this._buildFrameViews(state.selectedScene, renderIndex.issuesByFrame, state.activeBranchId);
        }
        return state.frameViews;
    }

    _charactersForState(state) {
        if (!state.characters) {
            state.characters = VNSceneStore.characters;
            state.characterById = new Map(state.characters.map(character => [character.id, character]));
        }
        return state.characters;
    }

    _buildPartContext(partId, state) {
        const scene = state.selectedScene;
        const frame = state.selectedFrame;
        if (partId === "resources") {
            return { frameTargetEntries: this._renderIndexForState(state).frameTargetEntries };
        }
        if (partId === "scenes") {
            return {
                scenes: state.scenes.map(item => ({
                    id: item.id,
                    title: item.title,
                    selected: item.id === this.selectedSceneId,
                    frameCount: Array.isArray(item.frames) ? item.frames.length : 0
                }))
            };
        }
        if (partId === "frames") {
            const renderIndex = this._renderIndexForState(state);
            const frameViews = this._frameViewsForState(state);
            const frameTreeRows = this._buildFrameTreeRows(scene, frameViews);
            const selectedFolderId = frame && frame.branchId === state.activeBranchId ? frame.folderId || "" : "";
            const activeFolderId = this.selectedFolderId || selectedFolderId || "";
            const activeFolder = renderIndex.folderById.get(activeFolderId) || null;
            return {
                frameTreeRows,
                hasFrameTreeRows: frameTreeRows.length > 0,
                branchOptions: this._branchOptions(scene, state.activeBranchId),
                activeBranch: state.activeBranch,
                canDeleteBranch: Boolean(scene && Array.isArray(scene.branches) && scene.branches.length > 1),
                hasSelectedFolder: Boolean(activeFolder)
            };
        }
        if (partId === "sceneHead") {
            const renderIndex = this._renderIndexForState(state);
            return {
                modeOptions: this._options([
                    [PLAYER_MODES.INDIVIDUAL, "Каждый читает сам"],
                    [PLAYER_MODES.GM, "ГМ ведёт синхронно"],
                    [PLAYER_MODES.VOTE, "Голосование игроков"]
                ], scene ? scene.defaultMode : undefined),
                startFrameTarget: this._frameTargetDisplayFromIndex(renderIndex, scene ? scene.startFrame : "", ""),
                startFrameInvalid: renderIndex.errorKeys.has("::scene.startFrame")
            };
        }
        if (partId === "framePanel") {
            const renderIndex = this._renderIndexForState(state);
            const characters = this._charactersForState(state);
            const selectedCharacter = frame && frame.characterId ? state.characterById.get(frame.characterId) || null : null;
            const selectedTextBlocks = this._buildTextBlockViews(frame);
            const selectedMusicCues = this._buildAudioCueViews(frame?.musicCues, "music");
            const selectedSfxCues = this._buildAudioCueViews(frame?.sfxCues, "sfx");
            const selectedFolderId = frame && frame.branchId === state.activeBranchId ? frame.folderId || "" : "";
            const nextRouting = frame?.nextRouting || {};
            return {
                folderOptions: this._folderOptions(scene, selectedFolderId, state.activeBranchId),
                frameBranchOptions: this._branchOptions(scene, frame ? frame.branchId || state.activeBranchId : state.activeBranchId),
                counterOptions: this._counterOptionsFromBase(renderIndex.counterOptionsBase, "", true),
                frameNextTarget: this._frameTargetDisplayFromIndex(renderIndex, frame ? frame.next : "", "Следующий кадр по списку"),
                frameTypeOptions: this._options([
                    [FRAME_TYPES.DIALOGUE, "Реплика"],
                    [FRAME_TYPES.NARRATION, "Наррация"],
                    [FRAME_TYPES.CHOICE, "Выбор"]
                ], frame ? frame.type : undefined),
                selectedMusicCues,
                selectedSfxCues,
                musicChannelOptions: this._audioChannelOptions(scene, "music"),
                sfxChannelOptions: this._audioChannelOptions(scene, "sfx"),
                positionOptions: this._options([
                    ["left", "Слева"],
                    ["center", "По центру"],
                    ["right", "Справа"]
                ], frame ? frame.portraitPosition : undefined),
                transitionOptions: this._options([
                    ["none", "Нет"],
                    ["fade", "Fade"],
                    ["dark", "Затемнение"]
                ], frame ? frame.transition : "none"),
                vignetteOptions: this._options([
                    [VIGNETTE_MODES.AUTO, "Авто"],
                    [VIGNETTE_MODES.SCREEN, "По краям кадра"],
                    [VIGNETTE_MODES.TEXT, "Вокруг текста"],
                    [VIGNETTE_MODES.NONE, "Нет"]
                ], frame ? frame.vignetteMode : VIGNETTE_MODES.NONE),
                textPresentationOptions: this._options([
                    [TEXT_PRESENTATIONS.BOX, "Обычная панель"],
                    [TEXT_PRESENTATIONS.CENTER, "Текст по центру без панели"]
                ], frame ? frame.textPresentation : TEXT_PRESENTATIONS.BOX),
                richTextFontOptions: this._richTextFontOptions(),
                characters,
                hasCharacters: characters.length > 0,
                characterOptions: this._characterOptions(characters, frame ? frame.characterId : ""),
                characterPortraitOptions: this._characterPortraitOptions(selectedCharacter, frame ? frame.portraitId : ""),
                additionalFrameCharacters: this._buildAdditionalCharacterViews(frame, characters, state.characterById),
                selectedTextBlocks,
                hasMultipleTextBlocks: selectedTextBlocks.length > 1,
                selectedChoices: this._buildChoiceViews(frame, renderIndex),
                isChoice: frame && frame.type === FRAME_TYPES.CHOICE,
                frameNextInvalid: renderIndex.errorKeys.has(`${frame ? frame.id : ""}::frame.next`),
                frameEffectCounterOptions: this._counterOptionsFromBase(renderIndex.counterOptionsBase, frame ? frame.effectCounterId || "" : "", true),
                frameEffectOperationOptions: this._counterEffectOptions(frame ? frame.effectOperation || "" : ""),
                nextRouting,
                nextRoutingEnabled: nextRouting.enabled === true,
                nextRoutingCounterOptions: this._counterOptionsFromBase(renderIndex.counterOptionsBase, nextRouting.counterId || "", true),
                nextRoutingOperatorOptions: this._counterConditionOptions(nextRouting.operator || COUNTER_OPERATORS.GTE).filter(option => option.value),
                nextRoutingTrueTarget: this._frameTargetDisplayFromIndex(renderIndex, nextRouting.trueFrameId || "", "Следующий кадр по списку"),
                nextRoutingFalseTarget: this._frameTargetDisplayFromIndex(renderIndex, nextRouting.falseFrameId || "", "Следующий кадр по списку"),
                nextRoutingTrueInvalid: renderIndex.errorKeys.has(`${frame ? frame.id : ""}::frame.nextRouting.trueFrameId`),
                nextRoutingFalseInvalid: renderIndex.errorKeys.has(`${frame ? frame.id : ""}::frame.nextRouting.falseFrameId`)
            };
        }
        return {};
    }

    _buildRenderIndex(scene, issues) {
        const frames = scene && Array.isArray(scene.frames) ? scene.frames : [];
        const folders = scene && Array.isArray(scene.frameFolders) ? scene.frameFolders : [];
        const counters = scene && Array.isArray(scene.counters) ? scene.counters : [];
        const frameTargetEntries = this._frameTargetEntries(scene);
        const issuesByFrame = new Map();
        const issuesByChoice = new Map();
        const sceneIssues = [];
        const errorKeys = new Set();
        let validationErrorCount = 0;
        let validationWarningCount = 0;
        for (const issue of issues) {
            if (issue.severity === "error") validationErrorCount += 1;
            if (issue.severity === "warning") validationWarningCount += 1;
            if (!issue.frameId) sceneIssues.push(issue);
            else {
                if (!issuesByFrame.has(issue.frameId)) issuesByFrame.set(issue.frameId, []);
                issuesByFrame.get(issue.frameId).push(issue);
            }
            if (issue.frameId && issue.choiceId) {
                const key = `${issue.frameId}:${issue.choiceId}`;
                if (!issuesByChoice.has(key)) issuesByChoice.set(key, []);
                issuesByChoice.get(key).push(issue);
            }
            if (issue.severity === "error") errorKeys.add(`${issue.frameId || ""}:${issue.choiceId || ""}:${issue.field || ""}`);
        }
        return {
            frameById: new Map(frames.map(frame => [frame.id, frame])),
            frameIdSet: new Set(frames.map(frame => frame.id)),
            folderById: new Map(folders.map(folder => [folder.id, folder])),
            counterById: new Map(counters.map(counter => [counter.id, counter])),
            counterOptionsBase: counters.map(counter => ({ value: counter.id, label: counter.name || counter.id })),
            frameTargetEntries,
            frameTargetById: new Map(frameTargetEntries.map(entry => [entry.id, entry])),
            issuesByFrame,
            issuesByChoice,
            sceneIssues,
            errorKeys,
            validationErrorCount,
            validationWarningCount
        };
    }

    _buildFrameViews(scene, issuesByFrame, branchId = "") {
        const frames = scene && Array.isArray(scene.frames) ? scene.frames.filter(frame => !branchId || frame.branchId === branchId) : [];
        return frames.map((frame, index) => {
            const frameIssues = issuesByFrame.get(frame.id) || [];
            const label = frameDisplayName(frame);
            return Object.assign({}, frame, {
                index: index + 1,
                selected: frame.id === this.selectedFrameId,
                label,
                typeLabel: this._frameTypeLabel(frame.type),
                issueCount: frameIssues.length,
                hasIssue: frameIssues.length > 0,
                hasError: frameIssues.some(issue => issue.severity === "error"),
                hasWarning: frameIssues.some(issue => issue.severity === "warning")
            });
        });
    }

    _activeBranch(scene) {
        const branches = scene && Array.isArray(scene.branches) ? scene.branches : [];
        return branches.find(branch => branch.id === this.selectedBranchId) || branches[0] || null;
    }

    _syncSelectedBranch(scene, selectedFrame) {
        const branches = scene && Array.isArray(scene.branches) ? scene.branches : [];
        if (!branches.length) {
            this.selectedBranchId = null;
            return;
        }
        if (this.selectedBranchId && branches.some(branch => branch.id === this.selectedBranchId)) return;
        if (selectedFrame && selectedFrame.branchId && branches.some(branch => branch.id === selectedFrame.branchId)) {
            this.selectedBranchId = selectedFrame.branchId;
            return;
        }
        const start = scene.frames && scene.frames.find(frame => frame.id === scene.startFrame);
        if (start && start.branchId && branches.some(branch => branch.id === start.branchId)) {
            this.selectedBranchId = start.branchId;
            return;
        }
        this.selectedBranchId = branches[0].id;
    }

    _branchOptions(scene, selectedBranchId = "") {
        const branches = scene && Array.isArray(scene.branches) ? scene.branches : [];
        return branches.map((branch, index) => ({
            value: branch.id,
            label: branch.name || `Ветка ${index + 1}`,
            selected: branch.id === selectedBranchId
        }));
    }

    _syncSelectedFolder(scene, selectedFrame) {
        const branchId = this.selectedBranchId || "";
        const folders = scene && Array.isArray(scene.frameFolders) ? scene.frameFolders.filter(folder => !branchId || folder.branchId === branchId) : [];
        if (this.selectedFolderId && !folders.some(folder => folder.id === this.selectedFolderId)) this.selectedFolderId = null;
        if (!this.selectedFolderId && selectedFrame && selectedFrame.branchId === branchId && selectedFrame.folderId) this.selectedFolderId = selectedFrame.folderId;
    }

    _buildFrameTreeRows(scene, frameViews) {
        if (!scene) return [];
        const branchId = this.selectedBranchId || (frameViews[0] ? frameViews[0].branchId || "" : "");
        const folders = Array.isArray(scene.frameFolders) ? scene.frameFolders.filter(folder => !branchId || folder.branchId === branchId) : [];
        const folderMap = new Map(folders.map(folder => [folder.id, folder]));
        const childrenByParent = new Map();
        const addChild = (parentId, item) => {
            const key = parentId || "";
            if (!childrenByParent.has(key)) childrenByParent.set(key, []);
            childrenByParent.get(key).push(item);
        };
        for (const folder of folders) {
            addChild(folder.parentId || "", {
                kind: "folder",
                sort: Number(folder.sort || 0),
                name: folder.name || "Папка",
                id: folder.id,
                folder
            });
        }
        for (const frame of frameViews) {
            addChild(frame.folderId || "", {
                kind: "frame",
                sort: Number(frame.sort || 0),
                name: frame.label || frame.id,
                id: frame.id,
                frame
            });
        }
        for (const items of childrenByParent.values()) {
            items.sort((a, b) => a.sort !== b.sort ? a.sort - b.sort : String(a.name).localeCompare(String(b.name)));
        }

        const rows = [];
        const visitedFolders = new Set();
        const visitedFrames = new Set();
        const shouldRecoverUnvisitedFrame = frame => {
            let folderId = frame && frame.folderId ? frame.folderId : "";
            if (!folderId) return true;
            const seen = new Set();
            while (folderId) {
                if (seen.has(folderId)) return true;
                seen.add(folderId);
                const folder = folderMap.get(folderId);
                if (!folder) return true;
                if (folder.collapsed === true) return false;
                folderId = folder.parentId || "";
            }
            return true;
        };
        const folderRow = (folder, depth, parentId = folder.parentId || "") => {
            const collapsed = folder.collapsed === true;
            const color = sanitizeFolderColor(folder.color);
            return {
                id: folder.id,
                kind: "folder",
                isFolder: true,
                isFrame: false,
                depth,
                indent: depth * 16,
                name: folder.name || "Папка",
                color,
                styleColor: color,
                selected: folder.id === this.selectedFolderId,
                isEditing: folder.id === this.editingFolderId,
                collapsed,
                expanded: !collapsed,
                hasChildren: (childrenByParent.get(folder.id) || []).length > 0,
                parentId
            };
        };
        const pushChildren = (parentId, depth) => {
            for (const item of childrenByParent.get(parentId || "") || []) {
                if (item.kind === "folder") {
                    if (visitedFolders.has(item.id)) continue;
                    visitedFolders.add(item.id);
                    const row = folderRow(item.folder, depth);
                    rows.push(row);
                    if (!row.collapsed) pushChildren(item.id, depth + 1);
                    continue;
                }
                const frame = item.frame;
                if (visitedFrames.has(frame.id)) continue;
                visitedFrames.add(frame.id);
                rows.push(Object.assign({}, frame, {
                    kind: "frame",
                    isFolder: false,
                    isFrame: true,
                    depth,
                    indent: depth * 16,
                    folderId: frame.folderId || ""
                }));
            }
        };

        pushChildren("", 0);
        for (const folder of folders) {
            if (visitedFolders.has(folder.id)) continue;
            const row = folderRow(folder, 0, "");
            rows.push(row);
            visitedFolders.add(folder.id);
            if (!row.collapsed) pushChildren(folder.id, 1);
        }
        for (const frame of frameViews) {
            if (!visitedFrames.has(frame.id) && shouldRecoverUnvisitedFrame(frame)) {
                rows.push(Object.assign({}, frame, {
                    kind: "frame",
                    isFolder: false,
                    isFrame: true,
                    depth: 0,
                    indent: 0,
                    folderId: frame.folderId || ""
                }));
            }
        }
        return rows;
    }

    _buildTextBlockViews(frame) {
        const blocks = getFrameTextBlocks(frame);
        return blocks.map((block, index) => ({
            id: block.id,
            text: block.text,
            richText: block.richText || richTextFromPlainText(block.text || ""),
            voice: block.voice,
            index: index + 1,
            inputName: `text-voice-${block.id}`
        }));
    }

    _buildAudioCueViews(cues, kind) {
        return (Array.isArray(cues) ? cues : []).map((cue, index) => ({
            ...cue,
            kind,
            index: index + 1,
            inputName: `audio-${kind}-${cue.id}`,
            isPlay: cue.action === AUDIO_ACTIONS.PLAY,
            isStop: cue.action === AUDIO_ACTIONS.STOP,
            isStopAll: cue.action === AUDIO_ACTIONS.STOP_ALL,
            actionOptions: this._options([
                [AUDIO_ACTIONS.PLAY, "Запустить / заменить канал"],
                [AUDIO_ACTIONS.STOP, "Остановить канал"],
                [AUDIO_ACTIONS.STOP_ALL, "Остановить всё"]
            ], cue.action || AUDIO_ACTIONS.PLAY)
        }));
    }

    _audioChannelOptions(scene, kind) {
        const key = kind === "sfx" ? "sfxCues" : "musicCues";
        const channels = new Set();
        for (const frame of scene?.frames || []) {
            for (const cue of Array.isArray(frame?.[key]) ? frame[key] : []) {
                const channel = String(cue?.channel || "").trim();
                if (channel) channels.add(channel);
            }
        }
        return [...channels].sort((left, right) => left.localeCompare(right)).map(value => ({ value }));
    }

    _nextAudioChannel(scene, kind) {
        const prefix = kind === "sfx" ? "sfx" : "music";
        const used = new Set(this._audioChannelOptions(scene, kind).map(option => option.value));
        let index = 1;
        while (used.has(`${prefix}-${index}`)) index += 1;
        return `${prefix}-${index}`;
    }

    _richTextFontOptions() {
        const names = [
            "Georgia",
            "Times New Roman",
            "Arial",
            "Verdana",
            "Trebuchet MS",
            "Courier New",
            "serif",
            "sans-serif",
            "monospace"
        ];
        const definitions = globalThis.CONFIG?.fontDefinitions;
        if (definitions && typeof definitions === "object") names.push(...Object.keys(definitions));
        return [...new Set(names.filter(name => typeof name === "string" && name.trim()).map(name => name.trim()))]
            .sort((left, right) => left.localeCompare(right))
            .map(name => ({ value: name, label: name }));
    }


    _counterOptionsFromBase(baseOptions, selected = "", includeEmpty = true) {
        const options = [];
        if (includeEmpty) options.push({ value: "", label: "Нет", selected: !selected });
        for (const option of baseOptions || []) options.push({ ...option, selected: option.value === selected });
        if (selected && !(baseOptions || []).some(option => option.value === selected)) {
            options.unshift({ value: selected, label: `Битый счётчик: ${selected}`, selected: true, invalid: true });
        }
        return options;
    }

    _counterConditionOptions(selected = "") {
        return this._options([
            [COUNTER_OPERATORS.NONE, "Без условия"],
            [COUNTER_OPERATORS.GT, "больше"],
            [COUNTER_OPERATORS.GTE, "больше или равно"],
            [COUNTER_OPERATORS.EQ, "равно"],
            [COUNTER_OPERATORS.LTE, "меньше или равно"],
            [COUNTER_OPERATORS.LT, "меньше"],
            [COUNTER_OPERATORS.NE, "не равно"]
        ], selected || COUNTER_OPERATORS.NONE);
    }

    _counterEffectOptions(selected = "") {
        return this._options([
            [COUNTER_EFFECTS.NONE, "Не менять"],
            [COUNTER_EFFECTS.ADD, "+ добавить"],
            [COUNTER_EFFECTS.SUBTRACT, "− отнять"]
        ], selected || COUNTER_EFFECTS.NONE);
    }

    _buildChoiceViews(frame, renderIndex) {
        const choices = frame && Array.isArray(frame.choices) ? frame.choices : [];
        return choices.map((choice, index) => {
            const choiceIssues = renderIndex.issuesByChoice.get(`${frame.id}:${choice.id}`) || [];
            const brokenTarget = Boolean(choice.next && !renderIndex.frameIdSet.has(choice.next));
            return Object.assign({}, choice, {
                index: index + 1,
                targetOptions: this._frameTargetsFromIndex(renderIndex, choice.next, true),
                targetLabel: this._frameTargetDisplayFromIndex(renderIndex, choice.next || "", "Следующий кадр по списку"),
                conditionCounterOptions: this._counterOptionsFromBase(renderIndex.counterOptionsBase, choice.conditionCounterId || "", true),
                conditionOperatorOptions: this._counterConditionOptions(choice.conditionOperator || ""),
                effectCounterOptions: this._counterOptionsFromBase(renderIndex.counterOptionsBase, choice.effectCounterId || "", true),
                effectOperationOptions: this._counterEffectOptions(choice.effectOperation || ""),
                issueCount: choiceIssues.length,
                hasIssue: choiceIssues.length > 0,
                hasError: choiceIssues.some(issue => issue.severity === "error"),
                hasWarning: choiceIssues.some(issue => issue.severity === "warning"),
                brokenTarget
            });
        });
    }

    _buildIssueView(issues) {
        const view = [];
        for (let index = 0; index < issues.length; index += 1) {
            const item = issues[index];
            view.push(Object.assign({}, item, {
                index: index + 1,
                isError: item.severity === "error",
                isWarning: item.severity === "warning"
            }));
        }
        return view;
    }

    async _onRender(context, options) {
        await super._onRender(context, options);
        this._injectHeaderActions();
    }

    _attachPartListeners(partId, htmlElement, options) {
        super._attachPartListeners(partId, htmlElement, options);
        if (partId === "resources") {
            const input = htmlElement.querySelector("input[type=file][data-import]");
            if (input) input.addEventListener("change", event => this._handleImportInput(event));
            return;
        }
        if (partId === "frames") {
            this._enableFrameDrag(htmlElement);
            this._enableBranchControls(htmlElement);
            this._enableFrameTargetControls(htmlElement);
            return;
        }
        if (partId === "sceneHead") {
            this._enableFrameTargetControls(htmlElement);
            return;
        }
        if (partId === "framePanel") {
            this._enableCharacterControls(htmlElement);
            this._enableRichTextEditors(htmlElement);
            this._enableAudioCueControls(htmlElement);
            this._enableFrameTargetControls(htmlElement);
            this._enableNextRoutingControls(htmlElement);
        }
    }

    _renderEditorParts(parts = EDITOR_PART_IDS) {
        const requestedSet = new Set(parts);
        for (const partId of this._pendingRenderParts || []) requestedSet.add(partId);
        if (this._pendingRenderParts) this._pendingRenderParts.clear();
        const requested = [...requestedSet].filter(partId => EDITOR_PART_IDS.includes(partId));
        const perform = () => {
            if (!requested.length || !this.rendered || !this.element) return this.render();
            return this.render({ parts: requested });
        };
        const run = this._renderQueue.then(perform, perform);
        this._renderQueue = run.catch(error => {
            console.error(`${MODULE_ID} | Editor render failed.`, error);
        });
        return run;
    }

    _renderPendingEditorParts() {
        if (!(this._pendingRenderParts && this._pendingRenderParts.size)) return Promise.resolve(this);
        return this._renderEditorParts([]);
    }

    _markRenderParts(parts) {
        this._pendingRenderParts || (this._pendingRenderParts = new Set());
        for (const partId of parts) {
            if (EDITOR_PART_IDS.includes(partId)) this._pendingRenderParts.add(partId);
        }
    }

    _trackCommittedFormChanges(before, after, frameId) {
        if (!before || !after) return;
        const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
        if (before.title !== after.title) this._markRenderParts(["scenes", "sceneHead"]);
        if (before.defaultMode !== after.defaultMode || before.startFrame !== after.startFrame) this._markRenderParts(["sceneHead"]);
        if (!same(before.counters || [], after.counters || [])) this._markRenderParts(["frames", "framePanel"]);
        const beforeFrame = (before.frames || []).find(frame => frame.id === frameId) || null;
        const afterFrame = (after.frames || []).find(frame => frame.id === frameId) || null;
        if (!same(beforeFrame, afterFrame)) this._markRenderParts(["resources", "frames", "sceneHead", "framePanel"]);
        if (this._sceneChanged(after) && !(this._pendingRenderParts && this._pendingRenderParts.size)) {
            this._markRenderParts(EDITOR_WORKSPACE_PART_IDS);
        }
    }

    _enableNextRoutingControls(root = this.element) {
        if (!root) return;
        const shell = root.querySelector("[data-next-routing-shell]");
        const toggle = root.querySelector("[name='frame.nextRouting.enabled']");
        const directFields = root.querySelector("[data-frame-next-fields]");
        const routingFields = root.querySelector("[data-next-routing-fields]");
        if (!shell || !toggle || !directFields || !routingFields) return;

        const sync = enabled => {
            shell.classList.toggle("is-counter-routing", enabled);
            directFields.hidden = enabled;
            routingFields.hidden = !enabled;
        };

        sync(toggle.checked === true);
        toggle.addEventListener("change", () => {
            const enabled = toggle.checked === true;
            const position = this._captureEditorPosition();
            const panel = root.closest?.(".fbl-vn-frame-panel") || null;
            const scrollTop = panel?.scrollTop ?? null;

            // Firefox may scroll a visually hidden checkbox into view when its label is clicked.
            // Drop focus before the route block changes height, then restore both the panel scroll
            // position and the ApplicationV2 geometry explicitly.
            toggle.blur?.();
            sync(enabled);
            if (panel && scrollTop !== null) panel.scrollTop = scrollTop;
            this._stabilizeEditorPosition(position);

            void this._enqueueEditorAction(() => this._persistNextRoutingState(enabled));
        });
    }

    _captureEditorPosition() {
        const rect = this.element?.getBoundingClientRect?.();
        const current = this.position || {};
        const numberOr = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
        return {
            top: numberOr(current.top, rect?.top),
            left: numberOr(current.left, rect?.left),
            width: numberOr(current.width, rect?.width),
            height: numberOr(current.height, rect?.height)
        };
    }

    _restoreEditorPosition(position) {
        if (!position || typeof this.setPosition !== "function") return;
        const clean = {};
        for (const key of ["top", "left", "width", "height"]) {
            if (Number.isFinite(position[key])) clean[key] = position[key];
        }
        if (Object.keys(clean).length) this.setPosition(clean);
    }

    _stabilizeEditorPosition(position) {
        this._restoreEditorPosition(position);
        const raf = globalThis.requestAnimationFrame;
        if (typeof raf !== "function") return;
        raf(() => {
            this._restoreEditorPosition(position);
            raf(() => this._restoreEditorPosition(position));
        });
    }

    async _persistNextRoutingState(enabled) {
        const original = this.selectedScene;
        const scene = duplicateData(original);
        if (!scene) return null;
        const frame = (scene.frames || []).find(item => item.id === this.selectedFrameId);
        if (!frame) return scene;
        const current = frame.nextRouting && typeof frame.nextRouting === "object" ? frame.nextRouting : {};
        frame.nextRouting = {
            enabled: enabled === true,
            counterId: this._readValue("frame.nextRouting.counterId", current.counterId || ""),
            operator: this._readValue("frame.nextRouting.operator", current.operator || COUNTER_OPERATORS.GTE),
            value: Number(this._readValue("frame.nextRouting.value", current.value || 0) || 0),
            trueFrameId: this._readValue("frame.nextRouting.trueFrameId", current.trueFrameId || ""),
            falseFrameId: this._readValue("frame.nextRouting.falseFrameId", current.falseFrameId || "")
        };
        const clean = sanitizeScene(scene);
        const saved = await VNSceneStore.upsertScene(clean);
        this.selectedSceneId = saved.id;
        return saved;
    }

    _enableAudioCueControls(root = this.element) {
        if (!root) return;
        for (const row of root.querySelectorAll("[data-audio-cue-row]")) {
            const action = row.querySelector("[data-audio-action]");
            const channel = row.querySelector("[data-audio-channel]");
            const src = row.querySelector("[data-audio-src]");
            const loop = row.querySelector("[data-audio-loop]");
            const picker = row.querySelector("[data-audio-picker]");
            if (!action) continue;
            const sync = () => {
                const isPlay = action.value === AUDIO_ACTIONS.PLAY;
                const isStop = action.value === AUDIO_ACTIONS.STOP;
                if (channel) channel.disabled = !(isPlay || isStop);
                if (src) src.disabled = !isPlay;
                if (loop) loop.disabled = !isPlay;
                if (picker) picker.disabled = !isPlay;
                row.classList.toggle("is-stop-all", action.value === AUDIO_ACTIONS.STOP_ALL);
            };
            action.addEventListener("change", sync);
            sync();
        }
    }

    _enableCharacterControls(root = this.element) {
        if (!root) return;
        const characterSelect = root.querySelector("[data-character-select]");
        const portraitSelect = root.querySelector("[data-character-portrait-select]");
        if (characterSelect) characterSelect.addEventListener("change", () => {
            const characterId = characterSelect.value;
            void this._enqueueEditorAction(() => this._applyCharacterPreset(characterId, ""));
        });
        if (portraitSelect) portraitSelect.addEventListener("change", () => {
            const portraitId = portraitSelect.value;
            void this._enqueueEditorAction(() => this._applyCharacterPortrait(portraitId));
        });

        for (const row of root.querySelectorAll("[data-additional-character-row]")) {
            const entryId = row.dataset.frameCharacterId || "";
            const extraCharacterSelect = row.querySelector("[data-frame-character-select]");
            const extraPortraitSelect = row.querySelector("[data-frame-character-portrait-select]");
            if (extraCharacterSelect) extraCharacterSelect.addEventListener("change", () => {
                const characterId = extraCharacterSelect.value;
                void this._enqueueEditorAction(() => this._applyAdditionalCharacterPreset(entryId, characterId, ""));
            });
            if (extraPortraitSelect) extraPortraitSelect.addEventListener("change", () => {
                const portraitId = extraPortraitSelect.value;
                void this._enqueueEditorAction(() => this._applyAdditionalCharacterPortrait(entryId, portraitId));
            });
        }
    }

    _enableRichTextEditors(root = this.element) {
        if (!root) return;
        for (const shell of root.querySelectorAll("[data-rich-text-editor]")) {
            const editor = shell.querySelector("[data-text-block-rich]");
            const toolbar = shell.querySelector("[data-rich-toolbar]");
            if (!editor || !toolbar || shell.dataset.richTextBound === "true") continue;
            shell.dataset.richTextBound = "true";

            let savedRange = null;
            const rangeBelongsToEditor = range => {
                if (!range) return false;
                const container = range.commonAncestorContainer;
                const element = container?.nodeType === 1 ? container : container?.parentElement;
                return Boolean(element && (element === editor || editor.contains(element)));
            };
            const saveSelection = () => {
                const selection = globalThis.getSelection?.();
                if (!selection || !selection.rangeCount) return;
                const range = selection.getRangeAt(0);
                if (rangeBelongsToEditor(range)) savedRange = range.cloneRange();
            };
            const restoreSelection = () => {
                editor.focus();
                const selection = globalThis.getSelection?.();
                if (!selection) return;
                selection.removeAllRanges();
                if (savedRange && rangeBelongsToEditor(savedRange)) selection.addRange(savedRange);
                else {
                    const range = document.createRange();
                    range.selectNodeContents(editor);
                    range.collapse(false);
                    selection.addRange(range);
                }
            };
            const exec = (command, value = null) => {
                restoreSelection();
                try {
                    document.execCommand(command, false, value);
                }
                catch (error) {
                    console.warn(`${MODULE_ID} | Rich text command failed: ${command}`, error);
                }
                saveSelection();
            };

            editor.addEventListener("keyup", saveSelection);
            editor.addEventListener("mouseup", saveSelection);
            editor.addEventListener("focus", saveSelection);
            editor.addEventListener("input", saveSelection);
            editor.addEventListener("paste", event => {
                const clipboard = event.clipboardData;
                if (!clipboard) return;
                const html = clipboard.getData("text/html");
                const plain = clipboard.getData("text/plain");
                if (!html) return;
                event.preventDefault();
                const safe = sanitizeRichTextHtml(html, { fallbackText: plain });
                restoreSelection();
                document.execCommand("insertHTML", false, safe);
                saveSelection();
            });

            toolbar.addEventListener("mousedown", saveSelection, true);

            for (const button of toolbar.querySelectorAll("[data-rich-command]")) {
                button.addEventListener("click", event => {
                    event.preventDefault();
                    exec(button.dataset.richCommand || "");
                });
            }

            for (const select of toolbar.querySelectorAll("[data-rich-command-select]")) {
                select.addEventListener("change", () => {
                    const command = select.dataset.richCommandSelect || "";
                    const value = select.value;
                    if (command && value) exec(command, value);
                    select.selectedIndex = 0;
                });
            }

            const color = toolbar.querySelector("[data-rich-color]");
            if (color) color.addEventListener("change", () => exec("foreColor", color.value || "#efe8db"));
            const highlight = toolbar.querySelector("[data-rich-highlight]");
            if (highlight) highlight.addEventListener("change", () => exec("backColor", highlight.value || "#5a4528"));
        }
    }

    async _applyCharacterPreset(characterId, portraitId) {
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene && Array.isArray(scene.frames) ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame) return;
        const character = VNSceneStore.getCharacter(characterId);
        if (!character) {
            frame.characterId = "";
            frame.portraitId = "";
            await VNSceneStore.upsertScene(scene);
            this._renderEditorParts(["frames", "framePanel"]);
            return;
        }
        const portraits = Array.isArray(character.portraits) ? character.portraits : [];
        const portrait = portraits.find(item => item.id === portraitId) || portraits[0] || null;
        frame.characterId = character.id;
        frame.speaker = character.name;
        frame.portraitPosition = ["left", "center", "right"].includes(frame.portraitPosition)
            ? frame.portraitPosition
            : (character.defaultPosition || "left");
        frame.hidePortrait = false;
        if (portrait) {
            frame.portraitId = portrait.id;
            frame.portrait = portrait.path || "";
        }
        else frame.portraitId = "";
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    async _applyCharacterPortrait(portraitId) {
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene && Array.isArray(scene.frames) ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame || !frame.characterId) return;
        const character = VNSceneStore.getCharacter(frame.characterId);
        if (!character) return;
        const portraits = Array.isArray(character.portraits) ? character.portraits : [];
        const portrait = portraits.find(item => item.id === portraitId) || portraits[0] || null;
        if (portrait) {
            frame.portraitId = portrait.id;
            frame.portrait = portrait.path || "";
            frame.hidePortrait = false;
        }
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    async _applyAdditionalCharacterPreset(entryId, characterId, portraitId) {
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene && Array.isArray(scene.frames) ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        const entry = frame && Array.isArray(frame.additionalCharacters)
            ? frame.additionalCharacters.find(item => item.id === entryId)
            : null;
        if (!scene || !frame || !entry) return;

        const character = VNSceneStore.getCharacter(characterId);
        if (!character) {
            entry.characterId = "";
            entry.portraitId = "";
            await VNSceneStore.upsertScene(scene);
            this._renderEditorParts(["frames", "framePanel"]);
            return;
        }

        const portraits = Array.isArray(character.portraits) ? character.portraits : [];
        const portrait = portraits.find(item => item.id === portraitId) || portraits[0] || null;
        entry.characterId = character.id;
        entry.name = character.name;
        entry.portraitPosition = ["left", "center", "right"].includes(entry.portraitPosition)
            ? entry.portraitPosition
            : (character.defaultPosition || "right");
        if (portrait) {
            entry.portraitId = portrait.id;
            entry.portrait = portrait.path || "";
        }
        else {
            entry.portraitId = "";
            entry.portrait = "";
        }
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    async _applyAdditionalCharacterPortrait(entryId, portraitId) {
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene && Array.isArray(scene.frames) ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        const entry = frame && Array.isArray(frame.additionalCharacters)
            ? frame.additionalCharacters.find(item => item.id === entryId)
            : null;
        if (!scene || !frame || !entry || !entry.characterId) return;
        const character = VNSceneStore.getCharacter(entry.characterId);
        if (!character) return;
        if (!portraitId) {
            entry.portraitId = "";
            entry.portrait = "";
            await VNSceneStore.upsertScene(scene);
            this._renderEditorParts(["frames", "framePanel"]);
            return;
        }
        const portraits = Array.isArray(character.portraits) ? character.portraits : [];
        const portrait = portraits.find(item => item.id === portraitId) || portraits[0] || null;
        if (portrait) {
            entry.portraitId = portrait.id;
            entry.portrait = portrait.path || "";
        }
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    _getApplicationElement() {
        const element = this.element;
        if (!element) return null;
        if (element.classList && element.classList.contains("application")) return element;
        if (typeof element.closest === "function") {
            const closest = element.closest(".application");
            if (closest) return closest;
        }
        return document.getElementById("fbl-vn-editor");
    }

    _hasNativeHeaderActions(header) {
        return false;
    }

    _injectHeaderActions() {
        const app = this._getApplicationElement();
        if (!app) return;
        const existingBar = app.querySelector(".fbl-vn-editor-header-actions");
        const oldValidation = app.querySelector(".fbl-vn-editor-header-validation");
        const header = app.querySelector(".window-header");
        if (!header) {
            if (existingBar) existingBar.remove();
            if (oldValidation) oldValidation.remove();
            return;
        }
        if (oldValidation) oldValidation.remove();

        const validation = this._buildHeaderValidationControl();
        const title = header.querySelector(".window-title, h4, h1");
        if (validation) {
            if (title && title.parentElement === header) title.insertAdjacentElement("afterend", validation);
            else header.insertBefore(validation, header.firstChild);
        }

        if (this._hasNativeHeaderActions(header) || existingBar) return;
        const bar = document.createElement("div");
        bar.className = "fbl-vn-editor-header-actions";
        const buttons = [
            ["save", "Сохранить", "fa-solid fa-floppy-disk"],
            ["counters", "Счётчики", "fa-solid fa-gauge-high"],
            ["preview", "Предпросмотр", "fa-solid fa-eye"],
            ["startIndividual", "Игрокам", "fa-solid fa-users"],
            ["startGm", "ГМ ведёт", "fa-solid fa-person-chalkboard"],
            ["startVote", "Голосование", "fa-solid fa-check-to-slot"],
            ["graph", "Схема связей", "fa-solid fa-diagram-project"]
        ];
        for (const spec of buttons) {
            const button = document.createElement("button");
            button.type = "button";
            button.addEventListener("pointerdown", event => event.stopPropagation());
            button.addEventListener("mousedown", event => event.stopPropagation());
            button.dataset.vnHeaderAction = spec[0];
            button.title = spec[1];
            button.setAttribute("aria-label", spec[1]);
            button.innerHTML = `<i class="${spec[2]}"></i>`;
            button.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                void this._enqueueEditorAction(() => this._handleHeaderAction(event, button));
            });
            bar.appendChild(button);
        }
        const close = header.querySelector("[data-action='close'], .header-control.close, .close");
        const controls = header.querySelector(".window-controls");
        if (close && close.parentElement === header) header.insertBefore(bar, close);
        else if (controls && controls.parentElement === header) header.insertBefore(bar, controls);
        else header.appendChild(bar);
    }

    _buildHeaderValidationControl() {
        const scene = this.selectedScene;
        if (!scene) return null;
        const cached = this._lastValidationSnapshot;
        const issues = cached?.sceneId === scene.id ? cached.issues : validateScene(scene);
        const errors = issues.filter(issue => issue.severity === "error");
        const warnings = issues.filter(issue => issue.severity === "warning");
        const control = document.createElement("button");
        control.type = "button";
        control.className = `fbl-vn-editor-header-validation ${errors.length ? "has-errors" : warnings.length ? "has-warnings" : "is-clean"}`;
        control.addEventListener("pointerdown", event => event.stopPropagation());
        control.addEventListener("mousedown", event => event.stopPropagation());
        const label = issues.length ? `${errors.length} ошибок, ${warnings.length} предупреждений` : "Проверка: чисто";
        const titleLines = issues.length ? issues.slice(0, 10).map(issue => issue.message).join("\n") : "Ошибок и предупреждений нет.";
        control.title = titleLines;
        control.innerHTML = `<i class="fa-solid ${errors.length ? "fa-triangle-exclamation" : warnings.length ? "fa-circle-exclamation" : "fa-circle-check"}"></i><span>${escapeHtml(label)}</span>`;
        control.addEventListener("click", event => {
            event.preventDefault();
            event.stopPropagation();
            const issue = issues.find(item => item.frameId) || null;
            if (!issue) return;
            const frame = (this.selectedScene?.frames || []).find(item => item.id === issue.frameId);
            if (frame) this.selectedBranchId = frame.branchId || this.selectedBranchId;
            this.selectedFrameId = issue.frameId;
            this._renderEditorParts(["frames", "framePanel"]);
        });
        return control;
    }

    async _handleHeaderAction(event, target) {
        event.preventDefault();
        event.stopPropagation();
        const action = target ? target.dataset.vnHeaderAction : "";
        if (action === "save") return VNEditorApp._onSave.call(this, event, target);
        if (action === "counters") return VNEditorApp._onOpenCounterManager.call(this, event, target);
        if (action === "preview") return VNEditorApp._onPreview.call(this, event, target);
        if (action === "startIndividual") return VNEditorApp._onStartIndividual.call(this, event, target);
        if (action === "startGm") return VNEditorApp._onStartGm.call(this, event, target);
        if (action === "startVote") return VNEditorApp._onStartVote.call(this, event, target);
        if (action === "graph") return VNEditorApp._onOpenGraph.call(this, event, target);
    }

    _enableBranchControls(root = this.element) {
        if (!root) return;
        const panel = root.querySelector(".fbl-vn-branch-panel");
        const select = root.querySelector("[data-branch-select]");
        if (select) {
            select.addEventListener("change", event => {
                const branchId = select.value;
                void this._enqueueEditorAction(() => VNEditorApp._onSelectBranch.call(this, event, select, branchId));
            });
        }
        if (!panel) return;
        for (const button of panel.querySelectorAll("button[data-branch-action]")) {
            button.addEventListener("click", event => {
                event.preventDefault();
                event.stopPropagation();
                void this._enqueueEditorAction(() => {
                    const action = button.dataset.branchAction;
                    if (action === "renameBranch") return VNEditorApp._onRenameBranch.call(this, event, button);
                    if (action === "duplicateBranch") return VNEditorApp._onDuplicateBranch.call(this, event, button);
                    if (action === "deleteBranch") return VNEditorApp._onDeleteBranch.call(this, event, button);
                    if (action === "addBranch") return VNEditorApp._onAddBranch.call(this, event, button);
                });
            });
        }
    }

    _enableFrameTargetControls(root = this.element) {
        if (!root) return;
        const scene = this.selectedScene;
        const entries = this._lastFrameTargetSceneId === scene?.id && Array.isArray(this._lastFrameTargetEntries)
            ? this._lastFrameTargetEntries
            : this._frameTargetEntries(scene);
        const byId = new Map(entries.map(entry => [entry.id, entry.label]));
        const labelCounts = new Map();
        for (const entry of entries) labelCounts.set(entry.label, (labelCounts.get(entry.label) || 0) + 1);
        const byLabel = new Map(entries.filter(entry => labelCounts.get(entry.label) === 1).map(entry => [entry.label, entry.id]));
        const bindSearch = (input) => {
            if (!input) return;
            const resolveHidden = () => {
                const row = input.closest("[data-choice-row]");
                if (row) return row.querySelector("[data-choice-next]");
                const field = input.dataset.targetField || "";
                return field ? (root.querySelector(`[name='${field}']`) || this.element?.querySelector(`[name='${field}']`)) : null;
            };
            const apply = () => {
                const hidden = resolveHidden();
                if (!hidden) return;
                const raw = String(input.value || "").trim();
                if (!raw) {
                    if (input.dataset.allowEmpty !== "false") hidden.value = "";
                    return;
                }
                if (byId.has(raw)) hidden.value = raw;
                else if (byLabel.has(raw)) hidden.value = byLabel.get(raw);
            };
            const normalize = () => {
                const hidden = resolveHidden();
                if (!hidden) return;
                const id = hidden.value || "";
                if (id && byId.has(id)) input.value = byId.get(id);
                else if (!id && input.dataset.emptyLabel !== undefined) input.value = input.dataset.emptyLabel || "";
            };
            input.addEventListener("change", apply);
            input.addEventListener("keydown", event => {
                if (event.key === "Enter") {
                    event.preventDefault();
                    apply();
                    input.blur();
                }
            });
            input.addEventListener("blur", () => {
                apply();
                normalize();
            });
        };
        for (const input of root.querySelectorAll("[data-frame-target-search]")) bindSearch(input);
    }

    _enableFrameDrag(root = this.element) {
        if (!root) return;
        const list = root.querySelector("[data-frame-list]");
        if (!list) return;
        const items = list.querySelectorAll("[data-tree-item]");
        for (const item of items) {
            item.addEventListener("dragstart", event => this._onTreeDragStart(event, item));
            item.addEventListener("dragend", event => this._onTreeDragEnd(event));
        }
        list.addEventListener("dragover", event => this._onTreeDragOver(event));
        list.addEventListener("drop", event => this._onTreeDrop(event));
        list.addEventListener("dragleave", event => this._onTreeDragLeave(event));
    }

    _onTreeDragStart(event, item) {
        this._dragTreeItem = { type: item.dataset.itemType, id: item.dataset.itemId };
        this._dragFrameId = this._dragTreeItem.type === "frame" ? this._dragTreeItem.id : null;
        item.classList.add("is-dragging");
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", `${this._dragTreeItem.type}:${this._dragTreeItem.id}`);
        }
    }

    _onTreeDragEnd(event) {
        this._dragTreeItem = null;
        this._dragFrameId = null;
        this._clearFrameDropMarkers();
        if (!this.element) return;
        const dragging = this.element.querySelector(".is-dragging");
        if (dragging) dragging.classList.remove("is-dragging");
    }

    _onTreeDragOver(event) {
        const target = this._getTreeDropTarget(event);
        if (!this._dragTreeItem || !target) return;
        const targetType = target.dataset.itemType;
        const targetId = target.dataset.itemId;
        if (targetType === this._dragTreeItem.type && targetId === this._dragTreeItem.id) return;
        event.preventDefault();
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
        const placement = this._getTreeDropPlacement(event, target);
        this._clearFrameDropMarkers();
        target.classList.add(placement === "before" ? "is-drop-before" : placement === "after" ? "is-drop-after" : "is-drop-inside");
    }

    _onTreeDragLeave(event) {
        const current = event.currentTarget;
        const related = event.relatedTarget;
        if (current && related && current.contains && current.contains(related)) return;
        this._clearFrameDropMarkers();
    }

    async _onTreeDrop(event) {
        const target = this._getTreeDropTarget(event);
        let source = this._dragTreeItem;
        if (!source && event.dataTransfer) {
            const raw = event.dataTransfer.getData("text/plain") || "";
            const parts = raw.split(":");
            if (parts.length === 2) source = { type: parts[0], id: parts[1] };
        }
        if (!source) return;
        event.preventDefault();
        this._dragTreeItem = null;
        this._dragFrameId = null;
        this._clearFrameDropMarkers();
        const targetType = target ? target.dataset.itemType : "root";
        const targetId = target ? target.dataset.itemId : "";
        const placement = target ? this._getTreeDropPlacement(event, target) : "inside";
        await this._moveTreeItem(source.type, source.id, targetType, targetId, placement);
    }

    _getTreeDropTarget(event) {
        const target = event.target;
        if (!target || typeof target.closest !== "function") return null;
        return target.closest("[data-tree-item]");
    }

    _getTreeDropPlacement(event, target) {
        const rect = target.getBoundingClientRect();
        const y = event.clientY - rect.top;
        const isFolder = target.dataset.itemType === "folder";
        if (isFolder) {
            if (y < rect.height * 0.28) return "before";
            if (y > rect.height * 0.72) return "after";
            return "inside";
        }
        return y < rect.height / 2 ? "before" : "after";
    }

    _clearFrameDropMarkers() {
        if (!this.element) return;
        for (const item of this.element.querySelectorAll(".is-drop-before, .is-drop-after, .is-drop-inside")) {
            item.classList.remove("is-drop-before", "is-drop-after", "is-drop-inside");
        }
    }

    async _moveTreeItem(sourceType, sourceId, targetType, targetId, placement, sceneOverride = null) {
        const scene = sceneOverride || await this._commitFromForm({ persist: false });
        if (!scene || !sourceType || !sourceId) return;
        if (sourceType === targetType && sourceId === targetId) return;
        scene.frameFolders = Array.isArray(scene.frameFolders) ? scene.frameFolders : [];
        scene.frames = Array.isArray(scene.frames) ? scene.frames : [];
        const sourceRecord = this._treeRecord(scene, sourceType, sourceId);
        if (!sourceRecord) return;
        if (sourceType === "folder" && targetType === "folder" && (placement === "inside" || placement === "before" || placement === "after")) {
            if (this._isFolderDescendant(scene, targetId, sourceId) || targetId === sourceId) {
                notifyWarn("VN: папку нельзя вложить в саму себя.");
                return;
            }
        }

        let newParent = "";
        let newBranchId = this.selectedBranchId || (sourceRecord.branchId || "");
        let insertIndex = -1;
        if (targetType === "root" || !targetType) {
            newParent = "";
            insertIndex = this._treeSiblings(scene, newParent).length;
        }
        else if (targetType === "folder" && placement === "inside") {
            const targetRecord = this._treeRecord(scene, targetType, targetId);
            newParent = targetId;
            newBranchId = targetRecord ? targetRecord.branchId || newBranchId : newBranchId;
            insertIndex = this._treeSiblings(scene, newParent, newBranchId).length;
        }
        else {
            const targetRecord = this._treeRecord(scene, targetType, targetId);
            if (!targetRecord) return;
            newParent = targetRecord.parentId || "";
            newBranchId = targetRecord.branchId || newBranchId;
            const siblings = this._treeSiblings(scene, newParent, newBranchId).filter(item => !(item.type === sourceType && item.id === sourceId));
            const targetIndex = siblings.findIndex(item => item.type === targetType && item.id === targetId);
            insertIndex = targetIndex < 0 ? siblings.length : targetIndex + (placement === "after" ? 1 : 0);
        }

        if (sourceType === "frame") {
            const frame = scene.frames.find(item => item.id === sourceId);
            if (!frame) return;
            frame.branchId = newBranchId;
            frame.folderId = newParent;
            this.selectedBranchId = newBranchId;
            this.selectedFrameId = frame.id;
            this.selectedFolderId = newParent || null;
        }
        else {
            const folder = scene.frameFolders.find(item => item.id === sourceId);
            if (!folder) return;
            this._setFolderBranch(scene, folder.id, newBranchId);
            folder.parentId = newParent;
            this.selectedBranchId = newBranchId;
            this.selectedFolderId = folder.id;
        }
        this._normalizeTreeOrder(scene, newParent, { type: sourceType, id: sourceId }, insertIndex, newBranchId);
        this._rebuildFrameArrayByTree(scene);
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["resources", "frames", "sceneHead", "framePanel"]);
    }

    _treeRecord(scene, type, id) {
        if (type === "frame") {
            const frame = (scene.frames || []).find(item => item.id === id);
            return frame ? { type, id, branchId: frame.branchId || "", parentId: frame.folderId || "", item: frame, sort: Number(frame.sort || 0) } : null;
        }
        if (type === "folder") {
            const folder = (scene.frameFolders || []).find(item => item.id === id);
            return folder ? { type, id, branchId: folder.branchId || "", parentId: folder.parentId || "", item: folder, sort: Number(folder.sort || 0) } : null;
        }
        return null;
    }

    _treeSiblings(scene, parentId, branchId = this.selectedBranchId || "") {
        const items = [];
        for (const folder of scene.frameFolders || []) {
            if ((folder.branchId || "") !== branchId) continue;
            if ((folder.parentId || "") === parentId) items.push({ type: "folder", id: folder.id, branchId: folder.branchId || "", item: folder, sort: Number(folder.sort || 0), name: folder.name || "Папка" });
        }
        for (const frame of scene.frames || []) {
            if ((frame.branchId || "") !== branchId) continue;
            if ((frame.folderId || "") === parentId) items.push({ type: "frame", id: frame.id, branchId: frame.branchId || "", item: frame, sort: Number(frame.sort || 0), name: frameDisplayName(frame) });
        }
        items.sort((a, b) => {
            if (a.sort !== b.sort) return a.sort - b.sort;
            return String(a.name).localeCompare(String(b.name));
        });
        return items;
    }

    _normalizeTreeOrder(scene, parentId, moved, insertIndex, branchId = this.selectedBranchId || "") {
        let siblings = this._treeSiblings(scene, parentId, branchId).filter(item => !(item.type === moved.type && item.id === moved.id));
        const source = this._treeRecord(scene, moved.type, moved.id);
        if (!source) return;
        const index = Math.max(0, Math.min(insertIndex, siblings.length));
        siblings.splice(index, 0, {
            type: moved.type,
            id: moved.id,
            branchId,
            item: source.item,
            sort: source.sort,
            name: moved.type === "frame" ? frameDisplayName(source.item) : (source.item.name || source.item.id)
        });
        for (let i = 0; i < siblings.length; i += 1) siblings[i].item.sort = i * 1000;
    }

    _setFolderBranch(scene, folderId, branchId) {
        const folders = scene.frameFolders || [];
        const folder = folders.find(item => item.id === folderId);
        if (!folder) return;
        folder.branchId = branchId;
        for (const child of folders) {
            if ((child.parentId || "") === folderId) this._setFolderBranch(scene, child.id, branchId);
        }
        for (const frame of scene.frames || []) {
            if ((frame.folderId || "") === folderId) frame.branchId = branchId;
        }
    }

    _isFolderDescendant(scene, folderId, maybeAncestorId) {
        const map = new Map((scene.frameFolders || []).map(folder => [folder.id, folder]));
        let current = folderId;
        const seen = new Set();
        while (current) {
            if (current === maybeAncestorId) return true;
            if (seen.has(current)) return false;
            seen.add(current);
            const folder = map.get(current);
            current = folder ? folder.parentId || "" : "";
        }
        return false;
    }

    _rebuildFrameArrayByTree(scene) {
        const frameMap = new Map((scene.frames || []).map(frame => [frame.id, frame]));
        const branches = Array.isArray(scene.branches) && scene.branches.length ? scene.branches.slice().sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0)) : [{ id: this.selectedBranchId || "" }];
        const result = [];
        const visited = new Set();
        const walk = (parentId, branchId) => {
            const siblings = this._treeSiblings(scene, parentId, branchId);
            for (const item of siblings) {
                if (item.type === "frame") {
                    if (!visited.has(item.id) && frameMap.has(item.id)) {
                        result.push(frameMap.get(item.id));
                        visited.add(item.id);
                    }
                }
                else walk(item.id, branchId);
            }
        };
        for (const branch of branches) walk("", branch.id || "");
        for (const frame of scene.frames || []) {
            if (!visited.has(frame.id)) result.push(frame);
        }
        scene.frames = result;
    }

    async _reorderFrameByDrag(sourceId, targetId, placement) {
        return this._moveTreeItem("frame", sourceId, "frame", targetId, placement);
    }

    _options(pairs, selected) {
        return pairs.map(pair => ({ value: pair[0], label: pair[1], selected: pair[0] === selected }));
    }

    _frameTargetsFromIndex(renderIndex, selected, includeEmpty) {
        const options = [];
        if (includeEmpty) options.push({ value: "", label: "Следующий кадр по списку", selected: !selected });
        for (const entry of renderIndex.frameTargetEntries || []) {
            options.push({ value: entry.id, label: entry.label, selected: entry.id === selected });
        }
        if (selected && !renderIndex.frameIdSet.has(selected)) {
            options.unshift({ value: selected, label: `Битая ссылка: ${selected}`, selected: true, invalid: true });
        }
        return options;
    }

    _frameTargetEntries(scene) {
        if (!scene || !Array.isArray(scene.frames)) return [];
        const branches = Array.isArray(scene.branches) ? scene.branches : [];
        const branchMap = new Map(branches.map((branch, index) => [branch.id, branch.name || `Ветка ${index + 1}`]));
        const branchOrder = new Map(branches.map((branch, index) => [branch.id, index]));
        const localIndex = new Map();
        return scene.frames.map((frame, index) => {
            const branchId = frame.branchId || "";
            const branchName = branchMap.get(branchId) || "Без ветки";
            const nextIndex = (localIndex.get(branchId) || 0) + 1;
            localIndex.set(branchId, nextIndex);
            const label = `${branchName}: ${nextIndex}) ${frameDisplayName(frame, { maxLength: 46 })}`;
            return { id: frame.id, label, branchId, order: branchOrder.has(branchId) ? branchOrder.get(branchId) : 9999, index };
        }).sort((a, b) => a.order !== b.order ? a.order - b.order : a.index - b.index);
    }

    _frameTargetDisplayFromIndex(renderIndex, frameId, emptyLabel = "") {
        if (!frameId) return emptyLabel;
        const entry = renderIndex.frameTargetById.get(frameId);
        return entry ? entry.label : `Битая ссылка: ${frameId}`;
    }

    _folderOptions(scene, selected, branchId = "") {
        const options = [{ value: "", label: "Без папки", selected: !selected }];
        const folders = scene && Array.isArray(scene.frameFolders) ? scene.frameFolders.filter(folder => !branchId || folder.branchId === branchId) : [];
        const childrenByParent = new Map();
        for (const folder of folders) {
            const parentId = folder.parentId || "";
            if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
            childrenByParent.get(parentId).push(folder);
        }
        for (const children of childrenByParent.values()) {
            children.sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
        }
        const visited = new Set();
        const walk = (parentId, depth) => {
            for (const folder of childrenByParent.get(parentId) || []) {
                if (visited.has(folder.id)) continue;
                visited.add(folder.id);
                const prefix = depth > 0 ? "· ".repeat(depth) : "";
                options.push({ value: folder.id, label: `${prefix}${folder.name || "Папка"}`, selected: folder.id === selected });
                walk(folder.id, depth + 1);
            }
        };
        walk("", 0);
        for (const folder of folders) {
            if (visited.has(folder.id)) continue;
            options.push({ value: folder.id, label: folder.name || "Папка", selected: folder.id === selected });
        }
        return options;
    }

    _characterOptions(characters, selected) {
        const options = [{ value: "", label: "Не использовать", selected: !selected }];
        for (const character of characters) options.push({ value: character.id, label: character.name, selected: character.id === selected });
        return options;
    }

    _characterPortraitOptions(character, selected) {
        const options = [{ value: "", label: "Нет портрета", selected: !selected }];
        const portraits = character && Array.isArray(character.portraits) ? character.portraits : [];
        for (const portrait of portraits) options.push({ value: portrait.id, label: portrait.label || portrait.path, selected: portrait.id === selected });
        return options;
    }

    _buildAdditionalCharacterViews(frame, characters, characterById) {
        const entries = frame && Array.isArray(frame.additionalCharacters) ? frame.additionalCharacters : [];
        return entries.map((entry, index) => {
            const character = entry.characterId ? characterById.get(entry.characterId) || null : null;
            return Object.assign({}, entry, {
                index: index + 2,
                characterOptions: this._characterOptions(characters, entry.characterId || ""),
                portraitOptions: this._characterPortraitOptions(character, entry.portraitId || ""),
                positionOptions: this._options([
                    ["left", "Слева"],
                    ["center", "По центру"],
                    ["right", "Справа"]
                ], entry.portraitPosition || "right"),
                portraitInputName: `frame.additionalCharacters.${entry.id}.portrait`
            });
        });
    }

    _frameTypeLabel(type) {
        if (type === FRAME_TYPES.NARRATION) return "Наррация";
        if (type === FRAME_TYPES.CHOICE) return "Выбор";
        return "Реплика";
    }

    _labelFromPath(path, fallback) {
        if (!path) return fallback;
        return String(path).split("/").pop() || fallback;
    }

    _sameData(a, b) {
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        }
        catch (_error) {
            return false;
        }
    }

    _sceneChanged(cleanScene) {
        const current = this.selectedScene;
        if (!current) return true;
        return !this._sameData(sanitizeScene(current), cleanScene);
    }

    async _commitFromForm({ persist = true } = {}) {
        const originalScene = this.selectedScene;
        const scene = duplicateData(originalScene);
        if (!scene || !this.element) return scene;
        const sceneTitle = this.element.querySelector("[name='scene.title']");
        const sceneMode = this.element.querySelector("[name='scene.defaultMode']");
        const sceneStart = this.element.querySelector("[name='scene.startFrame']");
        if (sceneTitle) scene.title = sceneTitle.value || "Без названия";
        if (sceneMode) scene.defaultMode = sceneMode.value || PLAYER_MODES.INDIVIDUAL;
        if (sceneStart) scene.startFrame = sceneStart.value || scene.startFrame;

        const frame = scene.frames.find(item => item.id === this.selectedFrameId);
        if (frame) {
            const oldType = frame.type;
            frame.type = this._readValue("frame.type", frame.type);
            frame.title = this._readValue("frame.title", frame.title);
            frame.branchId = this._readValue("frame.branchId", frame.branchId || this.selectedBranchId || "");
            frame.folderId = this._readValue("frame.folderId", frame.folderId || "");
            const folderForFrame = (scene.frameFolders || []).find(folder => folder.id === frame.folderId);
            if (frame.folderId && (!folderForFrame || folderForFrame.branchId !== frame.branchId)) frame.folderId = "";
            const finalInput = this.element.querySelector("[name='frame.isFinal']");
            frame.isFinal = Boolean(finalInput && finalInput.checked);
            frame.background = this._readValue("frame.background", frame.background);
            const clearBackgroundInput = this.element.querySelector("[name='frame.clearBackground']");
            frame.clearBackground = Boolean(clearBackgroundInput && clearBackgroundInput.checked);
            frame.transition = this._readValue("frame.transition", frame.transition);
            frame.vignetteMode = this._readValue("frame.vignetteMode", frame.vignetteMode || VIGNETTE_MODES.NONE);
            frame.characterId = this._readValue("frame.characterId", frame.characterId || "");
            frame.portraitId = this._readValue("frame.portraitId", frame.portraitId || "");
            frame.speaker = this._readValue("frame.speaker", frame.speaker);
            frame.portrait = this._readValue("frame.portrait", frame.portrait);
            const hidePortraitInput = this.element.querySelector("[name='frame.hidePortrait']");
            frame.hidePortrait = Boolean(hidePortraitInput && hidePortraitInput.checked);
            frame.portraitPosition = this._readValue("frame.portraitPosition", frame.portraitPosition);
            const showSpeakerNameInput = this.element.querySelector("[name='frame.showSpeakerName']");
            frame.showSpeakerName = showSpeakerNameInput ? showSpeakerNameInput.checked === true : frame.showSpeakerName !== false;
            frame.additionalCharacters = [...this.element.querySelectorAll("[data-additional-character-row]")].map(row => ({
                id: row.dataset.frameCharacterId || randomId("frame-character"),
                characterId: this._readRowValue(row, "[data-frame-character-select]", ""),
                portraitId: this._readRowValue(row, "[data-frame-character-portrait-select]", ""),
                name: this._readRowValue(row, "[data-frame-character-name]", ""),
                portrait: this._readRowValue(row, "[data-frame-character-portrait]", ""),
                portraitPosition: this._readRowValue(row, "[data-frame-character-position]", "right"),
                showName: Boolean(row.querySelector("[data-frame-character-show-name]")?.checked)
            }));
            frame.textPresentation = this._readValue("frame.textPresentation", frame.textPresentation || TEXT_PRESENTATIONS.BOX);
            frame.musicCues = this._readAudioCues("music");
            frame.sfxCues = this._readAudioCues("sfx");
            frame.effectCounterId = this._readValue("frame.effectCounterId", frame.effectCounterId || "");
            frame.effectOperation = this._readValue("frame.effectOperation", frame.effectOperation || COUNTER_EFFECTS.NONE);
            frame.effectValue = Number(this._readValue("frame.effectValue", frame.effectValue || 0) || 0);
            frame.next = this._readValue("frame.next", frame.next);
            const nextRoutingToggle = this.element.querySelector("[name='frame.nextRouting.enabled']");
            if (nextRoutingToggle) {
                frame.nextRouting = {
                    enabled: nextRoutingToggle.checked === true,
                    counterId: this._readValue("frame.nextRouting.counterId", frame.nextRouting?.counterId || ""),
                    operator: this._readValue("frame.nextRouting.operator", frame.nextRouting?.operator || COUNTER_OPERATORS.GTE),
                    value: Number(this._readValue("frame.nextRouting.value", frame.nextRouting?.value || 0) || 0),
                    trueFrameId: this._readValue("frame.nextRouting.trueFrameId", frame.nextRouting?.trueFrameId || ""),
                    falseFrameId: this._readValue("frame.nextRouting.falseFrameId", frame.nextRouting?.falseFrameId || "")
                };
            }
            frame.textBlocks = this._readTextBlocks();
            if (!frame.textBlocks.length) frame.textBlocks = [createTextBlock(frame.text || "")];
            frame.text = frame.textBlocks[0] ? frame.textBlocks[0].text : "";
            if (oldType !== FRAME_TYPES.CHOICE && frame.type === FRAME_TYPES.CHOICE && (!frame.choices || !frame.choices.length)) frame.choices = [createChoice(), createChoice()];
            if (frame.type !== FRAME_TYPES.CHOICE) frame.choices = [];
            else {
                frame.choices = [...this.element.querySelectorAll("[data-choice-row]")].map(row => ({
                    id: row.dataset.choiceId,
                    text: this._readRowValue(row, "[data-choice-text]", ""),
                    next: this._readRowValue(row, "[data-choice-next]", ""),
                    conditionCounterId: this._readRowValue(row, "[data-choice-condition-counter]", ""),
                    conditionOperator: this._readRowValue(row, "[data-choice-condition-operator]", ""),
                    conditionValue: this._readRowValue(row, "[data-choice-condition-value]", "0"),
                    effectCounterId: this._readRowValue(row, "[data-choice-effect-counter]", ""),
                    effectOperation: this._readRowValue(row, "[data-choice-effect-operation]", ""),
                    effectValue: this._readRowValue(row, "[data-choice-effect-value]", "0")
                }));
            }
        }
        const clean = sanitizeScene(scene);
        this._trackCommittedFormChanges(originalScene, clean, this.selectedFrameId);
        const changed = this._sceneChanged(clean);
        const saved = persist && changed ? await VNSceneStore.upsertScene(clean) : clean;
        this.selectedSceneId = saved.id;
        const currentFrame = saved.frames.find(item => item.id === this.selectedFrameId);
        if (!currentFrame) this.selectedFrameId = saved.frames[0] ? saved.frames[0].id : null;
        else this.selectedBranchId = currentFrame.branchId || this.selectedBranchId;
        return saved;
    }

    _readValue(name, fallback) {
        if (!this.element) return fallback;
        const input = this.element.querySelector(`[name='${name}']`);
        return input ? input.value : fallback;
    }

    _readRowValue(row, selector, fallback) {
        const input = row ? row.querySelector(selector) : null;
        return input ? input.value : fallback;
    }

    _readTextBlocks() {
        if (!this.element) return [];
        const rows = [...this.element.querySelectorAll("[data-text-block-row]")];
        return rows.map(row => {
            const editor = row.querySelector("[data-text-block-rich]");
            const fallbackText = editor ? editor.textContent || "" : "";
            const richText = sanitizeRichTextHtml(editor ? editor.innerHTML : "", { fallbackText });
            return {
                id: row.dataset.textBlockId || randomId("text"),
                text: richTextToPlainText(richText),
                richText,
                voice: this._readRowValue(row, "[data-text-block-voice]", "")
            };
        });
    }

    _readAudioCues(kind) {
        if (!this.element) return [];
        const rows = [...this.element.querySelectorAll(`[data-audio-cue-row][data-audio-kind="${kind}"]`)];
        return rows.map(row => ({
            id: row.dataset.audioCueId || randomId("audio"),
            action: this._readRowValue(row, "[data-audio-action]", AUDIO_ACTIONS.PLAY),
            channel: this._readRowValue(row, "[data-audio-channel]", ""),
            src: this._readRowValue(row, "[data-audio-src]", ""),
            loop: Boolean(row.querySelector("[data-audio-loop]")?.checked)
        }));
    }


    async _saveAndRender() {
        await this._commitFromForm();
        await this._renderPendingEditorParts();
    }

    _firstErrorFrameId(scene) {
        const issues = validateScene(scene);
        const first = issues.find(issue => issue.severity === "error" && issue.frameId);
        return first ? first.frameId : null;
    }

    async _ensureSceneCanRun(scene) {
        const issues = validateScene(scene);
        const errors = issues.filter(issue => issue.severity === "error");
        if (!errors.length) return true;
        const firstFrameId = this._firstErrorFrameId(scene);
        if (firstFrameId) this.selectedFrameId = firstFrameId;
        notifyError(`VN: запуск остановлен. Ошибок в катсцене: ${errors.length}.`);
        this._renderEditorParts(["frames", "framePanel"]);
        return false;
    }

    _referenceWarningText(refs) {
        const visible = refs.slice(0, 8).map(ref => `• ${ref.label}`).join("\n");
        const suffix = refs.length > 8 ? `\n• ещё ${refs.length - 8}` : "";
        return `${visible}${suffix}`;
    }

    static async _onCreateScene(event, target) {
        event.preventDefault();
        await this._commitFromForm();
        const scene = createScene();
        await VNSceneStore.upsertScene(scene);
        this.selectedSceneId = scene.id;
        this.selectedFrameId = scene.startFrame;
        this.selectedBranchId = scene.branches && scene.branches[0] ? scene.branches[0].id : null;
        this.selectedFolderId = null;
        this._renderEditorParts();
    }

    static async _onCreateSample(event, target) {
        event.preventDefault();
        await this._commitFromForm();
        const scene = createSampleScene();
        await VNSceneStore.upsertScene(scene);
        this.selectedSceneId = scene.id;
        this.selectedFrameId = scene.startFrame;
        this.selectedBranchId = scene.branches && scene.branches[0] ? scene.branches[0].id : null;
        this.selectedFolderId = null;
        this._renderEditorParts();
    }

    static async _onSelectScene(event, target) {
        event.preventDefault();
        await this._commitFromForm();
        const scene = VNSceneStore.getScene(target.dataset.sceneId);
        if (!scene) return;
        this.selectedSceneId = scene.id;
        this.selectedFrameId = scene.startFrame || (scene.frames && scene.frames[0] ? scene.frames[0].id : null);
        const frame = scene.frames && scene.frames.find(item => item.id === this.selectedFrameId);
        this.selectedBranchId = frame ? frame.branchId || (scene.branches && scene.branches[0] ? scene.branches[0].id : null) : (scene.branches && scene.branches[0] ? scene.branches[0].id : null);
        this.selectedFolderId = null;
        this._renderEditorParts();
    }

    static async _onDuplicateScene(event, target) {
        event.preventDefault();
        const current = await this._commitFromForm();
        if (!current) return;
        const copy = duplicateData(current);
        copy.id = randomId("scene");
        copy.title = `${copy.title} (копия)`;
        const idMap = new Map(copy.frames.map(frame => [frame.id, randomId("frame")]));
        for (const frame of copy.frames) {
            frame.id = idMap.get(frame.id);
            if (frame.next && idMap.has(frame.next)) frame.next = idMap.get(frame.next);
            if (frame.nextRouting?.trueFrameId && idMap.has(frame.nextRouting.trueFrameId)) frame.nextRouting.trueFrameId = idMap.get(frame.nextRouting.trueFrameId);
            if (frame.nextRouting?.falseFrameId && idMap.has(frame.nextRouting.falseFrameId)) frame.nextRouting.falseFrameId = idMap.get(frame.nextRouting.falseFrameId);
            frame.choices = (frame.choices || []).map(choice => Object.assign({}, choice, {
                id: randomId("choice"),
                next: choice.next && idMap.has(choice.next) ? idMap.get(choice.next) : choice.next
            }));
            frame.textBlocks = (frame.textBlocks || []).map(block => ({
                id: randomId("text"),
                text: block.text || "",
                richText: block.richText || richTextFromPlainText(block.text || ""),
                voice: block.voice || ""
            }));
        }
        copy.startFrame = idMap.get(copy.startFrame) || (copy.frames[0] ? copy.frames[0].id : "");
        await VNSceneStore.upsertScene(copy);
        this.selectedSceneId = copy.id;
        this.selectedFrameId = copy.startFrame;
        const frame = copy.frames && copy.frames.find(item => item.id === copy.startFrame);
        this.selectedBranchId = frame ? frame.branchId || (copy.branches && copy.branches[0] ? copy.branches[0].id : null) : (copy.branches && copy.branches[0] ? copy.branches[0].id : null);
        this.selectedFolderId = null;
        this._renderEditorParts();
    }

    static async _onDeleteScene(event, target) {
        event.preventDefault();
        const scene = this.selectedScene;
        if (!scene) return;
        if (!await confirmDialog(`Удалить катсцену «${scene.title}»?`, { title: "Удаление катсцены", yes: "Удалить", no: "Отмена" })) return;
        await VNSceneStore.deleteScene(scene.id);
        const next = VNSceneStore.scenes[0] || null;
        this.selectedSceneId = next ? next.id : null;
        this.selectedFrameId = next ? next.startFrame : null;
        this._renderEditorParts();
    }

    static async _onExportScene(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm();
        if (!scene) return;
        downloadJson(`${scene.title || "vn-scene"}.json`, scene);
    }

    static async _onExportAll(event, target) {
        event.preventDefault();
        await this._commitFromForm();
        downloadJson("fbl-vn-cutscenes.json", VNSceneStore.data);
    }

    static _onImportJson(event, target) {
        event.preventDefault();
        if (!this.element) return;
        const input = this.element.querySelector("input[type=file][data-import]");
        if (input) input.click();
    }

    async _handleImportInput(event) {
        const file = event.currentTarget && event.currentTarget.files ? event.currentTarget.files[0] : null;
        if (!file) return;
        try {
            const imported = await readJsonFile(file);
            await VNSceneStore.importData(imported);
            const firstImported = Array.isArray(imported && imported.scenes) ? imported.scenes[0] : (Array.isArray(imported) ? imported[0] : imported);
            this.selectedSceneId = firstImported && firstImported.id ? firstImported.id : (VNSceneStore.scenes[0] ? VNSceneStore.scenes[0].id : null);
            const scene = VNSceneStore.getScene(this.selectedSceneId);
            this.selectedFrameId = scene ? scene.startFrame : null;
            notify("VN: импорт завершён.");
        }
        catch (error) {
            console.error(error);
            notifyError("VN: не удалось импортировать JSON.");
        }
        finally {
            event.currentTarget.value = "";
            this._renderEditorParts();
        }
    }


    static async _onAddFrame(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        if (!scene) return;
        const type = target.dataset.type || FRAME_TYPES.DIALOGUE;
        const frame = createFrame(type);
        const current = scene.frames.find(item => item.id === this.selectedFrameId);
        frame.branchId = this.selectedBranchId || (current ? current.branchId || "" : "") || (scene.branches && scene.branches[0] ? scene.branches[0].id : "");
        frame.folderId = this.selectedFolderId || (current && current.branchId === frame.branchId ? current.folderId || "" : "");
        frame.sort = this._treeSiblings(scene, frame.folderId || "", frame.branchId || "").length * 1000;
        scene.frames.push(frame);
        await VNSceneStore.upsertScene(scene);
        this.selectedBranchId = frame.branchId;
        this.selectedFrameId = frame.id;
        this._renderEditorParts(["resources", "scenes", "frames", "sceneHead", "framePanel"]);
    }

    static async _onSelectFrame(event, target) {
        event.preventDefault();
        await this._commitFromForm();
        this.selectedFrameId = target.dataset.frameId;
        const scene = this.selectedScene;
        const frame = scene && Array.isArray(scene.frames) ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        this.selectedBranchId = frame && frame.branchId ? frame.branchId : this.selectedBranchId;
        this.selectedFolderId = frame && frame.folderId ? frame.folderId : null;
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static async _onSelectFolder(event, target) {
        event.preventDefault();
        await this._commitFromForm();
        this.selectedFolderId = target.dataset.folderId || null;
        this._renderEditorParts(["frames"]);
    }

    static async _onDuplicateFrame(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame) return;
        const copy = duplicateData(frame);
        copy.id = randomId("frame");
        copy.title = copy.title ? `${copy.title} (копия)` : "Копия кадра";
        copy.choices = (copy.choices || []).map(choice => Object.assign({}, choice, { id: randomId("choice") }));
        copy.textBlocks = (copy.textBlocks || []).map(block => Object.assign({}, block, { id: randomId("text") }));
        const index = scene.frames.findIndex(item => item.id === frame.id);
        copy.sort = Number(frame.sort || 0) + 1;
        scene.frames.splice(index + 1, 0, copy);
        this._normalizeTreeOrder(scene, copy.folderId || "", { type: "frame", id: copy.id }, this._treeSiblings(scene, copy.folderId || "", copy.branchId || "").findIndex(item => item.type === "frame" && item.id === frame.id) + 1, copy.branchId || "");
        this._rebuildFrameArrayByTree(scene);
        await VNSceneStore.upsertScene(scene);
        this.selectedFrameId = copy.id;
        this._renderEditorParts(["resources", "scenes", "frames", "sceneHead", "framePanel"]);
    }

    static async _onDeleteFrame(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        if (!scene || scene.frames.length <= 1) {
            notifyWarn("VN: в катсцене должен остаться хотя бы один кадр.");
            return;
        }
        const frameId = this.selectedFrameId;
        const index = scene.frames.findIndex(f => f.id === frameId);
        if (index < 0) return;
        const refs = getFrameReferences(scene, frameId);
        const externalRefs = refs.filter(ref => !(ref.type === "start" && scene.frames.length > 1));
        if (refs.length) {
            const text = this._referenceWarningText(refs);
            if (!await confirmDialog(`На этот кадр есть ссылки.\n\n${text}\n\nУдалить кадр и очистить эти ссылки?`, { title: "Удаление кадра", yes: "Удалить", no: "Отмена" })) return;
        }
        if (externalRefs.length) clearFrameReferences(scene, frameId);
        scene.frames.splice(index, 1);
        if (!scene.frames.some(f => f.id === scene.startFrame)) scene.startFrame = scene.frames[0].id;
        if (!scene.startFrame && scene.frames[0]) scene.startFrame = scene.frames[0].id;
        await VNSceneStore.upsertScene(scene);
        const previous = scene.frames[Math.max(0, index - 1)];
        this.selectedFrameId = previous ? previous.id : (scene.frames[0] ? scene.frames[0].id : null);
        this._renderEditorParts(["resources", "scenes", "frames", "sceneHead", "framePanel"]);
    }

    static async _onMoveFrame(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const direction = target.dataset.direction === "up" ? -1 : 1;
        if (!scene || !this.selectedFrameId) return;
        const rows = this._buildFrameTreeRows(scene, this._buildFrameViews(scene, new Map()));
        const index = rows.findIndex(row => row.isFrame && row.id === this.selectedFrameId);
        if (index < 0) return;
        const targetRow = rows[index + direction];
        if (!targetRow) return;
        const placement = direction < 0 ? "before" : "after";
        await this._moveTreeItem("frame", this.selectedFrameId, targetRow.isFolder ? "folder" : "frame", targetRow.id, placement, scene);
    }

    static async _onToggleFolder(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        if (!scene) return;
        const folderId = target.dataset.folderId || this.selectedFolderId || "";
        const folder = (scene.frameFolders || []).find(item => item.id === folderId);
        if (!folder) return;
        folder.collapsed = folder.collapsed !== true;
        this.selectedFolderId = folder.id;
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames"]);
    }

    static async _onEditFolder(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm();
        if (!scene) return;
        const folderId = target.dataset.folderId || this.selectedFolderId || "";
        const folder = (scene.frameFolders || []).find(item => item.id === folderId);
        if (!folder) return;
        this.selectedFolderId = folder.id;
        this.editingFolderId = folder.id;
        this._renderEditorParts(["frames"]);
    }

    static async _onCancelFolderEdit(event, target) {
        event.preventDefault();
        this.editingFolderId = null;
        this._renderEditorParts(["frames"]);
    }

    static async _onSaveFolderEdit(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        if (!scene) return;
        const row = target.closest ? target.closest("[data-tree-item]") : null;
        const folderId = target.dataset.folderId || (row ? row.dataset.itemId : "") || this.editingFolderId || this.selectedFolderId || "";
        const folder = (scene.frameFolders || []).find(item => item.id === folderId);
        if (!folder || !row) return;
        const nameInput = row.querySelector("[data-folder-name-input]");
        const colorInput = row.querySelector("[data-folder-color-input]");
        const name = nameInput ? String(nameInput.value || "").trim() : "";
        if (name) folder.name = name;
        if (colorInput) folder.color = sanitizeFolderColor(colorInput.value);
        this.selectedFolderId = folder.id;
        this.editingFolderId = null;
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames"]);
    }

    static async _onSelectBranch(event, target, requestedBranchId = null) {
        event.preventDefault();
        const scene = await this._commitFromForm();
        if (!scene) return;
        const branchId = requestedBranchId !== null ? requestedBranchId : (target.dataset.branchId || target.value || "");
        const branch = (scene.branches || []).find(item => item.id === branchId);
        if (!branch) return;
        this.selectedBranchId = branch.id;
        this.selectedFolderId = null;
        const firstFrame = (scene.frames || []).find(frame => frame.branchId === branch.id);
        this.selectedFrameId = firstFrame ? firstFrame.id : null;
        this._renderEditorParts(["resources", "frames", "sceneHead", "framePanel"]);
    }

    static async _onAddBranch(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        if (!scene) return;
        scene.branches = Array.isArray(scene.branches) ? scene.branches : [];
        let number = scene.branches.length + 1;
        let name = `Ветка ${number}`;
        while (scene.branches.some(branch => branch.name === name)) {
            number += 1;
            name = `Ветка ${number}`;
        }
        const branch = createSceneBranch(name);
        branch.sort = scene.branches.length * 1000;
        scene.branches.push(branch);
        this.selectedBranchId = branch.id;
        this.selectedFolderId = null;
        this.selectedFrameId = null;
        await VNSceneStore.upsertScene(scene);
        notify(`VN: создана ветка «${branch.name}».`);
        this._renderEditorParts(["resources", "frames", "sceneHead", "framePanel"]);
    }

    static async _onRenameBranch(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        if (!scene) return;
        const branchId = target.dataset.branchId || this.selectedBranchId || "";
        const branch = (scene.branches || []).find(item => item.id === branchId);
        if (!branch) return;
        const currentName = branch.name || "Ветка";
        const result = await formDialog({
            title: "Название ветки",
            submitLabel: "Сохранить",
            cancelLabel: "Отмена",
            content: `<label class="fbl-vn-modal-field"><span>Новое название</span><input type="text" name="name" value="${escapeHtml(currentName)}" placeholder="Название ветки" /></label>`
        });
        if (!result) return;
        const name = String(result.name || "").trim();
        if (!name) {
            notifyWarn("VN: укажи название ветки.");
            return;
        }
        branch.name = name;
        await VNSceneStore.upsertScene(scene);
        notify(`VN: ветка переименована в «${branch.name}».`);
        this._renderEditorParts(["resources", "frames", "sceneHead", "framePanel"]);
    }

    static async _onDuplicateBranch(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        if (!scene) return;
        const branchId = target.dataset.branchId || this.selectedBranchId || "";
        const root = (scene.branches || []).find(branch => branch.id === branchId);
        if (!root) {
            notifyWarn("VN: выбери ветку для копирования.");
            return;
        }
        const copyBranch = createSceneBranch(`${root.name || "Ветка"} (копия)`);
        copyBranch.sort = Number(root.sort || 0) + 1;
        const folderIdMap = new Map();
        const frameIdMap = new Map();
        const sourceFolders = (scene.frameFolders || []).filter(folder => folder.branchId === root.id);
        const sourceFrames = (scene.frames || []).filter(frame => frame.branchId === root.id);
        for (const folder of sourceFolders) folderIdMap.set(folder.id, randomId("folder"));
        for (const frame of sourceFrames) frameIdMap.set(frame.id, randomId("frame"));

        const copiedFolders = sourceFolders.map(folder => {
            const copy = duplicateData(folder);
            copy.id = folderIdMap.get(folder.id);
            copy.branchId = copyBranch.id;
            copy.parentId = folder.parentId && folderIdMap.has(folder.parentId) ? folderIdMap.get(folder.parentId) : "";
            return copy;
        });
        const copiedFrames = sourceFrames.map(frame => {
            const copy = duplicateData(frame);
            copy.id = frameIdMap.get(frame.id);
            copy.branchId = copyBranch.id;
            copy.folderId = frame.folderId && folderIdMap.has(frame.folderId) ? folderIdMap.get(frame.folderId) : "";
            if (copy.next && frameIdMap.has(copy.next)) copy.next = frameIdMap.get(copy.next);
            if (copy.nextRouting?.trueFrameId && frameIdMap.has(copy.nextRouting.trueFrameId)) copy.nextRouting.trueFrameId = frameIdMap.get(copy.nextRouting.trueFrameId);
            if (copy.nextRouting?.falseFrameId && frameIdMap.has(copy.nextRouting.falseFrameId)) copy.nextRouting.falseFrameId = frameIdMap.get(copy.nextRouting.falseFrameId);
            copy.choices = (copy.choices || []).map(choice => Object.assign({}, choice, {
                id: randomId("choice"),
                next: choice.next && frameIdMap.has(choice.next) ? frameIdMap.get(choice.next) : choice.next
            }));
            copy.textBlocks = (copy.textBlocks || []).map(block => Object.assign({}, block, { id: randomId("text") }));
            return copy;
        });

        scene.branches.push(copyBranch);
        scene.frameFolders.push(...copiedFolders);
        scene.frames.push(...copiedFrames);
        scene.branches.sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
        scene.branches.forEach((branch, index) => { branch.sort = index * 1000; });
        this._rebuildFrameArrayByTree(scene);
        await VNSceneStore.upsertScene(scene);
        this.selectedBranchId = copyBranch.id;
        this.selectedFolderId = null;
        this.selectedFrameId = copiedFrames[0] ? copiedFrames[0].id : null;
        notify(`VN: ветка «${root.name}» скопирована.`);
        this._renderEditorParts(["resources", "frames", "sceneHead", "framePanel"]);
    }

    static async _onDeleteBranch(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        if (!scene) return;
        const branchId = target.dataset.branchId || this.selectedBranchId || "";
        const branch = (scene.branches || []).find(item => item.id === branchId);
        if (!branch) return;
        if ((scene.branches || []).length <= 1) {
            notifyWarn("VN: в катсцене должна остаться хотя бы одна ветка.");
            return;
        }
        const candidates = (scene.branches || []).filter(item => item.id !== branchId);
        const frameCount = (scene.frames || []).filter(frame => frame.branchId === branchId).length;
        const options = candidates.map((item, index) => `<option value="${escapeHtml(item.id)}" ${index === 0 ? "selected" : ""}>${escapeHtml(item.name || `Ветка ${index + 1}`)}</option>`).join("");
        const result = await formDialog({
            title: `Удаление ветки «${branch.name || "Ветка"}»`,
            submitLabel: "Выполнить",
            cancelLabel: "Отмена",
            danger: true,
            content: `
              <p class="fbl-vn-modal-note">В ветке кадров: ${frameCount}.</p>
              <label class="fbl-vn-modal-option"><input type="radio" name="mode" value="move" checked /> <span>Перенести кадры в другую ветку</span></label>
              <label class="fbl-vn-modal-field"><span>Куда переносить</span><select name="targetBranchId">${options}</select></label>
              <label class="fbl-vn-modal-option"><input type="radio" name="mode" value="delete" /> <span>Удалить ветку вместе с кадрами</span></label>`
        });
        if (!result) return;
        const mode = String(result.mode || "move");
        if (mode === "move") {
            const targetBranch = candidates.find(item => item.id === result.targetBranchId) || candidates[0] || null;
            if (!targetBranch) {
                notifyWarn("VN: выбери ветку, куда перенести кадры удаляемой ветки.");
                return;
            }
            for (const folder of scene.frameFolders || []) {
                if (folder.branchId === branchId) folder.branchId = targetBranch.id;
            }
            for (const frame of scene.frames || []) {
                if (frame.branchId === branchId) frame.branchId = targetBranch.id;
            }
            scene.branches = (scene.branches || []).filter(item => item.id !== branchId);
            this.selectedBranchId = targetBranch.id;
            const first = (scene.frames || []).find(frame => frame.branchId === targetBranch.id);
            this.selectedFrameId = first ? first.id : null;
        }
        else {
            const deletedFrameIds = (scene.frames || []).filter(frame => frame.branchId === branchId).map(frame => frame.id);
            for (const frameId of deletedFrameIds) clearFrameReferences(scene, frameId);
            scene.frames = (scene.frames || []).filter(frame => frame.branchId !== branchId);
            scene.frameFolders = (scene.frameFolders || []).filter(folder => folder.branchId !== branchId);
            scene.branches = (scene.branches || []).filter(item => item.id !== branchId);
            const nextBranch = candidates[0] || scene.branches[0] || null;
            this.selectedBranchId = nextBranch ? nextBranch.id : null;
            const first = nextBranch ? (scene.frames || []).find(frame => frame.branchId === nextBranch.id) : null;
            this.selectedFrameId = first ? first.id : ((scene.frames || [])[0]?.id || null);
        }
        this.selectedFolderId = null;
        this._rebuildFrameArrayByTree(scene);
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["resources", "frames", "sceneHead", "framePanel"]);
    }

    static async _onAddFolder(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        if (!scene) return;
        scene.frameFolders = Array.isArray(scene.frameFolders) ? scene.frameFolders : [];
        const branchId = this.selectedBranchId || (scene.branches && scene.branches[0] ? scene.branches[0].id : "");
        const frame = scene.frames.find(item => item.id === this.selectedFrameId);
        const requestedParent = target.dataset.parentId || this.selectedFolderId || (frame && frame.branchId === branchId ? frame.folderId : "") || "";
        const parentId = scene.frameFolders.some(folder => folder.id === requestedParent && folder.branchId === branchId) ? requestedParent : "";
        let number = scene.frameFolders.length + 1;
        let name = `Новая папка ${number}`;
        while (scene.frameFolders.some(folder => folder.name === name)) {
            number += 1;
            name = `Новая папка ${number}`;
        }
        const folder = createFrameFolder(name, parentId, { branchId });
        folder.sort = this._treeSiblings(scene, parentId, branchId).length * 1000;
        scene.frameFolders.push(folder);
        this.selectedFolderId = folder.id;
        await VNSceneStore.upsertScene(scene);
        notify(`VN: создана папка «${folder.name}».`);
        this._renderEditorParts(["resources", "frames", "sceneHead", "framePanel"]);
    }

    static async _onRenameFolder(event, target) {
        return VNEditorApp._onEditFolder.call(this, event, target);
    }

    static async _onDeleteFolder(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene && Array.isArray(scene.frames) ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        const folderId = target.dataset.folderId || this.selectedFolderId || (frame ? frame.folderId : "");
        if (!scene || !folderId) {
            notifyWarn("VN: выбери папку.");
            return;
        }
        const folder = (scene.frameFolders || []).find(item => item.id === folderId);
        if (!folder) return;
        if (!await confirmDialog(`Удалить папку «${folder.name}»? Вложенные папки и кадры останутся без папки.`, { title: "Удаление папки", yes: "Удалить", no: "Отмена" })) return;
        const removed = new Set([folderId]);
        let changed = true;
        while (changed) {
            changed = false;
            for (const item of scene.frameFolders || []) {
                if (!removed.has(item.id) && removed.has(item.parentId || "")) {
                    removed.add(item.id);
                    changed = true;
                }
            }
        }
        scene.frameFolders = (scene.frameFolders || []).filter(item => !removed.has(item.id));
        for (const item of scene.frames) {
            if (removed.has(item.folderId || "")) item.folderId = "";
        }
        if (removed.has(this.selectedFolderId)) this.selectedFolderId = null;
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["resources", "frames", "sceneHead", "framePanel"]);
    }

    static async _onAddTextBlock(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame) return;
        frame.textBlocks = Array.isArray(frame.textBlocks) ? frame.textBlocks : [];
        frame.textBlocks.push(createTextBlock(""));
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static async _onDeleteTextBlock(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame) return;
        if (!Array.isArray(frame.textBlocks) || frame.textBlocks.length <= 1) {
            notifyWarn("VN: в кадре должен остаться хотя бы один текстовый блок.");
            return;
        }
        frame.textBlocks = frame.textBlocks.filter(block => block.id !== target.dataset.textBlockId);
        frame.text = frame.textBlocks[0] ? frame.textBlocks[0].text : "";
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static async _onDuplicateTextBlock(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame || !Array.isArray(frame.textBlocks)) return;
        const index = frame.textBlocks.findIndex(block => block.id === target.dataset.textBlockId);
        if (index < 0) return;
        const copy = duplicateData(frame.textBlocks[index]);
        copy.id = randomId("text");
        frame.textBlocks.splice(index + 1, 0, copy);
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static async _onMoveTextBlock(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame || !Array.isArray(frame.textBlocks)) return;
        const direction = target.dataset.direction === "up" ? -1 : 1;
        const index = frame.textBlocks.findIndex(block => block.id === target.dataset.textBlockId);
        const nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= frame.textBlocks.length) return;
        const moved = frame.textBlocks.splice(index, 1)[0];
        frame.textBlocks.splice(nextIndex, 0, moved);
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static async _onAddAudioCue(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame) return;
        const kind = target.dataset.audioKind === "sfx" ? "sfx" : "music";
        const key = kind === "sfx" ? "sfxCues" : "musicCues";
        const requestedAction = target.dataset.audioAction;
        const action = Object.values(AUDIO_ACTIONS).includes(requestedAction) ? requestedAction : AUDIO_ACTIONS.PLAY;
        frame[key] = Array.isArray(frame[key]) ? frame[key] : [];
        const cue = createAudioCue(kind, { action });
        if (action !== AUDIO_ACTIONS.STOP_ALL) cue.channel = this._nextAudioChannel(scene, kind);
        frame[key].push(cue);
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static async _onDeleteAudioCue(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame) return;
        const kind = target.dataset.audioKind === "sfx" ? "sfx" : "music";
        const key = kind === "sfx" ? "sfxCues" : "musicCues";
        frame[key] = (frame[key] || []).filter(cue => cue.id !== target.dataset.audioCueId);
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static async _onDuplicateAudioCue(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame) return;
        const kind = target.dataset.audioKind === "sfx" ? "sfx" : "music";
        const key = kind === "sfx" ? "sfxCues" : "musicCues";
        const cues = Array.isArray(frame[key]) ? frame[key] : [];
        const index = cues.findIndex(cue => cue.id === target.dataset.audioCueId);
        if (index < 0) return;
        const copy = duplicateData(cues[index]);
        copy.id = randomId("audio");
        if (copy.action !== AUDIO_ACTIONS.STOP_ALL) copy.channel = this._nextAudioChannel(scene, kind);
        cues.splice(index + 1, 0, copy);
        frame[key] = cues;
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static async _onMoveAudioCue(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame) return;
        const kind = target.dataset.audioKind === "sfx" ? "sfx" : "music";
        const key = kind === "sfx" ? "sfxCues" : "musicCues";
        const cues = Array.isArray(frame[key]) ? frame[key] : [];
        const index = cues.findIndex(cue => cue.id === target.dataset.audioCueId);
        if (index < 0) return;
        const direction = target.dataset.direction === "up" ? -1 : 1;
        const nextIndex = index + direction;
        if (nextIndex < 0 || nextIndex >= cues.length) return;
        const moved = cues.splice(index, 1)[0];
        cues.splice(nextIndex, 0, moved);
        frame[key] = cues;
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static async _onAddChoice(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene ? scene.frames.find(f => f.id === this.selectedFrameId) : null;
        if (!frame) return;
        frame.type = FRAME_TYPES.CHOICE;
        frame.choices || (frame.choices = []);
        frame.choices.push(createChoice());
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static async _onDeleteChoice(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene ? scene.frames.find(f => f.id === this.selectedFrameId) : null;
        if (!frame) return;
        frame.choices = (frame.choices || []).filter(choice => choice.id !== target.dataset.choiceId);
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static async _onDuplicateChoice(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene ? scene.frames.find(f => f.id === this.selectedFrameId) : null;
        if (!frame || !Array.isArray(frame.choices)) return;
        const index = frame.choices.findIndex(choice => choice.id === target.dataset.choiceId);
        if (index < 0) return;
        const copy = duplicateData(frame.choices[index]);
        copy.id = randomId("choice");
        copy.text = copy.text ? `${copy.text} (копия)` : "Новый выбор";
        frame.choices.splice(index + 1, 0, copy);
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static async _onMoveChoice(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene ? scene.frames.find(f => f.id === this.selectedFrameId) : null;
        if (!frame || !Array.isArray(frame.choices)) return;
        const direction = target.dataset.direction === "up" ? -1 : 1;
        const index = frame.choices.findIndex(choice => choice.id === target.dataset.choiceId);
        if (index < 0) return;
        const nextIndex = index + direction;
        if (nextIndex < 0 || nextIndex >= frame.choices.length) return;
        const moved = frame.choices.splice(index, 1)[0];
        frame.choices.splice(nextIndex, 0, moved);
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static _onClearFrameTarget(event, target) {
        event.preventDefault();
        const row = target.closest ? target.closest("[data-choice-row]") : null;
        const hidden = row ? row.querySelector("[data-choice-next]") : (this.element ? this.element.querySelector(`[name='${target.dataset.field || ""}']`) : null);
        const search = row ? row.querySelector("[data-frame-target-search]") : (target.closest(".fbl-vn-target-picker")?.querySelector("[data-frame-target-search]") || null);
        if (hidden) hidden.value = "";
        if (search) search.value = target.dataset.emptyLabel || "";
    }

    static async _onAddFrameCharacter(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene && Array.isArray(scene.frames) ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame) return;
        frame.additionalCharacters = Array.isArray(frame.additionalCharacters) ? frame.additionalCharacters : [];
        const occupied = new Set();
        if (frame.hidePortrait !== true && frame.portrait) occupied.add(frame.portraitPosition || "left");
        for (const character of frame.additionalCharacters) {
            if (character?.portrait) occupied.add(character.portraitPosition || "right");
        }
        const portraitPosition = ["right", "left", "center"].find(position => !occupied.has(position)) || "right";
        frame.additionalCharacters.push(createFrameCharacter({ portraitPosition }));
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["resources", "frames", "framePanel"]);
    }

    static async _onDeleteFrameCharacter(event, target) {
        event.preventDefault();
        const entryId = target.dataset.frameCharacterId || "";
        if (!entryId) return;
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene && Array.isArray(scene.frames) ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame) return;
        frame.additionalCharacters = (Array.isArray(frame.additionalCharacters) ? frame.additionalCharacters : [])
            .filter(character => character.id !== entryId);
        await VNSceneStore.upsertScene(scene);
        this._renderEditorParts(["resources", "frames", "framePanel"]);
    }

    static _onPickAsset(event, target) {
        event.preventDefault();
        const field = target.dataset.field;
        const type = target.dataset.pickerType || "image";
        const input = this.element ? this.element.querySelector(`[name='${field}']`) : null;
        if (!field || !input) return;
        new VNAssetPickerApp({
            type,
            current: input.value || "",
            label: target.dataset.label || target.title || "Ассет",
            onSelect: async (path) => {
                await this._enqueueEditorAction(async () => {
                    const freshInput = this.element ? this.element.querySelector(`[name='${field}']`) : null;
                    if (!freshInput) return;
                    freshInput.value = path;
                    await this._saveAndRender();
                });
            }
        }).render(true);
    }

    static async _onSaveCharacterPreset(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm({ persist: false });
        const frame = scene && Array.isArray(scene.frames) ? scene.frames.find(item => item.id === this.selectedFrameId) : null;
        if (!scene || !frame) return;
        frame.speaker = String(frame.speaker || "").trim();
        frame.portrait = String(frame.portrait || "").trim();
        if (!frame.speaker) {
            notifyWarn("VN: укажи имя говорящего перед сохранением пресета.");
            return;
        }
        const portraitLabel = frame.portrait ? this._labelFromPath(frame.portrait, "Основной") : "Без портрета";
        const character = await VNSceneStore.saveCharacterFromFrame(frame, portraitLabel);
        if (character) {
            frame.characterId = character.id;
            const portraits = Array.isArray(character.portraits) ? character.portraits : [];
            const portrait = portraits.find(item => item.path === frame.portrait) || portraits[0] || null;
            frame.portraitId = portrait ? portrait.id : "";
            await VNSceneStore.upsertScene(scene);
            notify(`VN: пресет персонажа «${character.name}» сохранён.`);
        }
        this._renderEditorParts(["frames", "framePanel"]);
    }

    static _onOpenCharacterManager(event, target) {
        event.preventDefault();
        new VNCharacterManagerApp({ editor: this }).render(true);
    }

    static async _onOpenGraph(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm();
        if (!scene) return;
        new VNGraphApp({ sceneId: scene.id }).render(true);
    }

    static async _onSave(event, target) {
        event.preventDefault();
        await this._commitFromForm();
        notify("VN: сохранено.");
        await this._renderPendingEditorParts();
    }

    static async _onOpenCounterManager(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm();
        if (!scene) return;
        return new VNCounterManagerApp({ sceneId: scene.id, editor: this }).render(true);
    }

    static async _onPreview(event, target) {
        event.preventDefault();
        const scene = await this._commitFromForm();
        if (!scene) return;
        if (!(await this._ensureSceneCanRun(scene))) return;
        const app = await VNPlayerApp.openScene({ scene, mode: PLAYER_MODES.INDIVIDUAL, leaderId: game.user.id, networked: false });
        await app.preload();
        await app.start();
    }

    static async _onStartIndividual(event, target) {
        event.preventDefault();
        if (!game.user.isGM) return;
        const scene = await this._commitFromForm();
        if (!scene) return;
        if (!(await this._ensureSceneCanRun(scene))) return;
        await VNSocket.openForPlayers(scene, { mode: PLAYER_MODES.INDIVIDUAL });
    }

    static async _onStartGm(event, target) {
        event.preventDefault();
        if (!game.user.isGM) return;
        const scene = await this._commitFromForm();
        if (!scene) return;
        if (!(await this._ensureSceneCanRun(scene))) return;
        await VNSocket.openForPlayers(scene, { mode: PLAYER_MODES.GM });
    }

    static async _onStartVote(event, target) {
        event.preventDefault();
        if (!game.user.isGM) return;
        const scene = await this._commitFromForm();
        if (!scene) return;
        if (!(await this._ensureSceneCanRun(scene))) return;
        await VNSocket.openForPlayers(scene, { mode: PLAYER_MODES.VOTE });
    }
}

VNEditorApp.DEFAULT_OPTIONS = {
    id: "fbl-vn-editor",
    classes: ["fbl-vn-editor-app"],
    tag: "section",
    window: {
        title: "VN Cutscene Editor",
        icon: "fa-solid fa-film",
        resizable: true,
        contentClasses: ["fbl-vn-ui", "fbl-vn-editor"]
    },
    position: {
        width: 1440,
        height: 860
    },
    actions: {
        createScene: queuedEditorAction(VNEditorApp._onCreateScene),
        createSample: queuedEditorAction(VNEditorApp._onCreateSample),
        selectScene: queuedEditorAction(VNEditorApp._onSelectScene),
        duplicateScene: queuedEditorAction(VNEditorApp._onDuplicateScene),
        deleteScene: queuedEditorAction(VNEditorApp._onDeleteScene),
        exportScene: queuedEditorAction(VNEditorApp._onExportScene),
        exportAll: queuedEditorAction(VNEditorApp._onExportAll),
        importJson: queuedEditorAction(VNEditorApp._onImportJson),
        addFrame: queuedEditorAction(VNEditorApp._onAddFrame),
        selectFrame: queuedEditorAction(VNEditorApp._onSelectFrame),
        selectFolder: queuedEditorAction(VNEditorApp._onSelectFolder),
        duplicateFrame: queuedEditorAction(VNEditorApp._onDuplicateFrame),
        deleteFrame: queuedEditorAction(VNEditorApp._onDeleteFrame),
        moveFrame: queuedEditorAction(VNEditorApp._onMoveFrame),
        selectBranch: queuedEditorAction(VNEditorApp._onSelectBranch),
        addBranch: queuedEditorAction(VNEditorApp._onAddBranch),
        renameBranch: queuedEditorAction(VNEditorApp._onRenameBranch),
        duplicateBranch: queuedEditorAction(VNEditorApp._onDuplicateBranch),
        deleteBranch: queuedEditorAction(VNEditorApp._onDeleteBranch),
        addFolder: queuedEditorAction(VNEditorApp._onAddFolder),
        toggleFolder: queuedEditorAction(VNEditorApp._onToggleFolder),
        editFolder: queuedEditorAction(VNEditorApp._onEditFolder),
        saveFolderEdit: queuedEditorAction(VNEditorApp._onSaveFolderEdit),
        cancelFolderEdit: queuedEditorAction(VNEditorApp._onCancelFolderEdit),
        renameFolder: queuedEditorAction(VNEditorApp._onRenameFolder),
        deleteFolder: queuedEditorAction(VNEditorApp._onDeleteFolder),
        addTextBlock: queuedEditorAction(VNEditorApp._onAddTextBlock),
        deleteTextBlock: queuedEditorAction(VNEditorApp._onDeleteTextBlock),
        duplicateTextBlock: queuedEditorAction(VNEditorApp._onDuplicateTextBlock),
        moveTextBlock: queuedEditorAction(VNEditorApp._onMoveTextBlock),
        addAudioCue: queuedEditorAction(VNEditorApp._onAddAudioCue),
        deleteAudioCue: queuedEditorAction(VNEditorApp._onDeleteAudioCue),
        duplicateAudioCue: queuedEditorAction(VNEditorApp._onDuplicateAudioCue),
        moveAudioCue: queuedEditorAction(VNEditorApp._onMoveAudioCue),
        addChoice: queuedEditorAction(VNEditorApp._onAddChoice),
        deleteChoice: queuedEditorAction(VNEditorApp._onDeleteChoice),
        duplicateChoice: queuedEditorAction(VNEditorApp._onDuplicateChoice),
        moveChoice: queuedEditorAction(VNEditorApp._onMoveChoice),
        clearFrameTarget: queuedEditorAction(VNEditorApp._onClearFrameTarget),
        addFrameCharacter: queuedEditorAction(VNEditorApp._onAddFrameCharacter),
        deleteFrameCharacter: queuedEditorAction(VNEditorApp._onDeleteFrameCharacter),
        pickAsset: queuedEditorAction(VNEditorApp._onPickAsset),
        saveCharacterPreset: queuedEditorAction(VNEditorApp._onSaveCharacterPreset),
        openCharacterManager: queuedEditorAction(VNEditorApp._onOpenCharacterManager),
        openCounterManager: queuedEditorAction(VNEditorApp._onOpenCounterManager),
        openGraph: queuedEditorAction(VNEditorApp._onOpenGraph),
        save: queuedEditorAction(VNEditorApp._onSave),
        preview: queuedEditorAction(VNEditorApp._onPreview),
        startIndividual: queuedEditorAction(VNEditorApp._onStartIndividual),
        startGm: queuedEditorAction(VNEditorApp._onStartGm),
        startVote: queuedEditorAction(VNEditorApp._onStartVote)
    }
};

VNEditorApp.PARTS = {
    resources: {
        template: `modules/${MODULE_ID}/templates/editor-resources.hbs`
    },
    scenes: {
        template: `modules/${MODULE_ID}/templates/editor-scenes.hbs`,
        scrollable: [".fbl-vn-scene-list"]
    },
    frames: {
        template: `modules/${MODULE_ID}/templates/editor-frames.hbs`,
        scrollable: [".fbl-vn-frame-list"]
    },
    sceneHead: {
        template: `modules/${MODULE_ID}/templates/editor-scene-head.hbs`
    },
    framePanel: {
        template: `modules/${MODULE_ID}/templates/editor-frame-panel.hbs`,
        scrollable: [""]
    },
    bottomActions: {
        template: `modules/${MODULE_ID}/templates/editor-bottom-actions.hbs`
    },
    empty: {
        template: `modules/${MODULE_ID}/templates/editor-empty.hbs`
    }
};
