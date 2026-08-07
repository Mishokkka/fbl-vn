import { DATA_SCHEMA_VERSION, DEFAULT_DATA } from "../utils/constants.js";
import { duplicateData, randomId } from "../utils/foundry-helpers.js";

export function migrateData(source) {
    const data = duplicateData(source && typeof source === "object" ? source : DEFAULT_DATA);
    let schemaVersion = Number(data.schemaVersion || 0);
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
            const legacyTrue = String(legacy.trueFrameId || legacy.trueSceneId || "");
            const legacyFalse = String(legacy.falseFrameId || legacy.falseSceneId || "");
            frame.nextRouting = {
                enabled: legacy.enabled === true,
                counterId: String(legacy.counterId || ""),
                operator: String(legacy.operator || "gte"),
                value: Number.isFinite(Number(legacy.value)) ? Number(legacy.value) : 0,
                trueFrameId: frameIds.has(legacyTrue) ? legacyTrue : "",
                falseFrameId: frameIds.has(legacyFalse) ? legacyFalse : ""
            };
            if (frame.nextRouting.enabled && frame.sceneRouting?.enabled === true) frame.isFinal = false;
            delete frame.sceneRouting;
        }
        delete scene.exitRouting;
    }
}
