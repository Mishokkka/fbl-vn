import { MODULE_ID } from "./constants.js";
export function randomId(prefix = "id") {
    const random = globalThis.foundry?.utils?.randomID?.(10) ?? Math.random().toString(36).slice(2, 12);
    return `${prefix}-${random}`;
}
export function duplicateData(data) {
    if (globalThis.foundry?.utils?.deepClone) return globalThis.foundry.utils.deepClone(data);
    return JSON.parse(JSON.stringify(data));
}
export function mergeData(target, source) {
    if (globalThis.foundry?.utils?.mergeObject) return globalThis.foundry.utils.mergeObject(target, source, { inplace: false });
    return Object.assign({}, target, source);
}
export function localize(key) {
    return globalThis.game?.i18n?.localize?.(key) ?? key;
}
export function warn(message) {
    console.warn(`${MODULE_ID} | ${message}`);
}
export function notify(message) {
    globalThis.ui?.notifications?.info?.(message);
}
export function notifyWarn(message) {
    globalThis.ui?.notifications?.warn?.(message);
}
export function notifyError(message) {
    globalThis.ui?.notifications?.error?.(message);
}

export async function confirmDialog(message, { title = "Подтверждение", yes = "Да", no = "Нет" } = {}) {
    const text = String(message ?? "");
    const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
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
    return globalThis.foundry?.applications?.apps?.FilePicker ?? globalThis.FilePicker;
}
export function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
export function safeFilename(value, fallback = "download.json") {
    const raw = String(value || fallback || "download.json").trim() || fallback;
    return raw.replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, " ").slice(0, 160);
}
export function serializeJson(data, { pretty = false } = {}) {
    return pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
}
export function downloadJson(filename, data) {
    const text = serializeJson(data);
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


/**
 * Render a lightweight modal form. `content` is trusted, author-generated HTML and is
 * inserted without escaping. Escape every dynamic value before interpolating it.
 */
export function formDialog({ title = "Ввод", content = "", submitLabel = "OK", cancelLabel = "Отмена", danger = false } = {}) {
    return new Promise(resolve => {
        const backdrop = document.createElement("div");
        backdrop.className = "fbl-vn-modal-backdrop";
        const previousFocus = document.activeElement;
        const titleId = `fbl-vn-dialog-title-${randomId("title")}`;
        const titleText = escapeHtml(title);
        const submitText = escapeHtml(submitLabel);
        const cancelText = escapeHtml(cancelLabel);
        backdrop.innerHTML = `
          <form class="fbl-vn-modal" autocomplete="off" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
            <header><strong id="${titleId}">${titleText}</strong></header>
            <section class="fbl-vn-modal-body">${content}</section>
            <footer>
              <button type="button" data-dialog-cancel>${cancelText}</button>
              <button type="submit" class="${danger ? "danger" : ""}">${submitText}</button>
            </footer>
          </form>`;
        const form = backdrop.querySelector("form");
        const focusable = () => [...form.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
        const cleanup = (value) => {
            backdrop.remove();
            document.removeEventListener("keydown", onKeyDown, true);
            if (previousFocus?.isConnected && typeof previousFocus.focus === "function") previousFocus.focus();
            resolve(value);
        };
        const onKeyDown = event => {
            if (event.key === "Escape") {
                event.preventDefault();
                cleanup(null);
                return;
            }
            if (event.key === "Tab") {
                const items = focusable();
                if (!items.length) {
                    event.preventDefault();
                    return;
                }
                const first = items[0];
                const last = items[items.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                }
                else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
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
