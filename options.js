"use strict";

const DEFAULTS = {
    "bb-readable-diff-blocked-authors": ["DSO-PR-Bot"],
    "bb-readable-diff-hide-comments-enabled": true,
    "bb-readable-diff-hide-resolved-enabled": false,
    "bb-readable-diff-hide-outdated-enabled": false,
    "bb-readable-diff-show-notifications": true,
    "bb-readable-diff-local-repo-root": "",
    "bb-readable-diff-theme": "auto",
    "bb-readable-diff-code-font": "Menlo, Monaco, Consolas, 'Courier New', monospace",
    "bb-readable-diff-external-tools": [
        { name: "VS Code", template: "vscode://file/{path}" },
        { name: "JetBrains IDEA", template: "jetbrains://idea/navigate/reference?project={repoSlug}&path={path}" }
    ]
};

const KEYS = Object.keys(DEFAULTS);

const THEME_OPTIONS = [
    { value: "auto", label: "Auto" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" }
];

const FONT_OPTIONS = [
    { value: "Menlo, Monaco, Consolas, 'Courier New', monospace", label: "Default" },
    { value: "'SF Mono', Menlo, monospace", label: "SF Mono" },
    { value: "'Fira Code', 'SF Mono', Menlo, monospace", label: "Fira Code" },
    { value: "'JetBrains Mono', Menlo, monospace", label: "JetBrains Mono" },
    { value: "'Cascadia Code', Menlo, monospace", label: "Cascadia Code" },
    { value: "'Source Code Pro', Menlo, monospace", label: "Source Code Pro" },
    { value: "'IBM Plex Mono', Menlo, monospace", label: "IBM Plex Mono" }
];

function getSettings() {
    return new Promise((resolve) => {
        chrome.storage.local.get(KEYS, (data) => {
            const merged = {};

            for (const key of KEYS) {
                merged[key] = Object.prototype.hasOwnProperty.call(data, key)
                    ? data[key]
                    : DEFAULTS[key];
            }

            resolve(merged);
        });
    });
}

function saveSettings(partial) {
    return new Promise((resolve) => {
        chrome.storage.local.set(partial, resolve);
    });
}

function showStatus(message) {
    const el = document.getElementById("status");
    el.textContent = message;

    clearTimeout(showStatus._timer);
    showStatus._timer = setTimeout(() => {
        el.textContent = "";
    }, 3000);
}

function renderAuthors(authors) {
    const list = document.getElementById("author-list");
    list.innerHTML = "";

    if (authors.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = "No authors blocked yet.";
        list.appendChild(empty);
        return;
    }

    for (const author of authors) {
        const li = document.createElement("li");
        li.className = "row";

        const name = document.createElement("span");
        name.className = "row-main";
        name.textContent = author;

        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "btn btn-small btn-danger";
        removeButton.textContent = "Remove";
        removeButton.addEventListener("click", async () => {
            const current = await getSettings();
            const next = current["bb-readable-diff-blocked-authors"].filter((item) => item !== author);
            await saveSettings({ "bb-readable-diff-blocked-authors": next });
            renderAuthors(next);
        });

        li.appendChild(name);
        li.appendChild(removeButton);
        list.appendChild(li);
    }
}

function renderExternalTools(tools) {
    const list = document.getElementById("tool-list");
    list.innerHTML = "";

    if (tools.length === 0) {
        const empty = document.createElement("li");
        empty.className = "empty";
        empty.textContent = "No external tools configured.";
        list.appendChild(empty);
        return;
    }

    for (const tool of tools) {
        const li = document.createElement("li");
        li.className = "row";

        const body = document.createElement("div");
        body.className = "tool-body";

        const name = document.createElement("strong");
        name.textContent = tool.name;

        const template = document.createElement("code");
        template.textContent = tool.template;

        body.appendChild(name);
        body.appendChild(template);

        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "btn btn-small btn-danger";
        removeButton.textContent = "Remove";
        removeButton.addEventListener("click", async () => {
            const current = await getSettings();
            const next = current["bb-readable-diff-external-tools"].filter((item) => item.name !== tool.name);
            await saveSettings({ "bb-readable-diff-external-tools": next });
            renderExternalTools(next);
        });

        li.appendChild(body);
        li.appendChild(removeButton);
        list.appendChild(li);
    }
}

async function addExternalTool() {
    const nameInput = document.getElementById("new-tool-name");
    const templateInput = document.getElementById("new-tool-template");
    const name = nameInput.value.trim();
    const template = templateInput.value.trim();

    if (!name || !template) {
        return;
    }

    const current = await getSettings();
    const tools = current["bb-readable-diff-external-tools"];

    if (!tools.some((tool) => tool.name === name)) {
        tools.push({ name, template });
        await saveSettings({ "bb-readable-diff-external-tools": tools });
        renderExternalTools(tools);
    }

    nameInput.value = "";
    templateInput.value = "";
}

async function loadForm() {
    const settings = await getSettings();

    document.getElementById("hide-comments").checked = settings["bb-readable-diff-hide-comments-enabled"];
    document.getElementById("hide-resolved").checked = settings["bb-readable-diff-hide-resolved-enabled"];
    document.getElementById("hide-outdated").checked = settings["bb-readable-diff-hide-outdated-enabled"];
    document.getElementById("show-notifications").checked = settings["bb-readable-diff-show-notifications"];
    document.getElementById("local-repo-root").value = settings["bb-readable-diff-local-repo-root"];

    const themeSelect = document.getElementById("theme");
    themeSelect.innerHTML = "";
    for (const option of THEME_OPTIONS) {
        const el = document.createElement("option");
        el.value = option.value;
        el.textContent = option.label;
        el.selected = option.value === settings["bb-readable-diff-theme"];
        themeSelect.appendChild(el);
    }

    const fontSelect = document.getElementById("code-font");
    fontSelect.innerHTML = "";
    for (const option of FONT_OPTIONS) {
        const el = document.createElement("option");
        el.value = option.value;
        el.textContent = option.label;
        el.selected = option.value === settings["bb-readable-diff-code-font"];
        fontSelect.appendChild(el);
    }

    renderAuthors(settings["bb-readable-diff-blocked-authors"]);
    renderExternalTools(settings["bb-readable-diff-external-tools"]);
}

function bindToggle(id, key) {
    document.getElementById(id).addEventListener("change", (event) => {
        saveSettings({ [key]: event.target.checked });
    });
}

async function addAuthor() {
    const input = document.getElementById("new-author");
    const value = input.value.trim();

    if (!value) {
        return;
    }

    const current = await getSettings();
    const authors = current["bb-readable-diff-blocked-authors"];

    if (!authors.includes(value)) {
        authors.push(value);
        await saveSettings({ "bb-readable-diff-blocked-authors": authors });
        renderAuthors(authors);
    }

    input.value = "";
}

function applyImport() {
    const area = document.getElementById("import-area");
    let parsed;

    try {
        parsed = JSON.parse(area.value);
    } catch {
        showStatus("Invalid JSON.");
        return;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        showStatus("Settings must be a JSON object.");
        return;
    }

    const partial = {};

    for (const key of KEYS) {
        if (Object.prototype.hasOwnProperty.call(parsed, key)) {
            partial[key] = parsed[key];
        }
    }

    saveSettings(partial).then(async () => {
        showStatus("Settings imported.");
        area.value = "";
        area.hidden = true;
        document.getElementById("apply-import").hidden = true;
        await loadForm();
    });
}

document.addEventListener("DOMContentLoaded", async () => {
    await loadForm();

    bindToggle("hide-comments", "bb-readable-diff-hide-comments-enabled");
    bindToggle("hide-resolved", "bb-readable-diff-hide-resolved-enabled");
    bindToggle("hide-outdated", "bb-readable-diff-hide-outdated-enabled");
    bindToggle("show-notifications", "bb-readable-diff-show-notifications");

    document.getElementById("local-repo-root").addEventListener("change", (event) => {
        saveSettings({ "bb-readable-diff-local-repo-root": event.target.value.trim() });
    });

    document.getElementById("theme").addEventListener("change", (event) => {
        saveSettings({ "bb-readable-diff-theme": event.target.value });
    });

    document.getElementById("code-font").addEventListener("change", (event) => {
        saveSettings({ "bb-readable-diff-code-font": event.target.value });
    });

    document.getElementById("add-author").addEventListener("click", addAuthor);
    document.getElementById("new-author").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            addAuthor();
        }
    });

    document.getElementById("add-tool").addEventListener("click", addExternalTool);
    document.getElementById("new-tool-name").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            document.getElementById("new-tool-template").focus();
        }
    });
    document.getElementById("new-tool-template").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            addExternalTool();
        }
    });

    document.getElementById("export-settings").addEventListener("click", async () => {
        const settings = await getSettings();
        const json = JSON.stringify(settings, null, 2);

        try {
            await navigator.clipboard.writeText(json);
            showStatus("Settings copied to clipboard.");
        } catch {
            showStatus("Could not copy to clipboard.");
        }
    });

    document.getElementById("import-settings").addEventListener("click", () => {
        const area = document.getElementById("import-area");
        const applyButton = document.getElementById("apply-import");
        area.hidden = !area.hidden;
        applyButton.hidden = area.hidden;

        if (!area.hidden) {
            area.focus();
        }
    });

    document.getElementById("apply-import").addEventListener("click", applyImport);

    document.getElementById("reset").addEventListener("click", async () => {
        await saveSettings(DEFAULTS);
        showStatus("Settings reset to defaults.");
        await loadForm();
    });
});
