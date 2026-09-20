import { AUDIO_ACTIONS, COUNTER_EFFECTS, COUNTER_OPERATORS, FRAME_TYPES, PLAYER_MODES, TEXT_PRESENTATIONS } from "../utils/constants.js";
import { duplicateData, randomId } from "../utils/foundry-helpers.js";
import { richTextFromPlainText, richTextToPlainText, sanitizeRichTextHtml } from "../utils/rich-text.js";

export const ISSUE_SEVERITY = {
    ERROR: "error",
    WARNING: "warning"
};

export function createTextBlock(text, voice, richText) {
    const plainText = text !== undefined && text !== null ? String(text) : "";
    const safeRichText = sanitizeRichTextHtml(
        richText !== undefined && richText !== null ? richText : richTextFromPlainText(plainText),
        { fallbackText: plainText }
    );
    return {
        id: randomId("text"),
        text: richTextToPlainText(safeRichText),
        richText: safeRichText,
        voice: voice || ""
    };
}

export function createFrameFolder(name, parentId, options = {}) {
    return {
        id: randomId("folder"),
        name: name || "Новая папка",
        branchId: options.branchId || "",
        parentId: parentId || "",
        sort: 0,
        collapsed: false,
        color: "#b68a4a"
    };
}

export function createSceneBranch(name = "Основная ветка") {
    return {
        id: randomId("branch"),
        name: name || "Основная ветка",
        sort: 0
    };
}

export function createSceneCounter(name = "Новый счётчик", initial = 0) {
    return {
        id: randomId("counter"),
        name: name || "Новый счётчик",
        initial: normalizeNumber(initial, 0)
    };
}

export function createFrameNextRouting() {
    return {
        enabled: false,
        counterId: "",
        operator: COUNTER_OPERATORS.GTE,
        value: 0,
        trueFrameId: "",
        falseFrameId: ""
    };
}

export function createAudioCue(kind = "music", options = {}) {
    const isMusic = kind === "music";
    return {
        id: randomId("audio"),
        action: Object.values(AUDIO_ACTIONS).includes(options.action) ? options.action : AUDIO_ACTIONS.PLAY,
        channel: String(options.channel || ""),
        src: String(options.src || ""),
        loop: options.loop === undefined ? isMusic : options.loop === true
    };
}

export function createFrame(type = FRAME_TYPES.DIALOGUE) {
    const base = {
        id: randomId("frame"),
        type,
        title: "",
        branchId: "",
        folderId: "",
        sort: 0,
        isFinal: false,
        background: "",
        clearBackground: false,
        transition: "fade",
        characterId: "",
        portraitId: "",
        speaker: "",
        portrait: "",
        hidePortrait: false,
        portraitPosition: "center",
        textPresentation: TEXT_PRESENTATIONS.BOX,
        text: "",
        textBlocks: [createTextBlock("")],
        musicCues: [],
        sfxCues: [],
        next: "",
        nextRouting: createFrameNextRouting(),
        choices: []
    };
    if (type === FRAME_TYPES.CHOICE) {
        base.speaker = "";
        base.text = "Выберите действие.";
        base.textBlocks = [createTextBlock("Выберите действие.")];
        base.choices = [createChoice(), createChoice()];
    }
    if (type === FRAME_TYPES.NARRATION) {
        base.speaker = "";
        base.portrait = "";
        base.hidePortrait = true;
        base.text = "Текст наррации.";
        base.textBlocks = [createTextBlock("Текст наррации.")];
    }
    return base;
}

export function createChoice() {
    return {
        id: randomId("choice"),
        text: "Новый выбор",
        next: "",
        conditionCounterId: "",
        conditionOperator: COUNTER_OPERATORS.NONE,
        conditionValue: 0,
        effectCounterId: "",
        effectOperation: COUNTER_EFFECTS.NONE,
        effectValue: 0
    };
}

export function createScene() {
    const branch = createSceneBranch("Основная ветка");
    const first = createFrame(FRAME_TYPES.NARRATION);
    first.branchId = branch.id;
    first.text = "Новая катсцена.";
    first.textBlocks = [createTextBlock("Новая катсцена.")];
    return {
        id: randomId("scene"),
        title: "Новая катсцена",
        description: "",
        defaultMode: PLAYER_MODES.INDIVIDUAL,
        counters: [],
        branches: [branch],
        startFrame: first.id,
        frameFolders: [],
        graphPositions: {},
        frames: [first]
    };
}

export function createSampleScene() {
    const branch = createSceneBranch("Основная ветка");
    const f1 = createFrame(FRAME_TYPES.NARRATION);
    f1.title = "Начало";
    f1.text = "Холодный металлический звон медленно ползёт по стенам.";
    f1.textBlocks = [createTextBlock("Холодный металлический звон медленно ползёт по стенам.")];
    f1.transition = "fade";
    const f2 = createFrame(FRAME_TYPES.DIALOGUE);
    f2.title = "Реплика";
    f2.speaker = "Неизвестный";
    f2.text = "Ты слышишь меня?";
    f2.textBlocks = [createTextBlock("Ты слышишь меня?")];
    f2.portraitPosition = "right";
    f2.transition = "fade";
    const f3 = createFrame(FRAME_TYPES.CHOICE);
    f3.title = "Выбор";
    f3.text = "Ответить или промолчать?";
    f3.textBlocks = [createTextBlock("Ответить или промолчать?")];
    f3.choices[0].text = "Ответить";
    f3.choices[0].next = "";
    f3.choices[1].text = "Промолчать";
    f3.choices[1].next = "";
    f1.branchId = branch.id;
    f2.branchId = branch.id;
    f3.branchId = branch.id;
    f1.next = f2.id;
    f2.next = f3.id;
    return {
        id: randomId("scene"),
        title: "Пример VN-катсцены",
        description: "Минимальный пример: наррация, реплика и выбор.",
        defaultMode: PLAYER_MODES.INDIVIDUAL,
        counters: [],
        branches: [branch],
        startFrame: f1.id,
        frameFolders: [],
        graphPositions: {},
        frames: [f1, f2, f3]
    };
}

export function sanitizeScene(scene) {
    const clean = duplicateData(scene !== null && scene !== void 0 ? scene : {});
    clean.id || (clean.id = randomId("scene"));
    clean.title || (clean.title = "Без названия");
    clean.description || (clean.description = "");
    clean.defaultMode = Object.values(PLAYER_MODES).includes(clean.defaultMode) ? clean.defaultMode : PLAYER_MODES.INDIVIDUAL;
    clean.counters = Array.isArray(clean.counters) ? clean.counters.map(sanitizeSceneCounter) : [];
    clean.branches = Array.isArray(clean.branches) ? clean.branches.map(sanitizeSceneBranch) : [];
    if (!clean.branches.length) clean.branches.push(createSceneBranch("Основная ветка"));
    for (let i = 0; i < clean.branches.length; i += 1) {
        if (!Number.isFinite(Number(clean.branches[i].sort)) || Number(clean.branches[i].sort) < 0) clean.branches[i].sort = i * 1000;
    }
    clean.branches.sort((a, b) => Number(a.sort || 0) - Number(b.sort || 0));
    const defaultBranchId = clean.branches[0].id;
    const branchIds = new Set(clean.branches.map(branch => branch.id));

    clean.frameFolders = Array.isArray(clean.frameFolders) ? clean.frameFolders.map(sanitizeFrameFolder) : [];
    for (let i = 0; i < clean.frameFolders.length; i += 1) {
        const folder = clean.frameFolders[i];
        if (!branchIds.has(folder.branchId)) folder.branchId = defaultBranchId;
        if (!Number.isFinite(Number(folder.sort)) || Number(folder.sort) < 0) folder.sort = i * 1000;
    }
    clean.frames = Array.isArray(clean.frames) ? clean.frames : [];
    const legacyFrameRoutingIds = new Set(clean.frames
        .filter(frame => frame && typeof frame === "object" && frame.sceneRouting && typeof frame.sceneRouting === "object")
        .map(frame => frame.id)
        .filter(Boolean));
    if (!clean.frames.length) {
        const frame = createFrame(FRAME_TYPES.NARRATION);
        frame.branchId = defaultBranchId;
        clean.frames.push(frame);
    }
    clean.frames = clean.frames.map(sanitizeFrame);
    const localFrameIds = new Set(clean.frames.map(frame => frame.id));
    for (const frame of clean.frames) {
        if (!legacyFrameRoutingIds.has(frame.id)) continue;
        if (frame.nextRouting.trueFrameId && !localFrameIds.has(frame.nextRouting.trueFrameId)) frame.nextRouting.trueFrameId = "";
        if (frame.nextRouting.falseFrameId && !localFrameIds.has(frame.nextRouting.falseFrameId)) frame.nextRouting.falseFrameId = "";
        frame.isFinal = false;
    }
    delete clean.exitRouting;
    for (let i = 0; i < clean.frames.length; i += 1) {
        const frame = clean.frames[i];
        if (!branchIds.has(frame.branchId)) frame.branchId = defaultBranchId;
        if (!Number.isFinite(Number(frame.sort)) || Number(frame.sort) < 0) frame.sort = i * 1000;
    }
    clean.graphPositions = sanitizeGraphPositions(clean.graphPositions);
    const folderMap = new Map(clean.frameFolders.map(folder => [folder.id, folder]));
    for (const folder of clean.frameFolders) {
        const parent = folder.parentId ? folderMap.get(folder.parentId) : null;
        if (folder.parentId && (!parent || parent.id === folder.id || parent.branchId !== folder.branchId)) folder.parentId = "";
    }
    _breakFolderCycles(clean.frameFolders);
    const folderIds = new Set(clean.frameFolders.map(folder => folder.id));
    for (const frame of clean.frames) {
        const folder = frame.folderId ? folderMap.get(frame.folderId) : null;
        if (frame.folderId && (!folderIds.has(frame.folderId) || !folder || folder.branchId !== frame.branchId)) frame.folderId = "";
    }
    clean.startFrame || (clean.startFrame = clean.frames[0] ? clean.frames[0].id : "");
    if (!clean.frames.some(f => f.id === clean.startFrame)) clean.startFrame = clean.frames[0] ? clean.frames[0].id : "";
    return clean;
}

export function sanitizeFrameFolder(folder) {
    const clean = duplicateData(folder !== null && folder !== void 0 ? folder : {});
    clean.id || (clean.id = randomId("folder"));
    clean.name = clean.name || "Папка";
    clean.branchId || (clean.branchId = "");
    clean.parentId || (clean.parentId = "");
    clean.sort = Number(clean.sort);
    if (!Number.isFinite(clean.sort)) clean.sort = -1;
    clean.collapsed = clean.collapsed === true;
    clean.color = sanitizeFolderColor(clean.color);
    delete clean.isBranch;
    return clean;
}

export function sanitizeSceneBranch(branch) {
    const clean = duplicateData(branch !== null && branch !== void 0 ? branch : {});
    clean.id || (clean.id = randomId("branch"));
    clean.name = String(clean.name || "Ветка").trim() || "Ветка";
    clean.sort = Number(clean.sort);
    if (!Number.isFinite(clean.sort)) clean.sort = -1;
    return clean;
}

export function sanitizeSceneCounter(counter) {
    const clean = duplicateData(counter !== null && counter !== void 0 ? counter : {});
    clean.id || (clean.id = randomId("counter"));
    clean.name = String(clean.name || "Счётчик").trim() || "Счётчик";
    clean.initial = normalizeNumber(clean.initial, 0);
    return clean;
}

export function sanitizeFrameNextRouting(routing) {
    const source = routing !== null && routing !== void 0 ? routing : createFrameNextRouting();
    const clean = duplicateData(source);
    clean.enabled = clean.enabled === true;
    clean.counterId = String(clean.counterId || "");
    clean.operator = Object.values(COUNTER_OPERATORS).includes(clean.operator) && clean.operator !== COUNTER_OPERATORS.NONE
        ? clean.operator
        : COUNTER_OPERATORS.GTE;
    clean.value = normalizeNumber(clean.value, 0);
    clean.trueFrameId = String(clean.trueFrameId || clean.trueSceneId || "");
    clean.falseFrameId = String(clean.falseFrameId || clean.falseSceneId || "");
    delete clean.trueSceneId;
    delete clean.falseSceneId;
    return clean;
}

export function sanitizeFolderColor(color) {
    const value = String(color || "").trim();
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
    return "#b68a4a";
}

export function sanitizeGraphPositions(positions) {
    const source = positions && typeof positions === "object" ? positions : {};
    const clean = {};
    for (const key of Object.keys(source)) {
        const item = source[key];
        const x = Number(item && item.x);
        const y = Number(item && item.y);
        if (Number.isFinite(x) && Number.isFinite(y)) clean[key] = { x, y };
    }
    return clean;
}

function _breakFolderCycles(folders) {
    const map = new Map(folders.map(folder => [folder.id, folder]));
    for (const folder of folders) {
        const seen = new Set([folder.id]);
        let current = folder.parentId;
        while (current) {
            if (seen.has(current)) {
                folder.parentId = "";
                break;
            }
            seen.add(current);
            const parent = map.get(current);
            current = parent ? parent.parentId : "";
        }
    }
}

export function sanitizeFrame(frame) {
    const clean = duplicateData(frame !== null && frame !== void 0 ? frame : {});
    clean.id || (clean.id = randomId("frame"));
    clean.type = Object.values(FRAME_TYPES).includes(clean.type) ? clean.type : FRAME_TYPES.DIALOGUE;
    clean.title || (clean.title = "");
    clean.branchId || (clean.branchId = "");
    clean.folderId || (clean.folderId = "");
    clean.sort = Number(clean.sort);
    if (!Number.isFinite(clean.sort)) clean.sort = -1;
    clean.isFinal = clean.isFinal === true;
    clean.background || (clean.background = "");
    clean.clearBackground = clean.clearBackground === true;
    clean.transition || (clean.transition = "fade");
    clean.characterId || (clean.characterId = "");
    clean.portraitId || (clean.portraitId = "");
    clean.speaker || (clean.speaker = "");
    clean.portrait || (clean.portrait = "");
    clean.hidePortrait = clean.hidePortrait === true;
    clean.portraitPosition || (clean.portraitPosition = "center");
    clean.textPresentation = Object.values(TEXT_PRESENTATIONS).includes(clean.textPresentation) ? clean.textPresentation : TEXT_PRESENTATIONS.BOX;
    clean.text || (clean.text = "");
    clean.textBlocks = Array.isArray(clean.textBlocks) ? clean.textBlocks.map(sanitizeTextBlock) : [];
    if (!clean.textBlocks.length) clean.textBlocks.push(createTextBlock(clean.text || "", ""));
    clean.text = clean.textBlocks[0] ? clean.textBlocks[0].text : (clean.text || "");
    clean.musicCues = Array.isArray(clean.musicCues) ? clean.musicCues.map(cue => sanitizeAudioCue(cue, "music")) : [];
    clean.sfxCues = Array.isArray(clean.sfxCues) ? clean.sfxCues.map(cue => sanitizeAudioCue(cue, "sfx")) : [];
    delete clean.musicMode;
    delete clean.music;
    delete clean.sfx;
    clean.next || (clean.next = "");
    clean.nextRouting = sanitizeFrameNextRouting(clean.nextRouting || clean.sceneRouting);
    delete clean.sceneRouting;
    clean.choices = Array.isArray(clean.choices) ? clean.choices.map(sanitizeChoice) : [];
    if (clean.type === FRAME_TYPES.CHOICE && !clean.choices.length) clean.choices.push(createChoice());
    if (clean.type !== FRAME_TYPES.CHOICE) clean.choices = [];
    return clean;
}

export function sanitizeAudioCue(cue, kind = "music") {
    const clean = duplicateData(cue !== null && cue !== void 0 ? cue : {});
    clean.id || (clean.id = randomId("audio"));
    clean.action = Object.values(AUDIO_ACTIONS).includes(clean.action) ? clean.action : AUDIO_ACTIONS.PLAY;
    clean.channel = String(clean.channel || "").trim();
    clean.src = String(clean.src || "").trim();
    clean.loop = clean.loop === true;

    if (clean.action === AUDIO_ACTIONS.STOP) {
        clean.src = "";
        clean.loop = false;
    }
    else if (clean.action === AUDIO_ACTIONS.STOP_ALL) {
        clean.channel = "";
        clean.src = "";
        clean.loop = false;
    }
    else if (kind === "music" && cue?.loop === undefined) {
        clean.loop = true;
    }
    return clean;
}

export function sanitizeTextBlock(block) {
    const clean = duplicateData(block !== null && block !== void 0 ? block : {});
    clean.id || (clean.id = randomId("text"));
    if (clean.text === undefined || clean.text === null) clean.text = "";
    const fallbackText = String(clean.text);
    clean.richText = sanitizeRichTextHtml(
        clean.richText !== undefined && clean.richText !== null ? clean.richText : richTextFromPlainText(fallbackText),
        { fallbackText }
    );
    clean.text = richTextToPlainText(clean.richText);
    clean.voice || (clean.voice = "");
    return clean;
}

export function sanitizeChoice(choice) {
    const clean = duplicateData(choice !== null && choice !== void 0 ? choice : {});
    clean.id || (clean.id = randomId("choice"));
    if (clean.text === undefined || clean.text === null) clean.text = "Новый выбор";
    clean.next || (clean.next = "");
    clean.conditionCounterId || (clean.conditionCounterId = "");
    clean.conditionOperator = Object.values(COUNTER_OPERATORS).includes(clean.conditionOperator) ? clean.conditionOperator : COUNTER_OPERATORS.NONE;
    clean.conditionValue = normalizeNumber(clean.conditionValue, 0);
    clean.effectCounterId || (clean.effectCounterId = "");
    clean.effectOperation = Object.values(COUNTER_EFFECTS).includes(clean.effectOperation) ? clean.effectOperation : COUNTER_EFFECTS.NONE;
    clean.effectValue = Math.max(0, normalizeNumber(clean.effectValue, 0));
    if (!clean.conditionCounterId || !clean.conditionOperator) clean.conditionOperator = COUNTER_OPERATORS.NONE;
    if (!clean.effectCounterId || !clean.effectOperation || !clean.effectValue) clean.effectOperation = COUNTER_EFFECTS.NONE;
    return clean;
}

function normalizeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

export function getInitialCounterState(scene) {
    const state = {};
    const counters = scene && Array.isArray(scene.counters) ? scene.counters : [];
    for (const counter of counters) {
        if (!counter || !counter.id) continue;
        state[counter.id] = normalizeNumber(counter.initial, 0);
    }
    return state;
}

export function evaluateCounterCondition(counterId, operator, value, counterState = {}) {
    if (!counterId || !operator || operator === COUNTER_OPERATORS.NONE) return true;
    const current = normalizeNumber(counterState[counterId], 0);
    const target = normalizeNumber(value, 0);
    switch (operator) {
        case COUNTER_OPERATORS.GT: return current > target;
        case COUNTER_OPERATORS.GTE: return current >= target;
        case COUNTER_OPERATORS.EQ: return current === target;
        case COUNTER_OPERATORS.LTE: return current <= target;
        case COUNTER_OPERATORS.LT: return current < target;
        case COUNTER_OPERATORS.NE: return current !== target;
        default: return true;
    }
}

export function isChoiceAvailable(choice, counterState = {}) {
    if (!choice || !choice.conditionCounterId || !choice.conditionOperator) return true;
    return evaluateCounterCondition(choice.conditionCounterId, choice.conditionOperator, choice.conditionValue, counterState);
}

export function resolveFrameNextRouting(frame, counterState = {}) {
    const routing = sanitizeFrameNextRouting(frame?.nextRouting || frame?.sceneRouting);
    if (!routing.enabled) return { enabled: false, matched: null, frameId: "" };
    if (!routing.counterId || !routing.operator) return { enabled: true, matched: null, frameId: "" };
    const matched = evaluateCounterCondition(routing.counterId, routing.operator, routing.value, counterState);
    return {
        enabled: true,
        matched,
        frameId: matched ? routing.trueFrameId : routing.falseFrameId
    };
}

export function applyChoiceCounterEffect(choice, counterState = {}) {
    const next = Object.assign({}, counterState || {});
    if (!choice || !choice.effectCounterId || !choice.effectOperation) return next;
    const amount = Math.max(0, normalizeNumber(choice.effectValue, 0));
    if (!amount) return next;
    const current = normalizeNumber(next[choice.effectCounterId], 0);
    next[choice.effectCounterId] = choice.effectOperation === COUNTER_EFFECTS.SUBTRACT ? current - amount : current + amount;
    return next;
}

export function getFrame(scene, frameId) {
    if (!scene || !Array.isArray(scene.frames) || !scene.frames.length) return null;
    if (frameId) {
        const found = scene.frames.find(f => f.id === frameId);
        return found !== undefined ? found : null;
    }
    const start = scene.frames.find(f => f.id === scene.startFrame);
    return start !== undefined ? start : scene.frames[0];
}

export function getFrameTextBlocks(frame) {
    if (!frame) return [];
    const blocks = Array.isArray(frame.textBlocks) ? frame.textBlocks.map(sanitizeTextBlock) : [];
    if (blocks.length) return blocks;
    return [createTextBlock(frame.text || "", "")];
}

export function getTextBlock(frame, index) {
    const blocks = getFrameTextBlocks(frame);
    return blocks[index] || blocks[0] || createTextBlock("", "");
}

export function getNextFrameId(scene, frame, counterState = {}) {
    if (!scene || !frame || !Array.isArray(scene.frames)) return null;
    if (frame.isFinal === true) return null;
    const frameIds = new Set(scene.frames.map(item => item.id));
    const routing = resolveFrameNextRouting(frame, counterState);
    if (routing.enabled && routing.frameId && frameIds.has(routing.frameId)) return routing.frameId;
    if (!routing.enabled && frame.next && frameIds.has(frame.next)) return frame.next;
    const sameBranch = scene.frames.filter(f => (f.branchId || "") === (frame.branchId || ""));
    const index = sameBranch.findIndex(f => f.id === frame.id);
    if (index < 0) return null;
    return sameBranch[index + 1] ? sameBranch[index + 1].id : null;
}

export function collectAssetPaths(scene) {
    const assets = new Set();
    const frames = scene && Array.isArray(scene.frames) ? scene.frames : [];
    for (const frame of frames) {
        if (frame.background) assets.add(frame.background);
        if (frame.portrait) assets.add(frame.portrait);
        for (const cue of Array.isArray(frame.musicCues) ? frame.musicCues : []) {
            if (cue.action === AUDIO_ACTIONS.PLAY && cue.src) assets.add(cue.src);
        }
        for (const cue of Array.isArray(frame.sfxCues) ? frame.sfxCues : []) {
            if (cue.action === AUDIO_ACTIONS.PLAY && cue.src) assets.add(cue.src);
        }
        const blocks = getFrameTextBlocks(frame);
        for (const block of blocks) {
            if (block.voice) assets.add(block.voice);
        }
    }
    return [...assets];
}

export function createAssetRecord(type, path, label) {
    const cleanType = type || "image";
    const cleanPath = path || "";
    const baseLabel = label || cleanPath.split("/").pop() || "Ассет";
    return {
        id: randomId("asset"),
        type: cleanType,
        path: cleanPath,
        label: baseLabel,
        favorite: false,
        lastUsed: Date.now()
    };
}

export function sanitizeAsset(asset) {
    const clean = duplicateData(asset !== null && asset !== void 0 ? asset : {});
    clean.id || (clean.id = randomId("asset"));
    clean.type = clean.type || "image";
    clean.path = clean.path || "";
    clean.label = clean.label || clean.path.split("/").pop() || "Ассет";
    clean.favorite = clean.favorite === true;
    clean.lastUsed = Number(clean.lastUsed || 0);
    return clean;
}

export function createCharacterPortrait(label, path) {
    const cleanPath = path || "";
    return {
        id: randomId("portrait"),
        label: label || cleanPath.split("/").pop() || "Основной",
        path: cleanPath
    };
}

export function sanitizeCharacterPortrait(portrait) {
    const clean = duplicateData(portrait !== null && portrait !== void 0 ? portrait : {});
    clean.id || (clean.id = randomId("portrait"));
    clean.label = clean.label || clean.path || "Портрет";
    clean.path = clean.path || "";
    return clean;
}

export function createCharacterPreset(name, portraitLabel, portraitPath, defaultPosition) {
    const portrait = createCharacterPortrait(portraitLabel || "Основной", portraitPath || "");
    return {
        id: randomId("character"),
        name: name || "Новый персонаж",
        defaultPosition: defaultPosition || "center",
        portraits: portrait.path ? [portrait] : []
    };
}

export function sanitizeCharacter(character) {
    const clean = duplicateData(character !== null && character !== void 0 ? character : {});
    clean.id || (clean.id = randomId("character"));
    clean.name = String(clean.name || "Без имени");
    clean.defaultPosition = String(clean.defaultPosition || "center");
    clean.portraits = Array.isArray(clean.portraits) ? clean.portraits.map(sanitizeCharacterPortrait).filter(portrait => portrait.path || portrait.label) : [];
    return clean;
}

function issue(severity, code, message, data) {
    const base = {
        severity,
        code,
        message,
        frameId: "",
        choiceId: "",
        field: "",
        targetId: ""
    };
    return Object.assign(base, data || {});
}

function frameIndexMap(scene) {
    const map = new Map();
    const frames = scene && Array.isArray(scene.frames) ? scene.frames : [];
    frames.forEach((frame, index) => map.set(frame.id, index));
    return map;
}

export function frameDisplayName(frame, { maxLength = 42 } = {}) {
    if (!frame) return "Кадр";
    const blocks = getFrameTextBlocks(frame);
    const firstText = blocks[0] ? blocks[0].text : frame.text;
    const textName = firstText ? String(firstText).replace(/\s+/g, " ").trim().slice(0, maxLength) : "";
    return frame.title || textName || frame.speaker || frame.id || "Кадр";
}

export function getFrameLabel(frame, index) {
    return `${index + 1}) ${frameDisplayName(frame)}`;
}

export function getFrameReferences(scene, frameId) {
    const refs = [];
    if (!scene || !frameId || !Array.isArray(scene.frames)) return refs;
    const indexById = frameIndexMap(scene);
    if (scene.startFrame === frameId) {
        refs.push({ type: "start", label: "стартовый кадр", frameId: "", choiceId: "" });
    }
    for (const frame of scene.frames) {
        const frameIndex = indexById.has(frame.id) ? indexById.get(frame.id) : -1;
        const frameLabel = getFrameLabel(frame, frameIndex >= 0 ? frameIndex : 0);
        if (frame.next === frameId) {
            refs.push({ type: "next", label: `переход из «${frameLabel}»`, frameId: frame.id, choiceId: "" });
        }
        const nextRouting = sanitizeFrameNextRouting(frame.nextRouting);
        if (nextRouting.trueFrameId === frameId) {
            refs.push({ type: "counter-true", label: `условие «если да» в «${frameLabel}»`, frameId: frame.id, choiceId: "" });
        }
        if (nextRouting.falseFrameId === frameId) {
            refs.push({ type: "counter-false", label: `условие «если нет» в «${frameLabel}»`, frameId: frame.id, choiceId: "" });
        }
        const choices = Array.isArray(frame.choices) ? frame.choices : [];
        for (let i = 0; i < choices.length; i += 1) {
            const choice = choices[i];
            if (choice.next === frameId) {
                const text = choice.text || `вариант ${i + 1}`;
                refs.push({ type: "choice", label: `выбор «${text}» в «${frameLabel}»`, frameId: frame.id, choiceId: choice.id });
            }
        }
    }
    return refs;
}

export function clearFrameReferences(scene, frameId) {
    if (!scene || !frameId || !Array.isArray(scene.frames)) return scene;
    if (scene.startFrame === frameId) scene.startFrame = "";
    for (const frame of scene.frames) {
        if (frame.next === frameId) frame.next = "";
        if (frame.nextRouting?.trueFrameId === frameId) frame.nextRouting.trueFrameId = "";
        if (frame.nextRouting?.falseFrameId === frameId) frame.nextRouting.falseFrameId = "";
        const choices = Array.isArray(frame.choices) ? frame.choices : [];
        for (const choice of choices) {
            if (choice.next === frameId) choice.next = "";
        }
    }
    return scene;
}

export function validateScene(scene) {
    const issues = [];
    if (!scene) {
        issues.push(issue(ISSUE_SEVERITY.ERROR, "no-scene", "Катсцена не выбрана."));
        return issues;
    }
    const frames = Array.isArray(scene.frames) ? scene.frames : [];
    if (!frames.length) {
        issues.push(issue(ISSUE_SEVERITY.ERROR, "no-frames", "В катсцене нет кадров."));
        return issues;
    }

    const ids = new Set();
    const duplicates = new Set();
    for (const frame of frames) {
        if (!frame.id) continue;
        if (ids.has(frame.id)) duplicates.add(frame.id);
        ids.add(frame.id);
    }
    duplicates.forEach(id => {
        issues.push(issue(ISSUE_SEVERITY.ERROR, "duplicate-frame-id", `Повторяется ID кадра: ${id}.`, { targetId: id }));
    });

    if (!scene.startFrame) {
        issues.push(issue(ISSUE_SEVERITY.ERROR, "no-start-frame", "Не задан стартовый кадр."));
    }
    else if (!ids.has(scene.startFrame)) {
        issues.push(issue(ISSUE_SEVERITY.ERROR, "broken-start-frame", `Стартовый кадр не найден: ${scene.startFrame}.`, { targetId: scene.startFrame, field: "scene.startFrame" }));
    }

    const branches = Array.isArray(scene.branches) ? scene.branches : [];
    const branchIds = new Set(branches.map(branch => branch.id));
    const folderMap = new Map(Array.isArray(scene.frameFolders) ? scene.frameFolders.map(folder => [folder.id, folder]) : []);
    const folderIds = new Set(folderMap.keys());
    const counterIds = new Set(Array.isArray(scene.counters) ? scene.counters.map(counter => counter.id) : []);
    const nextSequentialById = new Map();
    const previousByBranch = new Map();
    for (const frame of frames) {
        const branchId = frame.branchId || "";
        const previous = previousByBranch.get(branchId);
        if (previous?.id && frame.id) nextSequentialById.set(previous.id, frame.id);
        previousByBranch.set(branchId, frame);
    }

    for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index];
        const label = getFrameLabel(frame, index);
        const nextRouting = sanitizeFrameNextRouting(frame.nextRouting);
        if (nextRouting.enabled) {
            if (frame.isFinal) {
                issues.push(issue(ISSUE_SEVERITY.WARNING, "frame-routing-final", `Кадр «${label}» отмечен финальным, поэтому проверка счётчика для следующего кадра не выполнится.`, { frameId: frame.id, field: "frame.isFinal" }));
            }
            if (!nextRouting.counterId) {
                issues.push(issue(ISSUE_SEVERITY.ERROR, "frame-routing-no-counter", "Для условного следующего кадра не выбран счётчик.", { frameId: frame.id, field: "frame.nextRouting.counterId" }));
            }
            else if (!counterIds.has(nextRouting.counterId)) {
                issues.push(issue(ISSUE_SEVERITY.ERROR, "frame-routing-missing-counter", "Условный следующий кадр ссылается на несуществующий счётчик.", { frameId: frame.id, field: "frame.nextRouting.counterId" }));
            }
            if (!Object.values(COUNTER_OPERATORS).includes(nextRouting.operator) || nextRouting.operator === COUNTER_OPERATORS.NONE) {
                issues.push(issue(ISSUE_SEVERITY.ERROR, "frame-routing-bad-operator", "Для условного следующего кадра не выбрано корректное сравнение.", { frameId: frame.id, field: "frame.nextRouting.operator" }));
            }
            for (const [field, targetId, branchLabel] of [
                ["frame.nextRouting.trueFrameId", nextRouting.trueFrameId, "ветки «если да»"],
                ["frame.nextRouting.falseFrameId", nextRouting.falseFrameId, "ветки «если нет»"]
            ]) {
                if (targetId && !ids.has(targetId)) {
                    issues.push(issue(ISSUE_SEVERITY.ERROR, "frame-routing-missing-frame", `Не найден целевой кадр для ${branchLabel}: ${targetId}.`, { frameId: frame.id, field, targetId }));
                }
                if (targetId && targetId === frame.id) {
                    issues.push(issue(ISSUE_SEVERITY.WARNING, "frame-routing-self-loop", `Переход для ${branchLabel} возвращает в этот же кадр.`, { frameId: frame.id, field, targetId }));
                }
            }
            if (nextRouting.trueFrameId && nextRouting.trueFrameId === nextRouting.falseFrameId) {
                issues.push(issue(ISSUE_SEVERITY.WARNING, "frame-routing-same-target", "Обе ветки проверки ведут в один и тот же кадр.", { frameId: frame.id, field: "frame.nextRouting" }));
            }
        }
        if (frame.branchId && branchIds.size && !branchIds.has(frame.branchId)) {
            issues.push(issue(ISSUE_SEVERITY.WARNING, "missing-branch", `У кадра «${label}» указана несуществующая ветка.`, { frameId: frame.id, field: "frame.branchId" }));
        }
        if (frame.folderId && (!folderIds.has(frame.folderId) || (folderMap.get(frame.folderId) && folderMap.get(frame.folderId).branchId !== frame.branchId))) {
            issues.push(issue(ISSUE_SEVERITY.WARNING, "missing-folder", `У кадра «${label}» указана несуществующая папка или папка из другой ветки.`, { frameId: frame.id, field: "frame.folderId" }));
        }
        if (!Object.values(FRAME_TYPES).includes(frame.type)) {
            issues.push(issue(ISSUE_SEVERITY.ERROR, "bad-frame-type", `У кадра «${label}» неизвестный тип.`, { frameId: frame.id, field: "frame.type" }));
        }

        for (const [kind, cues] of [["music", frame.musicCues], ["sfx", frame.sfxCues]]) {
            const seenChannels = new Set();
            for (let cueIndex = 0; cueIndex < (Array.isArray(cues) ? cues.length : 0); cueIndex += 1) {
                const cue = cues[cueIndex];
                const fieldBase = `frame.${kind}Cues.${cueIndex}`;
                if (!Object.values(AUDIO_ACTIONS).includes(cue.action)) {
                    issues.push(issue(ISSUE_SEVERITY.ERROR, "bad-audio-action", `У кадра «${label}» неизвестное действие ${kind === "music" ? "музыки" : "SFX"}.`, { frameId: frame.id, field: `${fieldBase}.action` }));
                    continue;
                }
                if (cue.action === AUDIO_ACTIONS.STOP_ALL) continue;
                if (!String(cue.channel || "").trim()) {
                    issues.push(issue(ISSUE_SEVERITY.ERROR, "audio-no-channel", `У кадра «${label}» для аудио-действия не указан канал.`, { frameId: frame.id, field: `${fieldBase}.channel` }));
                }
                else if (seenChannels.has(cue.channel)) {
                    issues.push(issue(ISSUE_SEVERITY.WARNING, "duplicate-audio-channel", `В кадре «${label}» канал «${cue.channel}» изменяется несколько раз; действия выполнятся сверху вниз.`, { frameId: frame.id, field: `${fieldBase}.channel` }));
                }
                if (cue.channel) seenChannels.add(cue.channel);
                if (cue.action === AUDIO_ACTIONS.PLAY && !String(cue.src || "").trim()) {
                    issues.push(issue(ISSUE_SEVERITY.ERROR, "audio-no-source", `У кадра «${label}» для запуска звука не выбран файл.`, { frameId: frame.id, field: `${fieldBase}.src` }));
                }
            }
        }

        const blocks = getFrameTextBlocks(frame);
        if (!blocks.length) {
            issues.push(issue(ISSUE_SEVERITY.WARNING, "no-text-blocks", `У кадра «${label}» нет текстовых блоков.`, { frameId: frame.id, field: "frame.textBlocks" }));
        }
        if (!nextRouting.enabled && frame.next && !ids.has(frame.next)) {
            issues.push(issue(ISSUE_SEVERITY.ERROR, "broken-frame-next", `У кадра «${label}» битый переход: ${frame.next}.`, { frameId: frame.id, field: "frame.next", targetId: frame.next }));
        }
        if (frame.isFinal === true) {
            continue;
        }
        if (frame.type !== FRAME_TYPES.CHOICE) {
            const hasSequentialNext = nextSequentialById.has(frame.id);
            if (!nextRouting.enabled && !frame.next && !hasSequentialNext) {
                issues.push(issue(ISSUE_SEVERITY.WARNING, "terminal-frame", `Кадр «${label}» не имеет следующего кадра и завершит катсцену.`, { frameId: frame.id, field: "frame.next" }));
            }
            continue;
        }

        const choices = Array.isArray(frame.choices) ? frame.choices : [];
        if (!choices.length) {
            issues.push(issue(ISSUE_SEVERITY.ERROR, "empty-choice-list", `У кадра выбора «${label}» нет вариантов.`, { frameId: frame.id, field: "choices" }));
            continue;
        }
        const choiceIds = new Set();
        for (let choiceIndex = 0; choiceIndex < choices.length; choiceIndex += 1) {
            const choice = choices[choiceIndex];
            const choiceLabel = `вариант ${choiceIndex + 1}`;
            if (!choice.id) {
                issues.push(issue(ISSUE_SEVERITY.ERROR, "choice-no-id", `У кадра «${label}» есть вариант без ID.`, { frameId: frame.id, field: "choice.id" }));
            }
            else if (choiceIds.has(choice.id)) {
                issues.push(issue(ISSUE_SEVERITY.ERROR, "duplicate-choice-id", `У кадра «${label}» повторяется ID варианта.`, { frameId: frame.id, choiceId: choice.id, field: "choice.id" }));
            }
            choiceIds.add(choice.id);
            if (!String(choice.text || "").trim()) {
                issues.push(issue(ISSUE_SEVERITY.ERROR, "empty-choice-text", `В кадре «${label}» пустой ${choiceLabel}.`, { frameId: frame.id, choiceId: choice.id, field: "choice.text" }));
            }
            if (choice.conditionCounterId && !counterIds.has(choice.conditionCounterId)) {
                issues.push(issue(ISSUE_SEVERITY.WARNING, "missing-choice-condition-counter", `В кадре «${label}» у варианта «${choice.text || choiceLabel}» указан несуществующий счётчик условия.`, { frameId: frame.id, choiceId: choice.id, field: "choice.conditionCounterId" }));
            }
            if (choice.effectCounterId && !counterIds.has(choice.effectCounterId)) {
                issues.push(issue(ISSUE_SEVERITY.WARNING, "missing-choice-effect-counter", `В кадре «${label}» у варианта «${choice.text || choiceLabel}» указан несуществующий счётчик эффекта.`, { frameId: frame.id, choiceId: choice.id, field: "choice.effectCounterId" }));
            }
            if (choice.next && !ids.has(choice.next)) {
                issues.push(issue(ISSUE_SEVERITY.ERROR, "broken-choice-next", `В кадре «${label}» битый переход у варианта «${choice.text || choiceLabel}»: ${choice.next}.`, { frameId: frame.id, choiceId: choice.id, field: "choice.next", targetId: choice.next }));
            }
            if (!choice.next && !nextRouting.enabled && !nextSequentialById.has(frame.id)) {
                issues.push(issue(ISSUE_SEVERITY.WARNING, "choice-terminal", `В кадре «${label}» вариант «${choice.text || choiceLabel}» не имеет целевого кадра и завершит катсцену.`, { frameId: frame.id, choiceId: choice.id, field: "choice.next" }));
            }
        }
    }
    return issues;
}
