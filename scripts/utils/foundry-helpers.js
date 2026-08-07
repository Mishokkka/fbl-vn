import { MODULE_ID } from "./constants.js";
export function randomId(prefix = "id") {
    var _a, _b, _c;
    const random = (_c = (_b = (_a = foundry.utils) === null || _a === void 0 ? void 0 : _a.randomID) === null || _b === void 0 ? void 0 : _b.call(_a, 10)) !== null && _c !== void 0 ? _c : Math.random().toString(36).slice(2, 12);
    return `${prefix}-${random}`;
}
export function duplicateData(data) {
    var _a;
    if ((_a = foundry.utils) === null || _a === void 0 ? void 0 : _a.deepClone)
        return foundry.utils.deepClone(data);
    return JSON.parse(JSON.stringify(data));
}
export function mergeData(target, source) {
    var _a;
    if ((_a = foundry.utils) === null || _a === void 0 ? void 0 : _a.mergeObject)
        return foundry.utils.mergeObject(target, source, { inplace: false });
    return Object.assign({}, target, source);
}
export function localize(key) {
    var _a, _b, _c;
    return (_c = (_b = (_a = game.i18n) === null || _a === void 0 ? void 0 : _a.localize) === null || _b === void 0 ? void 0 : _b.call(_a, key)) !== null && _c !== void 0 ? _c : key;
}
export function warn(message) {
    console.warn(`${MODULE_ID} | ${message}`);
}
export function notify(message) {
    var _a;
    (_a = ui.notifications) === null || _a === void 0 ? void 0 : _a.info(message);
}
export function notifyWarn(message) {
    var _a;
    (_a = ui.notifications) === null || _a === void 0 ? void 0 : _a.warn(message);
}
export function notifyError(message) {
    var _a;
    (_a = ui.notifications) === null || _a === void 0 ? void 0 : _a.error(message);
}

export async function confirmDialog(message, { title = "Подтверждение", yes = "Да", no = "Нет" } = {}) {
    const text = String(message ?? "");
    const DialogV2 = foundry.applications?.api?.DialogV2;
    if (DialogV2?.confirm) {
        try {
            const content = `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
            const result = await DialogV2.confirm({
                window: { title },
                content,
                modal: true,
                rejectClose: false,
                yes: { label: yes },
                no: { label: no }
            });
            return result === true;
        }
        catch (error) {
            console.warn(`${MODULE_ID} | DialogV2.confirm failed, falling back to native confirm().`, error);
        }
    }
    return globalThis.confirm(text);
}
export function getFilePickerClass() {
    var _a, _b, _c;
    return (_c = (_b = (_a = foundry.applications) === null || _a === void 0 ? void 0 : _a.apps) === null || _b === void 0 ? void 0 : _b.FilePicker) !== null && _c !== void 0 ? _c : globalThis.FilePicker;
}
export function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
export function safeFilename(value, fallback = "download.json") {
    const raw = String(value || fallback || "download.json").trim() || fallback;
    return raw.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").slice(0, 160);
}
export function downloadJson(filename, data) {
    const text = JSON.stringify(data, null, 2);
    const cleanFilename = safeFilename(filename, "fbl-vn-cutscenes.json");
    if (typeof globalThis.saveDataToFile === "function") {
        globalThis.saveDataToFile(text, "application/json", cleanFilename);
        return;
    }
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = cleanFilename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function readJsonFile(file) {
    const text = await file.text();
    return JSON.parse(text);
}


export function formDialog({ title = "Ввод", content = "", submitLabel = "OK", cancelLabel = "Отмена", danger = false } = {}) {
    return new Promise(resolve => {
        const backdrop = document.createElement("div");
        backdrop.className = "fbl-vn-modal-backdrop";
        const titleText = escapeHtml(title);
        const submitText = escapeHtml(submitLabel);
        const cancelText = escapeHtml(cancelLabel);
        backdrop.innerHTML = `
          <form class="fbl-vn-modal" autocomplete="off">
            <header><strong>${titleText}</strong></header>
            <section class="fbl-vn-modal-body">${content}</section>
            <footer>
              <button type="button" data-dialog-cancel>${cancelText}</button>
              <button type="submit" class="${danger ? "danger" : ""}">${submitText}</button>
            </footer>
          </form>`;
        const form = backdrop.querySelector("form");
        const cleanup = (value) => {
            backdrop.remove();
            document.removeEventListener("keydown", onKeyDown, true);
            resolve(value);
        };
        const onKeyDown = event => {
            if (event.key === "Escape") {
                event.preventDefault();
                cleanup(null);
            }
        };
        backdrop.addEventListener("mousedown", event => {
            if (event.target === backdrop) cleanup(null);
        });
        const cancel = backdrop.querySelector("[data-dialog-cancel]");
        if (cancel) cancel.addEventListener("click", event => {
            event.preventDefault();
            cleanup(null);
        });
        form.addEventListener("submit", event => {
            event.preventDefault();
            const data = {};
            const formData = new FormData(form);
            for (const [key, value] of formData.entries()) data[key] = value;
            cleanup(data);
        });
        document.body.appendChild(backdrop);
        document.addEventListener("keydown", onKeyDown, true);
        const first = backdrop.querySelector("input, select, textarea, button[type='submit']");
        if (first && typeof first.focus === "function") {
            setTimeout(() => {
                first.focus();
                if (typeof first.select === "function" && first.tagName === "INPUT") first.select();
            }, 0);
        }
    });
}

export function escapeHtml(value) {
    const div = document.createElement("div");
    div.textContent = value !== null && value !== void 0 ? value : "";
    return div.innerHTML;
}
