import { VNSceneStore } from "../data/scene-store.js";
import { createSceneCounter, sanitizeSceneCounter } from "../data/schema.js";
import { COUNTER_EFFECTS, COUNTER_OPERATORS, MODULE_ID } from "../utils/constants.js";
import { confirmDialog, notify, randomId } from "../utils/foundry-helpers.js";

const ApplicationV2 = foundry.applications.api.ApplicationV2;
const HandlebarsApplicationMixin = foundry.applications.api.HandlebarsApplicationMixin;

export class VNCounterManagerApp extends HandlebarsApplicationMixin(ApplicationV2) {
    constructor(options = {}) {
        super(options);
        this.sceneId = options.sceneId || "";
        this.editor = options.editor || null;
    }

    _getScene() {
        return VNSceneStore.getScene(this.sceneId);
    }

    _usageForCounter(scene, counterId) {
        let choiceConditions = 0;
        let choiceEffects = 0;
        for (const frame of scene && Array.isArray(scene.frames) ? scene.frames : []) {
            for (const choice of Array.isArray(frame.choices) ? frame.choices : []) {
                if (choice.conditionCounterId === counterId) choiceConditions += 1;
                if (choice.effectCounterId === counterId) choiceEffects += 1;
            }
        }
        let nextRoutings = 0;
        for (const frame of scene && Array.isArray(scene.frames) ? scene.frames : []) {
            if (frame?.nextRouting?.enabled && frame.nextRouting.counterId === counterId) nextRoutings += 1;
        }
        return {
            choiceConditions,
            choiceEffects,
            nextRoutings,
            total: choiceConditions + choiceEffects + nextRoutings
        };
    }

    async _prepareContext(options) {
        const context = await super._prepareContext(options);
        const scene = this._getScene();
        const counters = (scene && Array.isArray(scene.counters) ? scene.counters : []).map((counter, index) => {
            const usage = this._usageForCounter(scene, counter.id);
            const usageParts = [];
            if (usage.choiceConditions) usageParts.push(`условия: ${usage.choiceConditions}`);
            if (usage.choiceEffects) usageParts.push(`эффекты: ${usage.choiceEffects}`);
            if (usage.nextRoutings) usageParts.push(`условные переходы: ${usage.nextRoutings}`);
            return {
                ...counter,
                index: index + 1,
                usageCount: usage.total,
                usageLabel: usageParts.length ? usageParts.join(", ") : "не используется"
            };
        });
        return Object.assign(context, {
            scene,
            sceneTitle: scene?.title || "Катсцена",
            counters,
            hasCounters: counters.length > 0
        });
    }

    async _commitCounters() {
        const scene = this._getScene();
        if (!scene || !this.element) return scene;
        const rows = [...this.element.querySelectorAll("[data-counter-row]")];
        scene.counters = rows.map((row, index) => sanitizeSceneCounter({
            id: row.dataset.counterId || randomId("counter"),
            name: row.querySelector("[data-counter-name]")?.value || `Счётчик ${index + 1}`,
            initial: Number(row.querySelector("[data-counter-initial]")?.value || 0)
        }));
        await VNSceneStore.upsertScene(scene);
        return scene;
    }

    _refreshEditor(parts = ["framePanel", "frames"]) {
        if (!this.editor) return;
        if (typeof this.editor._renderEditorParts === "function") this.editor._renderEditorParts(parts);
        else if (typeof this.editor.render === "function") this.editor.render();
    }

    static async _onSave(event) {
        event.preventDefault();
        await this._commitCounters();
        this._refreshEditor();
        notify("VN: счётчики сохранены.");
        this.render();
    }

    static async _onAddCounter(event) {
        event.preventDefault();
        const scene = await this._commitCounters();
        if (!scene) return;
        let number = scene.counters.length + 1;
        let name = `Счётчик ${number}`;
        while (scene.counters.some(counter => counter.name === name)) {
            number += 1;
            name = `Счётчик ${number}`;
        }
        scene.counters.push(createSceneCounter(name, 0));
        await VNSceneStore.upsertScene(scene);
        this._refreshEditor();
        this.render();
    }

    static async _onDeleteCounter(event, target) {
        event.preventDefault();
        const scene = await this._commitCounters();
        if (!scene) return;
        const counterId = target.dataset.counterId || "";
        const counter = scene.counters.find(item => item.id === counterId);
        if (!counter) return;
        const usage = this._usageForCounter(scene, counterId);
        const detail = usage.total
            ? ` Он используется в ${usage.total} местах. Связанные условия, эффекты и условные переходы между кадрами будут очищены.`
            : "";
        const confirmed = await confirmDialog(`Удалить счётчик «${counter.name}»?${detail}`, {
            title: "Удаление счётчика",
            yes: "Удалить",
            no: "Отмена"
        });
        if (!confirmed) return;
        scene.counters = scene.counters.filter(item => item.id !== counterId);
        for (const frame of scene.frames || []) {
            for (const choice of frame.choices || []) {
                if (choice.conditionCounterId === counterId) {
                    choice.conditionCounterId = "";
                    choice.conditionOperator = COUNTER_OPERATORS.NONE;
                    choice.conditionValue = 0;
                }
                if (choice.effectCounterId === counterId) {
                    choice.effectCounterId = "";
                    choice.effectOperation = COUNTER_EFFECTS.NONE;
                    choice.effectValue = 0;
                }
            }
        }
        for (const frame of scene.frames || []) {
            if (frame.nextRouting?.counterId !== counterId) continue;
            frame.nextRouting.enabled = false;
            frame.nextRouting.counterId = "";
        }
        await VNSceneStore.upsertScene(scene);
        this._refreshEditor();
        this.render();
    }
}

VNCounterManagerApp.DEFAULT_OPTIONS = {
    id: "fbl-vn-counter-manager",
    classes: ["fbl-vn-counter-manager-app"],
    tag: "section",
    window: {
        title: "Счётчики катсцены",
        icon: "fa-solid fa-gauge-high",
        resizable: true,
        contentClasses: ["fbl-vn-ui"]
    },
    position: {
        width: 720,
        height: 520
    },
    actions: {
        save: VNCounterManagerApp._onSave,
        addCounter: VNCounterManagerApp._onAddCounter,
        deleteCounter: VNCounterManagerApp._onDeleteCounter
    }
};

VNCounterManagerApp.PARTS = {
    main: {
        template: `modules/${MODULE_ID}/templates/counter-manager.hbs`,
        scrollable: [".fbl-vn-counter-manager-list"]
    }
};
