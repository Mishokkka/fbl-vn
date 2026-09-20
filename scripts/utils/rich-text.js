const ALLOWED_TAGS = new Set([
    "b", "strong", "i", "em", "u", "s", "strike", "sub", "sup",
    "br", "p", "div", "span", "ul", "ol", "li", "blockquote", "font"
]);

const DROP_TAGS = new Set([
    "script", "style", "iframe", "object", "embed", "svg", "math",
    "img", "video", "audio", "source", "link", "meta", "form", "input",
    "button", "select", "textarea"
]);

const ALLOWED_STYLE_PROPERTIES = new Set([
    "font-family",
    "font-size",
    "color",
    "background-color",
    "text-align",
    "font-weight",
    "font-style",
    "text-decoration"
]);

const CACHE_LIMIT = 4096;
const SANITIZED_HTML_CACHE = new Map();
const PLAIN_TEXT_CACHE = new Map();

function cacheSet(cache, key, value) {
    if (cache.size >= CACHE_LIMIT && !cache.has(key)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, value);
    return value;
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function decodeBasicEntities(value) {
    return String(value ?? "")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;|&apos;/gi, "'")
        .replace(/&amp;/gi, "&");
}

function sanitizeColor(value) {
    const clean = String(value || "").trim();
    if (!clean || clean.length > 80) return "";
    if (/^#[0-9a-f]{3,8}$/i.test(clean)) return clean;
    if (/^(?:rgb|rgba|hsl|hsla)\([0-9.%+\- ,/]+\)$/i.test(clean)) return clean;
    if (/^[a-z]{1,24}$/i.test(clean)) return clean;
    return "";
}

function sanitizeFontFamily(value) {
    const clean = String(value || "").trim();
    if (!clean || clean.length > 120) return "";
    if (!/^[a-z0-9 _,'".\-]+$/i.test(clean)) return "";
    return clean;
}

function sanitizeFontSize(value) {
    const clean = String(value || "").trim();
    if (!clean || clean.length > 24) return "";
    if (/^(?:xx-small|x-small|small|medium|large|x-large|xx-large|smaller|larger)$/i.test(clean)) return clean;
    const match = clean.match(/^([0-9]+(?:\.[0-9]+)?)(px|pt|em|rem|%)$/i);
    if (!match) return "";
    const number = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(number) || number <= 0) return "";
    if ((unit === "px" || unit === "pt") && number > 96) return "";
    if ((unit === "em" || unit === "rem") && number > 6) return "";
    if (unit === "%" && number > 600) return "";
    return `${number}${unit}`;
}

function sanitizeStyleValue(property, value) {
    const clean = String(value || "").trim();
    if (!clean || clean.length > 160 || /(?:url|expression|javascript|data\s*:|@import)\s*\(/i.test(clean)) return "";
    if (property === "color" || property === "background-color") return sanitizeColor(clean);
    if (property === "font-family") return sanitizeFontFamily(clean);
    if (property === "font-size") return sanitizeFontSize(clean);
    if (property === "text-align") return /^(?:left|center|right|justify)$/i.test(clean) ? clean.toLowerCase() : "";
    if (property === "font-style") return /^(?:normal|italic|oblique)$/i.test(clean) ? clean.toLowerCase() : "";
    if (property === "font-weight") return /^(?:normal|bold|bolder|lighter|[1-9]00)$/i.test(clean) ? clean.toLowerCase() : "";
    if (property === "text-decoration") {
        const tokens = clean.toLowerCase().split(/\s+/).filter(Boolean);
        return tokens.length && tokens.every(token => ["none", "underline", "line-through", "overline"].includes(token))
            ? tokens.join(" ")
            : "";
    }
    return "";
}

function sanitizeStyle(styleText) {
    const declarations = [];
    for (const declaration of String(styleText || "").split(";")) {
        const separator = declaration.indexOf(":");
        if (separator <= 0) continue;
        const property = declaration.slice(0, separator).trim().toLowerCase();
        if (!ALLOWED_STYLE_PROPERTIES.has(property)) continue;
        const value = sanitizeStyleValue(property, declaration.slice(separator + 1));
        if (value) declarations.push(`${property}: ${value}`);
    }
    return declarations.join("; ");
}

function sanitizeTree(root) {
    const visit = node => {
        for (const child of [...node.childNodes]) {
            if (child.nodeType === 3) continue;
            if (child.nodeType !== 1) {
                child.remove();
                continue;
            }

            const tag = child.tagName.toLowerCase();
            if (DROP_TAGS.has(tag)) {
                child.remove();
                continue;
            }

            if (!ALLOWED_TAGS.has(tag)) {
                visit(child);
                child.replaceWith(...child.childNodes);
                continue;
            }

            const originalAttributes = {};
            for (const attribute of [...child.attributes]) originalAttributes[attribute.name.toLowerCase()] = attribute.value;
            for (const attribute of [...child.attributes]) child.removeAttribute(attribute.name);

            if (originalAttributes.style) {
                const cleanStyle = sanitizeStyle(originalAttributes.style);
                if (cleanStyle) child.setAttribute("style", cleanStyle);
            }

            if (tag === "font") {
                const face = sanitizeFontFamily(originalAttributes.face);
                const color = sanitizeColor(originalAttributes.color);
                const size = String(originalAttributes.size || "").trim();
                if (face) child.setAttribute("face", face);
                if (color) child.setAttribute("color", color);
                if (/^[1-7]$/.test(size)) child.setAttribute("size", size);
            }

            visit(child);
        }
    };
    visit(root);
}

function fallbackPlainTextFromHtml(html) {
    return decodeBasicEntities(
        String(html || "")
            .replace(/<\s*br\s*\/?\s*>/gi, "\n")
            .replace(/<\s*\/\s*(?:p|div|li|blockquote)\s*>/gi, "\n")
            .replace(/<[^>]*>/g, "")
    )
        .replace(/\r\n?/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd();
}

export function richTextFromPlainText(text) {
    return escapeHtml(String(text ?? "").replace(/\r\n?/g, "\n")).replace(/\n/g, "<br>");
}

export function richTextToPlainText(html) {
    const source = String(html ?? "");
    if (!source) return "";
    if (PLAIN_TEXT_CACHE.has(source)) return PLAIN_TEXT_CACHE.get(source);

    if (typeof DOMParser !== "function") return cacheSet(PLAIN_TEXT_CACHE, source, fallbackPlainTextFromHtml(source));

    try {
        const doc = new DOMParser().parseFromString(`<div data-rich-root>${source}</div>`, "text/html");
        const root = doc.body.querySelector("[data-rich-root]");
        if (!root) return fallbackPlainTextFromHtml(source);

        const blockTags = new Set(["p", "div", "li", "blockquote"]);
        let output = "";
        const walk = node => {
            for (const child of node.childNodes) {
                if (child.nodeType === 3) {
                    output += child.data;
                    continue;
                }
                if (child.nodeType !== 1) continue;
                const tag = child.tagName.toLowerCase();
                if (tag === "br") {
                    output += "\n";
                    continue;
                }
                walk(child);
                if (blockTags.has(tag) && output && !output.endsWith("\n")) output += "\n";
            }
        };
        walk(root);
        return cacheSet(PLAIN_TEXT_CACHE, source, output.replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trimEnd());
    }
    catch (_error) {
        return cacheSet(PLAIN_TEXT_CACHE, source, fallbackPlainTextFromHtml(source));
    }
}

export function sanitizeRichTextHtml(html, { fallbackText = "" } = {}) {
    const source = String(html ?? "");
    const fallback = String(fallbackText ?? "");
    const cacheKey = `${source}\u0000${fallback}`;
    if (SANITIZED_HTML_CACHE.has(cacheKey)) return SANITIZED_HTML_CACHE.get(cacheKey);
    if (!source.trim()) return cacheSet(SANITIZED_HTML_CACHE, cacheKey, richTextFromPlainText(fallback));

    if (typeof DOMParser !== "function") {
        return cacheSet(SANITIZED_HTML_CACHE, cacheKey, richTextFromPlainText(fallbackPlainTextFromHtml(source) || fallback));
    }

    try {
        const doc = new DOMParser().parseFromString(`<div data-rich-root>${source}</div>`, "text/html");
        const root = doc.body.querySelector("[data-rich-root]");
        if (!root) return cacheSet(SANITIZED_HTML_CACHE, cacheKey, richTextFromPlainText(fallback));
        sanitizeTree(root);
        const clean = root.innerHTML.trim();
        return cacheSet(SANITIZED_HTML_CACHE, cacheKey, clean || richTextFromPlainText(fallback));
    }
    catch (_error) {
        return cacheSet(SANITIZED_HTML_CACHE, cacheKey, richTextFromPlainText(fallbackPlainTextFromHtml(source) || fallback));
    }
}
