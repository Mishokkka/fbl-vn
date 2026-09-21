import { DATA_SCHEMA_VERSION, DEFAULT_DATA } from "../utils/constants.js";
import { duplicateData, randomId } from "../utils/foundry-helpers.js";
import { richTextFromPlainText } from "../utils/rich-text.js";

export function migrateData(source) {
    const data = duplicateData(source && typeof source === "object" ? source : DEFAULT_DATA);
    const parsedVersion = Number(data.schemaVersion);
    if (Number.isFinite(parsedVersion) && (!Number.isInteger(parsedVersion) || parsedVersion < 0 || parsedVersion > DATA_SCHEMA_VERSION)) {
        const error = new RangeError(`VN: unsupported schemaVersion "${data.schemaVersion}". Expected an integer from 0 to ${DATA_SCHEMA_VERSION}.`);
        error.code = "FBL_VN_UNSUPPORTED_SCHEMA_VERSION";
        throw error;
    }
    let schemaVersion = Number.isFinite(parsedVersion) ? parsedVersion : 0;
    if (schemaVersion < 1) {
        migrateToV1(data);
        schemaVersion = 1;
    }
    if (schemaVersion < 2) {
        migrateToV2(data);
        schemaVersion = 2;
    }
    if (schemaVersion < 3) {
        migrateToV3(data);
        schemaVersion = 3;
    }
    if (schemaVersion < 4) {
        migrateToV4(data);
        schemaVersion = 4;
    }
    if (schemaVersion < 5) {
        migrateToV5(data);
        schemaVersion = 5;
    }
    if (schemaVersion < 6) {
        migrateToV6(data);
        schemaVersion = 6;
    }
    if (schemaVersion < 7) {
        migrateToV7(data);
        schemaVersion = 7;
    }
    if (schemaVersion < 8) {
        migrateToV8(data);
        schemaVersion = 8;
    }
    if (schemaVersion < 9) {
        migrateToV9(data);
        schemaVersion = 9;
    }
    if (schemaVersion < 10) {
        migrateToV10(data);
        schemaVersion = 10;
    }
    data.schemaVersion = DATA_SCHEMA_VERSION;
    return data;
}

function migrateToV1(data) {
    data.version = Number(data.version || 3);
    data.scenes = Array.isArray(data.scenes) ? data.scenes : [];
    data.assets = Array.isArray(data.assets) ? data.assets : [];
    data.characters = Array.isArray(data.characters) ? data.characters : [];
    for (const scene of data.scenes) {
        if (!scene || typeof scene !== "object") continue;
        if (!Array.isArray(scene.frameFolders)) scene.frameFolders = [];
        if (!scene.graphPositions || typeof scene.graphPositions !== "object") scene.graphPositions = {};
        if (!Array.isArray(scene.frames)) scene.frames = [];
        for (const frame of scene.frames) {
            if (!frame || typeof frame !== "object") continue;
            if (!Array.isArray(frame.textBlocks)) {
                frame.textBlocks = [{ id: "", text: frame.text || "", voice: "" }];
            }
            if (!Array.isArray(frame.choices)) frame.choices = [];
            frame.folderId ||= "";
            frame.characterId ||= "";
            frame.portraitId ||= "";
        }
    }
}

function migrateToV2(data) {
    data.scenes = Array.isArray(data.scenes) ? data.scenes : [];
    for (const scene of data.scenes) {
        if (!scene || typeof scene !== "object") continue;
        if (!Array.isArray(scene.counters)) scene.counters = [];
        if (!Array.isArray(scene.frameFolders)) scene.frameFolders = [];
        for (const folder of scene.frameFolders) {
            if (!folder || typeof folder !== "object") continue;
            folder.isBranch = folder.isBranch === true;
        }
        if (!Array.isArray(scene.frames)) scene.frames = [];
        for (const frame of scene.frames) {
            if (!frame || typeof frame !== "object") continue;
            if (!Array.isArray(frame.choices)) frame.choices = [];
            for (const choice of frame.choices) {
                if (!choice || typeof choice !== "object") continue;
                choice.conditionCounterId ||= "";
                choice.conditionOperator ||= "";
                choice.conditionValue = Number.isFinite(Number(choice.conditionValue)) ? Number(choice.conditionValue) : 0;
                choice.effectCounterId ||= "";
                choice.effectOperation ||= "";
                choice.effectValue = Number.isFinite(Number(choice.effectValue)) ? Math.max(0, Number(choice.effectValue)) : 0;
            }
        }
    }
}


function migrateToV3(data) {
    data.scenes = Array.isArray(data.scenes) ? data.scenes : [];
    for (const scene of data.scenes) {
        if (!scene || typeof scene !== "object") continue;
        scene.frames = Array.isArray(scene.frames) ? scene.frames : [];
        scene.frameFolders = Array.isArray(scene.frameFolders) ? scene.frameFolders : [];
        const branches = [];
        const branchRoots = scene.frameFolders.filter(folder => folder && folder.isBranch === true);
        const mainBranch = { id: randomId("branch"), name: "Основная ветка", sort: 0 };
        branches.push(mainBranch);
        const rootToBranch = new Map();
        for (let i = 0; i < branchRoots.length; i += 1) {
            const root = branchRoots[i];
            const branch = { id: randomId("branch"), name: root.name || `Ветка ${i + 1}`, sort: (i + 1) * 1000 };
            branches.push(branch);
            rootToBranch.set(root.id, branch);
        }
        const folderById = new Map(scene.frameFolders.map(folder => [folder.id, folder]));
        const nearestBranchRoot = (folderId) => {
            let current = folderId || "";
            const seen = new Set();
            let found = "";
            while (current && !seen.has(current)) {
                seen.add(current);
                const folder = folderById.get(current);
                if (!folder) break;
                if (folder.isBranch === true) found = folder.id;
                current = folder.parentId || "";
            }
            return found;
        };
        for (const folder of scene.frameFolders) {
            if (!folder || typeof folder !== "object") continue;
            const rootId = nearestBranchRoot(folder.id);
            const branch = rootId ? rootToBranch.get(rootId) : mainBranch;
            folder.branchId = branch ? branch.id : mainBranch.id;
            if (folder.isBranch === true) folder._removeAsBranchRoot = true;
            else if (folder.parentId && rootToBranch.has(folder.parentId)) folder.parentId = "";
            folder.isBranch = false;
        }
        for (const frame of scene.frames) {
            if (!frame || typeof frame !== "object") continue;
            const rootId = nearestBranchRoot(frame.folderId || "");
            const branch = rootId ? rootToBranch.get(rootId) : mainBranch;
            frame.branchId = branch ? branch.id : mainBranch.id;
            if (frame.folderId && rootToBranch.has(frame.folderId)) frame.folderId = "";
        }
        scene.frameFolders = scene.frameFolders.filter(folder => folder && folder._removeAsBranchRoot !== true).map(folder => {
            if (folder && typeof folder === "object") delete folder._removeAsBranchRoot;
            return folder;
        });
        scene.branches = branches;
    }
}


function migrateToV4(data) {
    data.scenes = Array.isArray(data.scenes) ? data.scenes : [];
    for (const scene of data.scenes) {
        if (!scene || typeof scene !== "object") continue;
        if (!scene.exitRouting || typeof scene.exitRouting !== "object") {
            scene.exitRouting = {
                enabled: false,
                counterId: "",
                operator: "gte",
                value: 0,
                trueSceneId: "",
                falseSceneId: ""
            };
        }
    }
}

function migrateToV5(data) {
    data.scenes = Array.isArray(data.scenes) ? data.scenes : [];
    for (const scene of data.scenes) {
        if (!scene || typeof scene !== "object") continue;
        scene.frames = Array.isArray(scene.frames) ? scene.frames : [];
        for (const frame of scene.frames) {
            if (!frame || typeof frame !== "object") continue;
            if (!frame.sceneRouting || typeof frame.sceneRouting !== "object") {
                frame.sceneRouting = {
                    enabled: false,
                    counterId: "",
                    operator: "gte",
                    value: 0,
                    trueSceneId: "",
                    falseSceneId: ""
                };
            }
        }
        const legacy = scene.exitRouting && typeof scene.exitRouting === "object" ? scene.exitRouting : null;
        if (legacy?.enabled === true && !scene.frames.some(frame => frame?.sceneRouting?.enabled === true)) {
            const target = scene.frames.find(frame => frame?.isFinal === true) || scene.frames[scene.frames.length - 1] || null;
            if (target) {
                target.sceneRouting = { ...legacy };
                target.isFinal = true;
            }
        }
        delete scene.exitRouting;
    }
}


function migrateToV6(data) {
    data.scenes = Array.isArray(data.scenes) ? data.scenes : [];
    for (const scene of data.scenes) {
        if (!scene || typeof scene !== "object") continue;
        scene.frames = Array.isArray(scene.frames) ? scene.frames : [];
        const frameIds = new Set(scene.frames.map(frame => frame?.id).filter(Boolean));
        for (const frame of scene.frames) {
            if (!frame || typeof frame !== "object") continue;
            const legacy = frame.sceneRouting && typeof frame.sceneRouting === "object"
                ? frame.sceneRouting
                : (frame.nextRouting && typeof frame.nextRouting === "object" ? frame.nextRouting : {});
            const legacyTrueFrame = String(legacy.trueFrameId || "");
            const legacyFalseFrame = String(legacy.falseFrameId || "");
            const resolvedTrue = frameIds.has(legacyTrueFrame) ? legacyTrueFrame : "";
            const resolvedFalse = frameIds.has(legacyFalseFrame) ? legacyFalseFrame : "";
            const routable = Boolean(resolvedTrue || resolvedFalse);
            frame.nextRouting = {
                enabled: legacy.enabled === true && routable,
                counterId: String(legacy.counterId || ""),
                operator: String(legacy.operator || "gte"),
                value: Number.isFinite(Number(legacy.value)) ? Number(legacy.value) : 0,
                trueFrameId: resolvedTrue,
                falseFrameId: resolvedFalse
            };
            if (frame.nextRouting.enabled && frame.sceneRouting?.enabled === true) frame.isFinal = false;
            delete frame.sceneRouting;
        }
        delete scene.exitRouting;
    }
}


function migrateToV7(data) {
    data.scenes = Array.isArray(data.scenes) ? data.scenes : [];
    for (const scene of data.scenes) {
        if (!scene || typeof scene !== "object") continue;
        scene.frames = Array.isArray(scene.frames) ? scene.frames : [];
        for (const frame of scene.frames) {
            if (!frame || typeof frame !== "object") continue;
            frame.textPresentation = frame.textPresentation === "center" ? "center" : "box";
            frame.textBlocks = Array.isArray(frame.textBlocks) ? frame.textBlocks : [];
            for (const block of frame.textBlocks) {
                if (!block || typeof block !== "object") continue;
                const text = block.text === undefined || block.text === null ? "" : String(block.text);
                if (block.richText === undefined || block.richText === null || block.richText === "") {
                    block.richText = richTextFromPlainText(text);
                }
            }
        }
    }
}


function migrateToV8(data) {
    data.scenes = Array.isArray(data.scenes) ? data.scenes : [];
    for (const scene of data.scenes) {
        if (!scene || typeof scene !== "object") continue;
        scene.frames = Array.isArray(scene.frames) ? scene.frames : [];
        for (const frame of scene.frames) {
            if (!frame || typeof frame !== "object") continue;

            if (!Array.isArray(frame.musicCues)) {
                frame.musicCues = [];
                const mode = String(frame.musicMode || "keep");
                const path = String(frame.music || "");
                if (mode === "play" && path) {
                    frame.musicCues.push({
                        id: randomId("audio"),
                        action: "play",
                        channel: "music-1",
                        src: path,
                        loop: true
                    });
                }
                else if (mode === "stop") {
                    frame.musicCues.push({
                        id: randomId("audio"),
                        action: "stop-all",
                        channel: "",
                        src: "",
                        loop: false
                    });
                }
            }

            if (!Array.isArray(frame.sfxCues)) {
                frame.sfxCues = [];
                const path = String(frame.sfx || "");
                if (path) {
                    frame.sfxCues.push({
                        id: randomId("audio"),
                        action: "play",
                        channel: `legacy-sfx-${frame.id || randomId("frame")}`,
                        src: path,
                        loop: false
                    });
                }
            }

            delete frame.musicMode;
            delete frame.music;
            delete frame.sfx;
        }
    }
}


function migrateToV9(data) {
    data.scenes = Array.isArray(data.scenes) ? data.scenes : [];
    for (const scene of data.scenes) {
        if (!scene || typeof scene !== "object") continue;
        scene.frames = Array.isArray(scene.frames) ? scene.frames : [];
        for (const frame of scene.frames) {
            if (!frame || typeof frame !== "object") continue;
            if (!["auto", "screen", "text", "none"].includes(frame.vignetteMode)) frame.vignetteMode = "auto";
        }
    }
}


function migrateToV10(data) {
    data.scenes = Array.isArray(data.scenes) ? data.scenes : [];
    for (const scene of data.scenes) {
        if (!scene || typeof scene !== "object") continue;
        scene.frames = Array.isArray(scene.frames) ? scene.frames : [];
        for (const frame of scene.frames) {
            if (!frame || typeof frame !== "object") continue;
            if (frame.showSpeakerName === undefined) frame.showSpeakerName = true;
            if (!Array.isArray(frame.additionalCharacters)) frame.additionalCharacters = [];
        }
    }
}
