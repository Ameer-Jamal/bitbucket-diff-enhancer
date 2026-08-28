"use strict";

const DEFAULTS = {
    "bb-readable-diff-blocked-authors": ["DSO-PR-Bot"],
    "bb-readable-diff-hide-comments-enabled": true,
    "bb-readable-diff-hide-resolved-enabled": false,
    "bb-readable-diff-show-notifications": true,
    "bb-readable-diff-local-repo-root": ""
};

const KEYS = Object.keys(DEFAULTS);

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
        li.className = "author-row";

        const name = document.createElement("span");
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

async function loadForm() {
    const settings = await getSettings();

    document.getElementById("hide-comments").checked = settings["bb-readable-diff-hide-comments-enabled"];
    document.getElementById("hide-resolved").checked = settings["bb-readable-diff-hide-resolved-enabled"];
    document.getElementById("show-notifications").checked = settings["bb-readable-diff-show-notifications"];
    document.getElementById("local-repo-root").value = settings["bb-readable-diff-local-repo-root"];
    renderAuthors(settings["bb-readable-diff-blocked-authors"]);
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
    bindToggle("show-notifications", "bb-readable-diff-show-notifications");

    document.getElementById("local-repo-root").addEventListener("change", (event) => {
        saveSettings({ "bb-readable-diff-local-repo-root": event.target.value.trim() });
    });

    document.getElementById("add-author").addEventListener("click", addAuthor);
    document.getElementById("new-author").addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            addAuthor();
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
