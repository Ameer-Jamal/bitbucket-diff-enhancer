// Bitbucket Diff Enhancer — content script
// Provides readable PR diff extraction and comment filtering on Bitbucket Cloud.
// The Tampermonkey GM_* APIs used by the shared logic are shimmed onto the
// Chrome extension APIs below.

let __bbDiffEnhancerSettings = {};

function GM_getValue(key, defaultValue) {
    if (Object.prototype.hasOwnProperty.call(__bbDiffEnhancerSettings, key)) {
        return __bbDiffEnhancerSettings[key];
    }

    return defaultValue;
}

function GM_setValue(key, value) {
    __bbDiffEnhancerSettings[key] = value;

    try {
        chrome.storage.local.set({ [key]: value });
    } catch (error) {
        // ignore storage failures
    }
}

function GM_setClipboard(text) {
    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text);
        }
    } catch (error) {
        // ignore clipboard failures
    }
}

function GM_xmlhttpRequest(details) {
    const message = {
        type: "bb-diff-enhancer-fetch",
        url: details.url,
        method: details.method || "GET",
        accept: (details.headers && details.headers.Accept) || "*/*",
        headers: details.headers || {}
    };

    const timer = setTimeout(() => {
        if (typeof details.ontimeout === "function") {
            details.ontimeout();
        }
    }, details.timeout || 120000);

    try {
        chrome.runtime.sendMessage(message, (response) => {
            clearTimeout(timer);

            if (chrome.runtime.lastError) {
                if (typeof details.onerror === "function") {
                    details.onerror({ error: chrome.runtime.lastError.message });
                }
                return;
            }

            if (!response || response.ok === false) {
                if (typeof details.onerror === "function") {
                    details.onerror({ error: (response && response.error) || "Background fetch failed" });
                }
                return;
            }

            if (typeof details.onload === "function") {
                details.onload({
                    status: response.status,
                    statusText: response.statusText,
                    responseText: response.text,
                    responseHeaders: response.responseHeaders || "",
                    finalUrl: response.finalUrl || details.url
                });
            }
        });
    } catch (error) {
        clearTimeout(timer);

        if (typeof details.onerror === "function") {
            details.onerror({ error: String((error && error.message) || error) });
        }
    }
}

function backgroundFetch(url, accept, method, headers) {
    return new Promise((resolve, reject) => {
        const message = {
            type: "bb-diff-enhancer-fetch",
            url: url,
            method: method || "GET",
            accept: accept || "*/*",
            headers: headers || {}
        };

        try {
            chrome.runtime.sendMessage(message, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                    return;
                }

                if (!response || response.ok === false) {
                    reject(new Error((response && response.error) || "Background fetch failed"));
                    return;
                }

                resolve(response);
            });
        } catch (error) {
            reject(error);
        }
    });
}

function loadStoredSettings() {
    return new Promise((resolve) => {
        try {
            chrome.storage.local.get(null, (data) => {
                for (const [key, value] of Object.entries(data || {})) {
                    __bbDiffEnhancerSettings[key] = value;
                }

                resolve();
            });
        } catch (error) {
            resolve();
        }
    });
}

// Keep the in-memory settings cache in sync with the options page.
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") {
            return;
        }

        for (const [key, change] of Object.entries(changes || {})) {
            __bbDiffEnhancerSettings[key] = change.newValue;
        }
    });
}

(function () {
    "use strict";

    const DEBUG = false;

    const SETTINGS_LOCAL_REPO_ROOT = "bb-readable-diff-local-repo-root";
    const SETTINGS_THEME = "bb-readable-diff-theme";
    const SETTINGS_CODE_FONT = "bb-readable-diff-code-font";
    const SETTINGS_EXTERNAL_TOOLS = "bb-readable-diff-external-tools";

    const ids = {
        pageToolbar: "bb-readable-diff-header-actions",
        modal: "bb-readable-diff-modal",
        settingsModal: "bb-readable-diff-settings-modal"
    };

    const attributes = {
        fileButtonsAdded: "data-bb-readable-diff-buttons-added"
    };

    const selectors = {
        stickyHeader: "#sticky-header-content",
        prHeader: '[data-testid="pr-header"]',
        file: 'article[data-qa="branch-diff-file"]',
        fileHeader: '[data-qa="bk-file__header"], [data-testid="file-header"]',
        fileActions: '[data-qa="bk-file__actions"], [data-testid="file-actions"]',
        filePath: '[data-qa="bk-filepath"]',
        fileTreeLink: [
            '[data-testid="pull-request-file-tree"] a[href]',
            '[data-testid="file-tree"] a[href]',
            '[data-qa="file-tree"] a[href]',
            '[role="tree"] a[href]',
            'aside nav a[role="treeitem"]',
            'aside nav a[href*="#"]'
        ].join(", "),
        diffChunk: ".diff-chunk",
        chunkHeading: ".chunk-heading",
        row: '.lines-wrapper[data-key="code-line"], .lines-wrapper[role="row"]',
        line: '.line-wrapper[data-qa="code-line"]',
        code: ".code-diff"
    };

    const normalizeWhitespace = BbDiffEnhancer.normalizeWhitespace;

    const themePalettes = {
        light: {
            overlay: "rgba(9, 30, 66, 0.54)",
            panelBg: "#ffffff",
            toolbarBg: "#fafbfc",
            rowBg: "#f4f5f7",
            inputBg: "#ffffff",
            border: "#dfe1e6",
            text: "#172b4d",
            muted: "#5e6c84",
            toastBg: "#172b4d",
            toastColor: "#ffffff",
            diff: {
                header: "#6f42c1",
                hunk: "#0052cc",
                add: "#00875a",
                remove: "#de350b",
                context: "#172b4d"
            }
        },
        dark: {
            overlay: "rgba(0, 0, 0, 0.6)",
            panelBg: "#1d2125",
            toolbarBg: "#161a1d",
            rowBg: "#22272b",
            inputBg: "#22272b",
            border: "#2c333a",
            text: "#c7d1db",
            muted: "#9fadbc",
            toastBg: "#101214",
            toastColor: "#e6edf3",
            diff: {
                header: "#c792ea",
                hunk: "#6cb6ff",
                add: "#7ee787",
                remove: "#ff7b72",
                context: "#c7d1db"
            }
        }
    };

    const FONT_OPTIONS = [
        { label: "Default", value: "Menlo, Monaco, Consolas, 'Courier New', monospace" },
        { label: "SF Mono", value: "'SF Mono', Menlo, monospace" },
        { label: "Fira Code", value: "'Fira Code', 'SF Mono', Menlo, monospace" },
        { label: "JetBrains Mono", value: "'JetBrains Mono', Menlo, monospace" },
        { label: "Cascadia Code", value: "'Cascadia Code', Menlo, monospace" },
        { label: "Source Code Pro", value: "'Source Code Pro', Menlo, monospace" },
        { label: "IBM Plex Mono", value: "'IBM Plex Mono', Menlo, monospace" }
    ];

    const DEFAULT_EXTERNAL_TOOLS = [
        { name: "VS Code", template: "vscode://file/{path}" },
        { name: "JetBrains IDEA", template: "jetbrains://idea/navigate/reference?project={repoSlug}&path={path}" }
    ];

    function isDarkTheme() {
        const htmlTheme = document.documentElement.getAttribute("data-theme") ||
            document.documentElement.getAttribute("data-color-mode");

        if (htmlTheme) {
            return htmlTheme === "dark";
        }

        return Boolean(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    }

    function getTheme() {
        const preference = getStoredJson(SETTINGS_THEME, "auto");

        if (preference === "light") {
            return themePalettes.light;
        }

        if (preference === "dark") {
            return themePalettes.dark;
        }

        return isDarkTheme() ? themePalettes.dark : themePalettes.light;
    }

    function getFilePath(fileElement) {
        const ariaLabel = fileElement.getAttribute("aria-label") || "";
        const ariaMatch = ariaLabel.match(/^Diff of file\s+(.+)$/i);

        if (ariaMatch && ariaMatch[1]) {
            return ariaMatch[1].trim();
        }

        const pathElement = fileElement.querySelector(selectors.filePath);

        if (!pathElement) {
            return "unknown-file";
        }

        return normalizeWhitespace(pathElement.textContent)
            .replace(/\s+/g, "")
            .trim() || "unknown-file";
    }

    function getChunkHeader(chunkElement) {
        const headingElement = chunkElement.querySelector(selectors.chunkHeading);

        if (!headingElement) {
            return "";
        }

        const text = normalizeWhitespace(headingElement.textContent).trim();
        const match = text.match(/@@[\s\S]*?@@/);

        return match ? match[0] : "";
    }

    function getLineType(lineElement) {
        const codeElement = lineElement.querySelector(selectors.code);
        const dataLineType = codeElement ? codeElement.getAttribute("data-line-type") : "";

        if (lineElement.classList.contains("type-add") || dataLineType === "+") {
            return "+";
        }

        if (
            lineElement.classList.contains("type-remove") ||
            lineElement.classList.contains("type-delete") ||
            lineElement.classList.contains("type-del") ||
            dataLineType === "-"
        ) {
            return "-";
        }

        if (lineElement.classList.contains("type-empty")) {
            return "";
        }

        return " ";
    }

    function getCodeText(lineElement) {
        const codeElement = lineElement.querySelector(selectors.code);

        if (!codeElement) {
            return "";
        }

        const ariaLabel = codeElement.getAttribute("aria-label") || "";

        if (ariaLabel) {
            return ariaLabel
                .replace(/^(Added|Removed|Deleted|Unchanged): ?/i, "")
                .replace(/\n$/, "");
        }

        return normalizeWhitespace(codeElement.textContent).replace(/\n$/, "");
    }

    function extractRow(rowElement) {
        const lineElements = Array.from(rowElement.querySelectorAll(selectors.line));

        if (lineElements.length === 0) {
            return null;
        }

        const removedLine = lineElements.find((lineElement) => getLineType(lineElement) === "-");
        const addedLine = lineElements.find((lineElement) => getLineType(lineElement) === "+");

        if (removedLine) {
            return `-${getCodeText(removedLine)}`;
        }

        if (addedLine) {
            return `+${getCodeText(addedLine)}`;
        }

        const normalLine = lineElements.find((lineElement) => getLineType(lineElement) === " ");

        if (normalLine) {
            return ` ${getCodeText(normalLine)}`;
        }

        return null;
    }

    function extractFileDiff(fileElement) {
        const filePath = getFilePath(fileElement);
        const output = [
            `diff --git a/${filePath} b/${filePath}`,
            `--- a/${filePath}`,
            `+++ b/${filePath}`
        ];

        const chunkElements = Array.from(fileElement.querySelectorAll(selectors.diffChunk));

        for (const chunkElement of chunkElements) {
            const chunkHeader = getChunkHeader(chunkElement);
            const rowElements = Array.from(chunkElement.querySelectorAll(selectors.row));
            const lines = rowElements
                .map(extractRow)
                .filter((line) => line !== null);

            if (lines.length === 0) {
                continue;
            }

            if (chunkHeader) {
                output.push(chunkHeader);
            }

            output.push(...lines);
        }

        if (output.length === 3) {
            throw new Error(`No visible diff lines found for ${filePath}. Expand the file first, then retry.`);
        }

        return output.join("\n");
    }

    function extractAllVisibleDiffs() {
        const fileElements = Array.from(document.querySelectorAll(selectors.file));

        const diffs = fileElements
            .map((fileElement) => {
                try {
                    return extractFileDiff(fileElement);
                } catch {
                    return "";
                }
            })
            .filter(Boolean);

        if (diffs.length === 0) {
            throw new Error("No visible Bitbucket diff lines were found. Expand the diff files first, then retry.");
        }

        return diffs.join("\n\n");
    }

    function parsePullRequestUrl(url = globalThis.location.href) {
        const href = String(url);

        const prMatch = href.match(
            /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/pull-requests\/(\d+)/
        );

        if (prMatch) {
            return {
                type: "pullrequest",
                workspace: prMatch[1],
                repoSlug: prMatch[2],
                pullRequestId: prMatch[3]
            };
        }

        const compareMatch = href.match(
            /^https:\/\/bitbucket\.org\/([^/]+)\/([^/]+)\/branch\/compare\/([^/?#]+)/
        );

        if (compareMatch) {
            return {
                type: "compare",
                workspace: compareMatch[1],
                repoSlug: compareMatch[2],
                compareSpec: decodeURIComponent(compareMatch[3])
            };
        }

        return null;
    }

    function buildRepositoryApiPath(pageInfo, suffix) {
        const { workspace, repoSlug } = pageInfo;

        return `/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}${suffix}`;
    }

    const PAGE_FETCH_EVENT = "bb-readable-diff-page-fetch-result";

    function toSameOriginApiUrl(url) {
        return String(url).replace(/^https:\/\/api\.bitbucket\.org/, "https://bitbucket.org/api");
    }

    function toBangApiUrl(url) {
        return String(url).replace(/^https:\/\/api\.bitbucket\.org/, "https://bitbucket.org/!api");
    }

    function buildPullRequestApiPath(prInfo, suffix) {
        const { workspace, repoSlug, pullRequestId } = prInfo;

        return buildRepositoryApiPath(prInfo, `/pullrequests/${pullRequestId}${suffix}`);
    }

    function getApiAuthHeaders() {
        if (typeof GM_getValue !== "function") {
            return {};
        }

        const email = GM_getValue("apiEmail", "");
        const token = GM_getValue("apiToken", "");

        if (!email || !token) {
            return {};
        }

        return {
            Authorization: `Basic ${btoa(`${email}:${token}`)}`
        };
    }

    function buildSameOriginApiUrls(path) {
        return [
            `https://bitbucket.org/api${path}`,
            `https://bitbucket.org/!api${path}`
        ];
    }

    function extractPullRequestMetadataFromPage() {
        for (const scriptElement of document.querySelectorAll('script[type="application/json"]')) {
            try {
                const data = JSON.parse(scriptElement.textContent || "");

                if (data?.links?.diff?.href || (data?.source?.commit?.hash && data?.destination?.commit?.hash)) {
                    return data;
                }
            } catch {
                // ignore invalid JSON blocks
            }
        }

        const html = document.documentElement.innerHTML;
        const diffHrefMatch = html.match(/"diff"\s*:\s*\{\s*"href"\s*:\s*"((?:\\.|[^"\\])*)"/);

        if (diffHrefMatch) {
            const href = diffHrefMatch[1]
                .replace(/\\\//g, "/")
                .replace(/\\u002F/gi, "/");

            return {
                links: {
                    diff: {
                        href
                    }
                }
            };
        }

        return null;
    }

    function pageContextFetch(url, accept = "*/*") {
        return new Promise((resolve, reject) => {
            const timeoutMs = 120000;
            const timer = globalThis.setTimeout(() => {
                reject(new Error("Page fetch timed out"));
            }, timeoutMs);

            backgroundFetch(url, accept)
                .then((response) => {
                    globalThis.clearTimeout(timer);

                    if (response.status < 200 || response.status >= 300) {
                        reject(new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim()));
                        return;
                    }

                    resolve({
                        status: response.status,
                        statusText: response.statusText || "",
                        text: response.text || "",
                        responseUrl: response.finalUrl || url
                    });
                })
                .catch((error) => {
                    globalThis.clearTimeout(timer);
                    reject(error instanceof Error ? error : new Error(String(error)));
                });
        });
    }

    async function pageContextFetchText(url, accept) {
        const response = await pageContextFetch(url, accept);
        const text = response.text || "";

        if (!text.trim()) {
            throw new Error("Empty response");
        }

        return text;
    }

    async function tryPageContextUrls(urls, accept) {
        let lastError = null;

        for (const url of urls) {
            if (DEBUG) {
                console.debug("[bb-readable-diff] page fetch", url);
            }

            try {
                return await pageContextFetchText(url, accept);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
            }
        }

        throw lastError || new Error("All page-context requests failed");
    }

    function getLocationHeader(response) {
        if (response.headers) {
            return response.headers.get("Location");
        }

        const headerBlock = response.responseHeaders || "";
        const match = headerBlock.match(/^location:\s*(.+)$/im);

        return match ? match[1].trim() : null;
    }

    function gmHttpRequest(details) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                ...details,
                onload: resolve,
                onerror: (error) => {
                    reject(new Error(error?.error || "GM_xmlhttpRequest failed"));
                },
                ontimeout: () => {
                    reject(new Error("Request timed out"));
                }
            });
        });
    }

    async function gmFetchText(url, accept) {
        const authHeaders = getApiAuthHeaders();
        const headers = {
            Accept: accept,
            ...authHeaders
        };

        const response = await gmHttpRequest({
            method: "GET",
            url,
            headers,
            anonymous: false,
            timeout: 120000
        });

        if (response.status >= 300 && response.status < 400) {
            const location = getLocationHeader(response);

            if (location) {
                const nextUrl = new URL(location, url).href;

                if (nextUrl !== url) {
                    return gmFetchText(nextUrl, accept);
                }
            }

            throw new Error(`HTTP ${response.status} redirect without usable Location header`);
        }

        if (response.status < 200 || response.status >= 300) {
            throw new Error(`HTTP ${response.status} ${response.statusText || ""}`.trim());
        }

        const text = response.responseText || "";

        if (!text.trim()) {
            throw new Error("Empty response");
        }

        return text;
    }

    async function fetchJsonFromApi(path) {
        const pageUrls = buildSameOriginApiUrls(path);
        const apiUrl = `https://api.bitbucket.org${path}`;
        let lastError = null;

        try {
            const text = await tryPageContextUrls(pageUrls, "application/json");

            return JSON.parse(text);
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }

        try {
            const text = await gmFetchText(apiUrl, "application/json");

            return JSON.parse(text);
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }

        throw lastError || new Error(`Failed to fetch JSON from ${path}`);
    }

    async function fetchPaginatedJson(initialPath) {
        const items = [];
        let nextPath = initialPath;

        while (nextPath) {
            const page = await fetchJsonFromApi(nextPath);

            if (Array.isArray(page.values)) {
                items.push(...page.values);
            }

            const nextHref = page.next;

            if (!nextHref) {
                break;
            }

            nextPath = nextHref.replace(/^https:\/\/api\.bitbucket\.org/, "");
        }

        return items;
    }

    async function fetchPullRequestMetadata(prInfo) {
        const path = buildPullRequestApiPath(prInfo, "");
        const pageUrls = buildSameOriginApiUrls(path);
        let lastError = null;

        try {
            const text = await tryPageContextUrls(pageUrls, "application/json");

            return JSON.parse(text);
        } catch (error) {
            lastError = error instanceof Error ? error : new Error(String(error));
        }

        for (const url of pageUrls) {
            const apiUrl = url.replace("https://bitbucket.org/api", "https://api.bitbucket.org")
                .replace("https://bitbucket.org/!api", "https://api.bitbucket.org");

            try {
                const text = await gmFetchText(apiUrl, "application/json");

                return JSON.parse(text);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
            }
        }

        const embedded = extractPullRequestMetadataFromPage();

        if (embedded) {
            return embedded;
        }

        throw lastError || new Error("Failed to fetch pull request metadata");
    }

    function collectDiffFetchUrls(pageInfo, metadata) {
        const urls = [];
        const seen = new Set();

        const addUrl = (url) => {
            if (!url || seen.has(url)) {
                return;
            }

            seen.add(url);
            urls.push(url);
        };

        const diffHref = metadata?.links?.diff?.href;

        if (diffHref) {
            addUrl(toSameOriginApiUrl(diffHref));
            addUrl(toBangApiUrl(diffHref));
            addUrl(diffHref);
            return urls;
        }

        if (pageInfo.type === "pullrequest") {
            for (const pathSuffix of ["/diff", "/patch"]) {
                for (const pageUrl of buildSameOriginApiUrls(buildPullRequestApiPath(pageInfo, pathSuffix))) {
                    addUrl(pageUrl);
                }

                addUrl(`https://api.bitbucket.org${buildPullRequestApiPath(pageInfo, pathSuffix)}`);
            }
        }

        return urls;
    }

    function collectRepositoryDiffFetchUrls(pageInfo) {
        const encodedSpec = encodeURIComponent(pageInfo.compareSpec);
        const path = buildRepositoryApiPath(pageInfo, `/diff/${encodedSpec}?topic=true`);
        const urls = [];

        for (const pageUrl of buildSameOriginApiUrls(path)) {
            urls.push(pageUrl);
        }

        urls.push(`https://api.bitbucket.org${path}`);

        return urls;
    }

    function getDiffstatFilePath(entry) {
        if (entry.status === "removed") {
            return entry.old?.path || entry.new?.path || "";
        }

        return entry.new?.path || entry.old?.path || "";
    }

    async function fetchPullRequestDiffstat(prInfo) {
        const path = buildPullRequestApiPath(prInfo, "/diffstat");

        return fetchPaginatedJson(path);
    }

    function buildPerFileDiffUrls(diffBaseHref, filePath) {
        const separator = diffBaseHref.includes("?") ? "&" : "?";
        const apiBase = diffBaseHref.startsWith("https://api.bitbucket.org/")
            ? diffBaseHref
            : diffBaseHref.replace(/^https:\/\/bitbucket\.org\/(?:api|!api)/, "https://api.bitbucket.org");
        const fullApiUrl = `${apiBase}${separator}path=${encodeURIComponent(filePath)}`;

        return [...new Set([
            toSameOriginApiUrl(fullApiUrl),
            toBangApiUrl(fullApiUrl),
            fullApiUrl
        ])];
    }

    async function fetchPerFileDiffsFromApi(pageInfo, metadata) {
        const acceptHeader = "text/plain, text/x-diff, application/vnd.bitbucket.diff, */*";
        const diffHref = metadata?.links?.diff?.href;

        if (!diffHref) {
            throw new Error("No diff link in pull request metadata");
        }

        const diffstat = await fetchPullRequestDiffstat(pageInfo);
        const filePaths = diffstat
            .map(getDiffstatFilePath)
            .filter(Boolean);

        if (filePaths.length === 0) {
            throw new Error("Diffstat returned no changed files");
        }

        const parts = [];
        const missingFiles = [];

        for (const filePath of filePaths) {
            const urls = buildPerFileDiffUrls(diffHref, filePath);
            let fetched = false;

            for (const url of urls) {
                try {
                    const isApiHost = url.startsWith("https://api.bitbucket.org/");

                    const text = isApiHost
                        ? await gmFetchText(url, acceptHeader)
                        : await pageContextFetchText(url, acceptHeader);

                    if (text.trim()) {
                        parts.push(text.trim());
                        fetched = true;
                        break;
                    }
                } catch {
                    // try next URL variant
                }
            }

            if (!fetched) {
                missingFiles.push(filePath);
            }
        }

        if (parts.length === 0) {
            throw new Error("Per-file diff fetch returned no content");
        }

        return {
            text: parts.join("\n\n"),
            fileCount: parts.length,
            expectedCount: filePaths.length,
            missingFiles
        };
    }

    async function fetchFullPullRequestDiffFromApi(pageInfo) {
        const acceptHeader = "text/plain, text/x-diff, application/vnd.bitbucket.diff, */*";
        let metadata = null;
        let metadataError = null;

        if (pageInfo.type === "compare") {
            const diffUrls = collectRepositoryDiffFetchUrls(pageInfo);
            let lastError = null;

            for (const url of diffUrls) {
                try {
                    const isApiHost = url.startsWith("https://api.bitbucket.org/");

                    if (isApiHost) {
                        return await gmFetchText(url, acceptHeader);
                    }

                    return await pageContextFetchText(url, acceptHeader);
                } catch (error) {
                    lastError = error instanceof Error ? error : new Error(String(error));
                }
            }

            throw lastError || new Error("Failed to fetch repository compare diff");
        }

        try {
            metadata = await fetchPullRequestMetadata(pageInfo);
        } catch (error) {
            metadataError = error instanceof Error ? error : new Error(String(error));
        }

        const diffUrls = collectDiffFetchUrls(pageInfo, metadata);
        let lastError = metadataError;

        for (const url of diffUrls) {
            try {
                const isApiHost = url.startsWith("https://api.bitbucket.org/");

                if (isApiHost) {
                    return await gmFetchText(url, acceptHeader);
                }

                return await pageContextFetchText(url, acceptHeader);
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
            }
        }

        if (metadata) {
            try {
                const perFileResult = await fetchPerFileDiffsFromApi(pageInfo, metadata);

                return {
                    text: perFileResult.text,
                    source: "API per-file",
                    fileCount: perFileResult.fileCount,
                    expectedCount: perFileResult.expectedCount,
                    missingFiles: perFileResult.missingFiles
                };
            } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error));
            }
        }

        throw lastError || new Error("Failed to fetch pull request diff");
    }

    function clickLazyLoadDiffButtons() {
        const selectorsToClick = [
            ".load-diff",
            ".load-diff-button",
            "a.load-diff",
            'button[class*="load-diff"]',
            '[data-testid="load-diff-button"]',
            '[data-qa="load-diff"]',
            'a.try-again, button.try-again, .try-again a, .try-again button'
        ];

        for (const selector of selectorsToClick) {
            for (const element of document.querySelectorAll(selector)) {
                try {
                    element.click();
                } catch {
                    // ignore click failures on stale nodes
                }
            }
        }
    }

    function sleep(ms) {
        return new Promise((resolve) => {
            globalThis.setTimeout(resolve, ms);
        });
    }

    function collectFileDiffsFromDom(collectedDiffs) {
        for (const fileElement of document.querySelectorAll(selectors.file)) {
            try {
                const filePath = getFilePath(fileElement);
                const diff = extractFileDiff(fileElement);

                collectedDiffs.set(filePath, diff);
            } catch {
                // File is visible but not fully loaded yet.
            }
        }
    }

    function getExpectedFileCount() {
        const filesTab = document.querySelector('[data-testid="sidebar-tab-files"]');

        if (filesTab) {
            for (const spanElement of filesTab.querySelectorAll("span")) {
                const count = Number.parseInt(normalizeWhitespace(spanElement.textContent), 10);

                if (Number.isFinite(count) && count > 0) {
                    return count;
                }
            }
        }

        return getFileTreeNavTargets().length;
    }

    function getFileTreeNavTargets(filePathsFromDiffstat = null) {
        if (filePathsFromDiffstat && filePathsFromDiffstat.length > 0) {
            const links = [];
            const pathToLink = new Map();

            for (const linkElement of document.querySelectorAll(selectors.fileTreeLink)) {
                const path = linkElement.getAttribute("data-file-path") ||
                    linkElement.getAttribute("title") ||
                    normalizeWhitespace(linkElement.textContent);

                if (path) {
                    pathToLink.set(path, linkElement);
                }
            }

            for (const filePath of filePathsFromDiffstat) {
                const link = pathToLink.get(filePath);

                if (link) {
                    links.push(link);
                }
            }

            if (links.length > 0) {
                return links;
            }
        }

        const links = [];
        const seenPaths = new Set();

        for (const linkElement of document.querySelectorAll(selectors.fileTreeLink)) {
            if (linkElement.closest('[data-testid="sidebar-tab-files"]')) {
                continue;
            }

            const path = linkElement.getAttribute("data-file-path") ||
                linkElement.getAttribute("title") ||
                normalizeWhitespace(linkElement.textContent);

            if (!path || seenPaths.has(path)) {
                continue;
            }

            seenPaths.add(path);
            links.push(linkElement);
        }

        return links;
    }

    function findDiffScrollTargets() {
        const candidates = [
            document.querySelector('[data-testid="pull-request-diff"]'),
            document.querySelector('[data-qa="pull-request-diff"]'),
            document.querySelector('[data-testid="diff-view-container"]'),
            document.querySelector("main"),
            document.scrollingElement,
            document.documentElement
        ].filter(Boolean);

        const scrollTargets = [];
        const seenTargets = new Set();

        for (const candidate of candidates) {
            if (seenTargets.has(candidate)) {
                continue;
            }

            seenTargets.add(candidate);

            if (candidate.scrollHeight > candidate.clientHeight + 20) {
                scrollTargets.push(candidate);
            }
        }

        if (scrollTargets.length === 0) {
            scrollTargets.push(document.scrollingElement || document.documentElement);
        }

        return scrollTargets;
    }

    function isScrollAtBottom(scrollTargets) {
        const threshold = 40;

        for (const target of scrollTargets) {
            if (target.scrollTop + target.clientHeight < target.scrollHeight - threshold) {
                return false;
            }
        }

        return globalThis.scrollY + globalThis.innerHeight >=
            (document.documentElement.scrollHeight - threshold);
    }

    function scrollDiffViewportDown(scrollTargets, scrollStep) {
        let moved = false;

        for (const target of scrollTargets) {
            const before = target.scrollTop;
            const nextTop = Math.min(target.scrollTop + scrollStep, target.scrollHeight);

            if (nextTop > before) {
                target.scrollTop = nextTop;
                moved = true;
            }
        }

        const beforeWindowScroll = globalThis.scrollY;
        globalThis.scrollBy({ top: scrollStep, behavior: "auto" });

        if (globalThis.scrollY > beforeWindowScroll) {
            moved = true;
        }

        const fileElements = document.querySelectorAll(selectors.file);
        const lastFile = fileElements[fileElements.length - 1];

        if (lastFile) {
            const beforeTop = lastFile.getBoundingClientRect().top;
            lastFile.scrollIntoView({ block: "end", behavior: "auto" });

            if (lastFile.getBoundingClientRect().top !== beforeTop) {
                moved = true;
            }
        }

        return moved;
    }

    function expandCollapsedFileDiffs() {
        for (const buttonElement of document.querySelectorAll(
            `${selectors.file} button[aria-expanded="false"], ${selectors.file} [data-testid="expand-file"]`
        )) {
            try {
                buttonElement.click();
            } catch {
                // ignore stale nodes
            }
        }

        for (const expandElement of document.querySelectorAll(
            '.ellipsis[title*="Show"], button[aria-label*="Expand"], button[aria-label*="expand"], button[aria-label*="Show more"]'
        )) {
            try {
                expandElement.click();
            } catch {
                // ignore stale nodes
            }
        }
    }

    async function scrollThroughVisibleFiles(collectedDiffs, rounds = 10) {
        for (let round = 0; round < rounds; round += 1) {
            collectFileDiffsFromDom(collectedDiffs);

            for (const fileElement of document.querySelectorAll(selectors.file)) {
                const chunkElements = fileElement.querySelectorAll(selectors.diffChunk);
                const lastChunk = chunkElements[chunkElements.length - 1];

                if (lastChunk) {
                    lastChunk.scrollIntoView({ block: "end", behavior: "auto" });
                }
            }

            await sleep(160);
        }

        collectFileDiffsFromDom(collectedDiffs);
    }

    async function navigateFileTreeAndCollect(collectedDiffs, options = {}) {
        const { onProgress, expectedCount = 0, filePathsFromDiffstat = null } = options;
        const treeLinks = getFileTreeNavTargets(filePathsFromDiffstat);
        const total = treeLinks.length || expectedCount;

        if (treeLinks.length === 0) {
            return;
        }

        for (let index = 0; index < treeLinks.length; index += 1) {
            const linkElement = treeLinks[index];

            onProgress?.({
                phase: "tree",
                fileCount: collectedDiffs.size,
                expectedCount: total,
                message: `Navigating file ${index + 1}/${treeLinks.length}…`
            });

            clickLazyLoadDiffButtons();
            expandCollapsedFileDiffs();

            try {
                linkElement.scrollIntoView({ block: "center", behavior: "auto" });
                linkElement.click();
            } catch {
                // ignore navigation failures
            }

            await sleep(400);
            clickLazyLoadDiffButtons();
            expandCollapsedFileDiffs();
            collectFileDiffsFromDom(collectedDiffs);
            await scrollThroughVisibleFiles(collectedDiffs, 12);
        }
    }

    async function scrollAndCollectAllDiffs(options = {}) {
        const { onProgress, filePathsFromDiffstat = null } = options;
        const savedScrollY = globalThis.scrollY;
        const collectedDiffs = new Map();
        const expectedCount = filePathsFromDiffstat?.length || getExpectedFileCount();

        const reportProgress = (phase, message) => {
            onProgress?.({
                phase,
                fileCount: collectedDiffs.size,
                expectedCount,
                message
            });
        };

        try {
            reportProgress("scroll", "Starting scroll collection…");
            globalThis.scrollTo({ top: 0, behavior: "auto" });
            await sleep(250);

            clickLazyLoadDiffButtons();
            expandCollapsedFileDiffs();
            collectFileDiffsFromDom(collectedDiffs);

            await navigateFileTreeAndCollect(collectedDiffs, {
                onProgress,
                expectedCount,
                filePathsFromDiffstat
            });

            const scrollTargets = findDiffScrollTargets();
            const scrollStep = Math.max(300, Math.floor(globalThis.innerHeight * 0.65));
            let previousSize = collectedDiffs.size;
            let stableRounds = 0;

            globalThis.scrollTo({ top: 0, behavior: "auto" });
            await sleep(200);

            for (let iteration = 0; iteration < 800 && stableRounds < 12; iteration += 1) {
                clickLazyLoadDiffButtons();
                expandCollapsedFileDiffs();
                collectFileDiffsFromDom(collectedDiffs);

                const currentSize = collectedDiffs.size;

                reportProgress(
                    "scroll",
                    expectedCount > 0
                        ? `Scrolling… collected ${currentSize}/${expectedCount}`
                        : `Scrolling… collected ${currentSize} file(s)`
                );

                if (currentSize === previousSize) {
                    stableRounds += 1;
                } else {
                    stableRounds = 0;
                    previousSize = currentSize;
                }

                if (expectedCount > 0 && currentSize >= expectedCount && stableRounds >= 3) {
                    break;
                }

                const atBottom = isScrollAtBottom(scrollTargets);
                const moved = scrollDiffViewportDown(scrollTargets, scrollStep);

                if (atBottom && !moved && stableRounds >= 6) {
                    break;
                }

                await sleep(280);
            }

            clickLazyLoadDiffButtons();
            expandCollapsedFileDiffs();
            await sleep(400);
            collectFileDiffsFromDom(collectedDiffs);
            await scrollThroughVisibleFiles(collectedDiffs, 8);

            if (collectedDiffs.size === 0) {
                throw new Error("No visible Bitbucket diff lines were found. Expand the diff files first, then retry.");
            }

            const collectedPaths = new Set(collectedDiffs.keys());
            const missingFiles = filePathsFromDiffstat
                ? filePathsFromDiffstat.filter((filePath) => !collectedPaths.has(filePath))
                : [];

            reportProgress(
                "done",
                expectedCount > 0
                    ? `Collected ${collectedDiffs.size}/${expectedCount} files`
                    : `Collected ${collectedDiffs.size} files`
            );

            const orderedDiffs = filePathsFromDiffstat && filePathsFromDiffstat.length > 0
                ? filePathsFromDiffstat
                    .filter((filePath) => collectedDiffs.has(filePath))
                    .map((filePath) => collectedDiffs.get(filePath))
                : Array.from(collectedDiffs.values());

            return {
                text: orderedDiffs.join("\n\n"),
                fileCount: collectedDiffs.size,
                expectedCount,
                missingFiles
            };
        } finally {
            globalThis.scrollTo({ top: savedScrollY, behavior: "auto" });
        }
    }

    const countDiffLines = BbDiffEnhancer.countDiffLines;

    function buildDiffResult(partial) {
        const lineCounts = countDiffLines(partial.text || "");

        return {
            text: partial.text || "",
            source: partial.source || "DOM scroll",
            fileCount: partial.fileCount ?? 0,
            expectedCount: partial.expectedCount ?? 0,
            missingFiles: partial.missingFiles || [],
            isFallback: partial.isFallback ?? false,
            fallbackReason: partial.fallbackReason || "",
            addedLines: lineCounts.added,
            removedLines: lineCounts.removed
        };
    }

    async function extractFullDiff(onProgress) {
        const pageInfo = parsePullRequestUrl();
        let apiError = null;
        let diffstatPaths = null;

        if (pageInfo?.type === "pullrequest") {
            try {
                const metadata = await fetchPullRequestMetadata(pageInfo);
                const diffstat = await fetchPullRequestDiffstat(pageInfo);

                diffstatPaths = diffstat.map(getDiffstatFilePath).filter(Boolean);
            } catch {
                // diffstat is optional for scroll fallback
            }
        }

        if (pageInfo) {
            try {
                const apiResult = await fetchFullPullRequestDiffFromApi(pageInfo);

                if (typeof apiResult === "string") {
                    const fileCount = (apiResult.match(/^diff --git /gm) || []).length;

                    return buildDiffResult({
                        text: apiResult,
                        source: "API",
                        fileCount,
                        expectedCount: diffstatPaths?.length || fileCount,
                        isFallback: false
                    });
                }

                return buildDiffResult({
                    text: apiResult.text,
                    source: apiResult.source || "API per-file",
                    fileCount: apiResult.fileCount,
                    expectedCount: apiResult.expectedCount,
                    missingFiles: apiResult.missingFiles,
                    isFallback: apiResult.missingFiles?.length > 0,
                    fallbackReason: apiResult.missingFiles?.length > 0
                        ? `${apiResult.missingFiles.length} file(s) could not be fetched via per-file API`
                        : ""
                });
            } catch (error) {
                apiError = error instanceof Error ? error : new Error(String(error));
            }
        }

        let domText;
        let fileCount = 0;
        let expectedCount = 0;
        let missingFiles = [];

        try {
            const scrollResult = await scrollAndCollectAllDiffs({
                onProgress,
                filePathsFromDiffstat: diffstatPaths
            });

            domText = scrollResult.text;
            fileCount = scrollResult.fileCount;
            expectedCount = scrollResult.expectedCount || diffstatPaths?.length || 0;
            missingFiles = scrollResult.missingFiles || [];
        } catch (domError) {
            if (!pageInfo) {
                throw new Error(
                    "Current page URL is not a recognized Bitbucket pull request or branch compare URL, " +
                    "and no rendered diff content was found on the page."
                );
            }

            throw domError;
        }

        let fallbackReason;

        if (!pageInfo) {
            fallbackReason =
                "Current page URL is not a recognized Bitbucket pull request or branch compare URL. " +
                `Showing ${fileCount} rendered file(s) collected while scrolling the page.`;
        } else {
            const countMessage = expectedCount > 0 && fileCount < expectedCount
                ? `Collected ${fileCount} of ${expectedCount} changed file(s) while scrolling; some files may still be missing.`
                : `Collected ${fileCount} rendered file(s) while scrolling the page.`;

            fallbackReason =
                `API unavailable (${apiError?.message || "unknown error"}). ${countMessage}`;
        }

        if (missingFiles.length === 0 && diffstatPaths?.length > 0 && fileCount < diffstatPaths.length) {
            const collectedSet = new Set();

            for (const diffBlock of domText.split("\n\n")) {
                const match = diffBlock.match(/^diff --git a\/(.+?) b\//m);

                if (match) {
                    collectedSet.add(match[1]);
                }
            }

            missingFiles = diffstatPaths.filter((filePath) => !collectedSet.has(filePath));
        }

        return buildDiffResult({
            text: domText,
            source: "DOM scroll",
            fileCount,
            expectedCount,
            missingFiles,
            isFallback: true,
            fallbackReason
        });
    }

    async function withButtonLoading(button, task, options = {}) {
        const { progressContainer } = options;
        const originalLabel = button.textContent;
        const siblingButtons = progressContainer
            ? Array.from(progressContainer.querySelectorAll("button"))
            : [button];

        let progressBar = null;
        let progressFill = null;

        if (progressContainer) {
            progressBar = document.createElement("div");
            progressBar.style.width = "100%";
            progressBar.style.height = "3px";
            progressBar.style.background = "#dfe1e6";
            progressBar.style.borderRadius = "2px";
            progressBar.style.overflow = "hidden";
            progressBar.style.marginTop = "4px";

            progressFill = document.createElement("div");
            progressFill.style.height = "100%";
            progressFill.style.width = "0%";
            progressFill.style.background = "#0c66e4";
            progressFill.style.transition = "width 0.2s ease";
            progressBar.appendChild(progressFill);
            progressContainer.appendChild(progressBar);
        }

        const setLoadingLabel = (label) => {
            button.textContent = label;
        };

        for (const siblingButton of siblingButtons) {
            siblingButton.disabled = true;
            siblingButton.style.opacity = "0.7";
            siblingButton.style.cursor = "wait";
        }

        setLoadingLabel("Loading...");

        const onProgress = ({ fileCount, expectedCount, message }) => {
            if (expectedCount > 0) {
                setLoadingLabel(`Loading ${fileCount}/${expectedCount}…`);

                if (progressFill) {
                    const percent = Math.min(100, Math.round((fileCount / expectedCount) * 100));
                    progressFill.style.width = `${percent}%`;
                }
            } else if (message) {
                setLoadingLabel(message.replace(/…$/, "").slice(0, 40));
            }
        };

        try {
            return await task(onProgress);
        } finally {
            for (const siblingButton of siblingButtons) {
                siblingButton.disabled = false;
                siblingButton.style.opacity = "";
                siblingButton.style.cursor = "pointer";
            }

            button.textContent = originalLabel;
            progressBar?.remove();
        }
    }

    function buildFullDiffModalTitle(result) {
        if (!result.isFallback) {
            return "Readable Bitbucket Diff";
        }

        return `Readable Bitbucket Diff (${result.fallbackReason})`;
    }

    const filterDiffByFilename = BbDiffEnhancer.filterDiffByFilename;

    async function copyToClipboard(text) {
        if (typeof GM_setClipboard === "function") {
            GM_setClipboard(text, "text");
            return;
        }

        await navigator.clipboard.writeText(text);
    }

    function downloadText(filename, text) {
        const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");

        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();

        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    const safeFileName = BbDiffEnhancer.safeFileName;

    function stopHeaderToggle(event) {
        event.preventDefault();
        event.stopPropagation();
    }

    function createButton(label, onClick, options = {}) {
    const button = document.createElement("button");

    button.type = "button";
    button.textContent = label;
    button.title = options.title || label;

    button.style.height = options.compact ? "28px" : "32px";
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.justifyContent = "center";
    button.style.border = "1px solid #0c66e4";
    button.style.background = "#0c66e4";
    button.style.color = "#ffffff";
    button.style.borderRadius = "6px";
    button.style.padding = options.compact ? "0 10px" : "0 12px";
    button.style.cursor = "pointer";
    button.style.fontSize = options.compact ? "12px" : "13px";
    button.style.fontWeight = "600";
    button.style.fontFamily = "Arial, sans-serif";
    button.style.lineHeight = "1";
    button.style.whiteSpace = "nowrap";
    button.style.boxShadow = "0 1px 2px rgba(9, 30, 66, 0.18)";

    button.addEventListener("mousedown", stopHeaderToggle);
    button.addEventListener("pointerdown", stopHeaderToggle);
    button.addEventListener("click", async (event) => {
        stopHeaderToggle(event);

        try {
            await onClick(event);
        } catch (error) {
            showError(error);
        }
    });

    button.addEventListener("mouseenter", () => {
        button.style.background = "#0055cc";
        button.style.borderColor = "#0055cc";
    });

    button.addEventListener("mouseleave", () => {
        button.style.background = "#0c66e4";
        button.style.borderColor = "#0c66e4";
    });

    return button;
}

    function createIconButton(svgMarkup, title, onClick) {
        const button = document.createElement("button");

        button.type = "button";
        button.title = title;
        button.setAttribute("aria-label", title);
        button.innerHTML = svgMarkup;

        button.style.height = "28px";
        button.style.minWidth = "28px";
        button.style.display = "inline-flex";
        button.style.alignItems = "center";
        button.style.justifyContent = "center";
        button.style.border = "1px solid #0c66e4";
        button.style.background = "#0c66e4";
        button.style.color = "#ffffff";
        button.style.borderRadius = "6px";
        button.style.padding = "0";
        button.style.cursor = "pointer";
        button.style.lineHeight = "1";
        button.style.boxShadow = "0 1px 2px rgba(9, 30, 66, 0.18)";

        button.addEventListener("mousedown", stopHeaderToggle);
        button.addEventListener("pointerdown", stopHeaderToggle);
        button.addEventListener("click", (event) => {
            stopHeaderToggle(event);

            try {
                onClick(event);
            } catch (error) {
                showError(error);
            }
        });

        button.addEventListener("mouseenter", () => {
            button.style.background = "#0055cc";
            button.style.borderColor = "#0055cc";
        });

        button.addEventListener("mouseleave", () => {
            button.style.background = "#0c66e4";
            button.style.borderColor = "#0c66e4";
        });

        return button;
    }

    const GEAR_ICON_SVG =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="display:block;">' +
        '<path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.06-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84a.49.49 0 0 0-.48.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.488.488 0 0 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.3-.06.62-.06.94s.02.64.06.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.37 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.57 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.61l-2.03-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z"/>' +
        '</svg>';

    const CODE_ICON_SVG =
        '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" style="display:block;">' +
        '<path d="M9.4 16.6 4.8 12l4.6-4.6L8 6l-6 6 6 6zm5.2 0 4.6-4.6-4.6-4.6L16 6l6 6-6 6z"/>' +
        '</svg>';

    function closeModal() {
        for (const modalId of [ids.modal, ids.settingsModal]) {
            const modal = document.getElementById(modalId);

            if (modal) {
                modal.remove();
            }
        }
    }

    function showModal(titleText, text, downloadFileName, metadata = {}) {
        closeModal();

        const theme = getTheme();

        const overlay = document.createElement("div");
        overlay.id = ids.modal;
        overlay.style.position = "fixed";
        overlay.style.inset = "0";
        overlay.style.zIndex = "2147483647";
        overlay.style.background = theme.overlay;
        overlay.style.display = "flex";
        overlay.style.alignItems = "center";
        overlay.style.justifyContent = "center";

        const panel = document.createElement("div");
        panel.style.width = "min(1200px, calc(100vw - 48px))";
        panel.style.height = "min(800px, calc(100vh - 48px))";
        panel.style.background = theme.panelBg;
        panel.style.borderRadius = "8px";
        panel.style.boxShadow = "0 12px 32px rgba(9, 30, 66, 0.31)";
        panel.style.display = "flex";
        panel.style.flexDirection = "column";
        panel.style.overflow = "hidden";

        const header = document.createElement("div");
        header.style.display = "flex";
        header.style.alignItems = "center";
        header.style.justifyContent = "space-between";
        header.style.gap = "8px";
        header.style.padding = "10px 12px";
        header.style.borderBottom = "1px solid " + theme.border;

        const titleArea = document.createElement("div");
        titleArea.style.display = "flex";
        titleArea.style.flexDirection = "column";
        titleArea.style.gap = "4px";
        titleArea.style.minWidth = "0";
        titleArea.style.flex = "1";

        const titleRow = document.createElement("div");
        titleRow.style.display = "flex";
        titleRow.style.alignItems = "center";
        titleRow.style.gap = "8px";
        titleRow.style.minWidth = "0";

        const title = document.createElement("div");
        title.textContent = titleText;
        title.style.fontSize = "14px";
        title.style.fontWeight = "700";
        title.style.color = theme.text;
        title.style.overflow = "hidden";
        title.style.textOverflow = "ellipsis";
        title.style.whiteSpace = "nowrap";

        titleRow.appendChild(title);

        if (metadata.source) {
            const badge = document.createElement("span");
            badge.textContent = metadata.source;
            badge.style.fontSize = "11px";
            badge.style.fontWeight = "600";
            badge.style.padding = "2px 8px";
            badge.style.borderRadius = "4px";
            badge.style.flexShrink = "0";
            badge.style.background = metadata.source === "DOM scroll" ? "#fff0b3" : "#e3fcef";
            badge.style.color = "#172b4d";
            titleRow.appendChild(badge);
        }

        titleArea.appendChild(titleRow);

        const metaParts = [];

        if (metadata.fileCount != null) {
            const countLabel = metadata.expectedCount > 0 && metadata.fileCount < metadata.expectedCount
                ? `${metadata.fileCount}/${metadata.expectedCount} files`
                : `${metadata.fileCount} file(s)`;

            metaParts.push(countLabel);
        }

        if (metadata.addedLines != null || metadata.removedLines != null) {
            metaParts.push(`+${metadata.addedLines || 0} / -${metadata.removedLines || 0} lines`);
        }

        if (metaParts.length > 0) {
            const metaLine = document.createElement("div");
            metaLine.textContent = metaParts.join(" · ");
            metaLine.style.fontSize = "12px";
            metaLine.style.color = theme.muted;
            titleArea.appendChild(metaLine);
        }

        if (metadata.missingFiles?.length > 0) {
            const missingLine = document.createElement("div");
            missingLine.textContent = `Missing: ${metadata.missingFiles.slice(0, 5).join(", ")}${metadata.missingFiles.length > 5 ? ` (+${metadata.missingFiles.length - 5} more)` : ""}`;
            missingLine.style.fontSize = "11px";
            missingLine.style.color = "#de350b";
            missingLine.style.overflow = "hidden";
            missingLine.style.textOverflow = "ellipsis";
            missingLine.style.whiteSpace = "nowrap";
            titleArea.appendChild(missingLine);
        }

        const actions = document.createElement("div");
        actions.style.display = "flex";
        actions.style.gap = "8px";
        actions.style.flexShrink = "0";

        const toolbar = document.createElement("div");
        toolbar.style.display = "flex";
        toolbar.style.alignItems = "center";
        toolbar.style.gap = "8px";
        toolbar.style.padding = "8px 12px";
        toolbar.style.borderBottom = "1px solid " + theme.border;
        toolbar.style.background = theme.toolbarBg;

        const filterInput = document.createElement("input");
        filterInput.type = "search";
        filterInput.placeholder = "Filter by filename…";
        filterInput.style.flex = "1";
        filterInput.style.height = "28px";
        filterInput.style.padding = "0 8px";
        filterInput.style.border = "1px solid " + theme.border;
        filterInput.style.borderRadius = "4px";
        filterInput.style.fontSize = "12px";
        filterInput.style.background = theme.inputBg;
        filterInput.style.color = theme.text;

        let currentText = text;

        const viewer = document.createElement("div");
        viewer.style.flex = "1";
        viewer.style.overflow = "auto";
        viewer.style.background = theme.panelBg;
        viewer.style.padding = "12px";

        const pre = document.createElement("pre");
        pre.style.margin = "0";
        pre.style.fontFamily = getCodeFont();
        pre.style.fontSize = "12px";
        pre.style.lineHeight = "1.45";
        pre.style.whiteSpace = "pre";

        viewer.appendChild(pre);

        const renderViewer = () => {
            pre.innerHTML = "";
            const palette = getTheme().diff;

            for (const line of currentText.split("\n")) {
                const kind = BbDiffEnhancer.classifyDiffLine(line);
                const span = document.createElement("span");
                span.textContent = line;
                span.style.color = palette[kind] || palette.context;

                if (kind === "add") {
                    span.style.background = "rgba(0, 135, 90, 0.08)";
                } else if (kind === "remove") {
                    span.style.background = "rgba(222, 53, 11, 0.08)";
                }

                pre.appendChild(span);
                pre.appendChild(document.createTextNode("\n"));
            }
        };

        renderViewer();

        const getFilteredText = () => filterDiffByFilename(text, filterInput.value);

        filterInput.addEventListener("input", () => {
            currentText = getFilteredText();
            renderViewer();
        });

        toolbar.appendChild(filterInput);

        actions.appendChild(createButton("Copy", async () => {
            await copyToClipboard(currentText);
        }));

        actions.appendChild(createButton("Copy filtered", async () => {
            await copyToClipboard(getFilteredText());
        }, { compact: true, title: "Copy filtered diff" }));

        actions.appendChild(createButton("Download", () => {
            downloadText(downloadFileName, currentText);
        }));

        actions.appendChild(createButton("Download filtered", () => {
            const suffix = filterInput.value.trim()
                ? `-filtered-${safeFileName(filterInput.value.trim())}`
                : "";

            downloadText(downloadFileName.replace(/\.diff$/, `${suffix}.diff`), getFilteredText());
        }, { compact: true, title: "Download filtered diff" }));

        actions.appendChild(createButton("Close", closeModal));

        header.appendChild(titleArea);
        header.appendChild(actions);

        panel.appendChild(header);
        panel.appendChild(toolbar);
        panel.appendChild(viewer);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                closeModal();
            }
        });
    }

    function showToast(message, type = "info") {
        const toastId = "bb-readable-diff-toast";
        let toast = document.getElementById(toastId);

        if (!toast) {
            toast = document.createElement("div");
            toast.id = toastId;
            toast.style.position = "fixed";
            toast.style.bottom = "24px";
            toast.style.right = "24px";
            toast.style.zIndex = "2147483646";
            toast.style.maxWidth = "420px";
            toast.style.padding = "12px 16px";
            toast.style.borderRadius = "6px";
            toast.style.fontSize = "13px";
            toast.style.fontFamily = "Arial, sans-serif";
            toast.style.lineHeight = "1.4";
            toast.style.boxShadow = "0 4px 12px rgba(9, 30, 66, 0.25)";
            toast.style.transition = "opacity 0.3s ease";
            document.body.appendChild(toast);
        }

        const theme = getTheme();
        const colors = {
            info: { bg: theme.toastBg, color: theme.toastColor },
            warning: { bg: "#ff991f", color: "#172b4d" },
            error: { bg: "#de350b", color: "#ffffff" }
        };

        const palette = colors[type] || colors.info;

        toast.style.background = palette.bg;
        toast.style.color = palette.color;
        toast.style.opacity = "1";
        toast.textContent = message;

        if (toast._dismissTimer) {
            globalThis.clearTimeout(toast._dismissTimer);
        }

        toast._dismissTimer = globalThis.setTimeout(() => {
            toast.style.opacity = "0";
        }, 5000);
    }

    function showError(error) {
        const message = error instanceof Error ? error.message : String(error);
        showToast(message, "error");
    }

    const commentFilter = {
        storageKeyAuthors: "bb-readable-diff-blocked-authors",
        storageKeyEnabled: "bb-readable-diff-hide-comments-enabled",
        storageKeyResolved: "bb-readable-diff-hide-resolved-enabled",
        storageKeyNotifications: "bb-readable-diff-show-notifications",
        defaultAuthors: ["DSO-PR-Bot"],
        processedAttribute: "data-bb-comment-filtered",
        reasonAuthor: "author",
        reasonResolved: "resolved"
    };

    function getStoredJson(key, fallback) {
        if (typeof GM_getValue !== "function") {
            return fallback;
        }

        const value = GM_getValue(key, null);

        return value == null ? fallback : value;
    }

    function setStoredJson(key, value) {
        if (typeof GM_setValue === "function") {
            GM_setValue(key, value);
        }
    }

    function getBlockedAuthors() {
        const stored = getStoredJson(commentFilter.storageKeyAuthors, null);

        if (!Array.isArray(stored)) {
            return commentFilter.defaultAuthors.slice();
        }

        return stored
            .map((name) => normalizeWhitespace(name).trim())
            .filter(Boolean);
    }

    function setBlockedAuthors(authors) {
        const cleaned = Array.from(new Set(
            authors
                .map((name) => normalizeWhitespace(name).trim())
                .filter(Boolean)
        ));

        setStoredJson(commentFilter.storageKeyAuthors, cleaned);
    }

    function isCommentFilterEnabled() {
        return getStoredJson(commentFilter.storageKeyEnabled, true) !== false;
    }

    function setCommentFilterEnabled(enabled) {
        setStoredJson(commentFilter.storageKeyEnabled, Boolean(enabled));
    }

    function isHideResolvedEnabled() {
        return getStoredJson(commentFilter.storageKeyResolved, false) === true;
    }

    function setHideResolvedEnabled(enabled) {
        setStoredJson(commentFilter.storageKeyResolved, Boolean(enabled));
    }

    function isNotificationsEnabled() {
        return getStoredJson(commentFilter.storageKeyNotifications, true) !== false;
    }

    function setNotificationsEnabled(enabled) {
        setStoredJson(commentFilter.storageKeyNotifications, Boolean(enabled));
    }

    const SETTINGS_KEYS = [
        commentFilter.storageKeyAuthors,
        commentFilter.storageKeyEnabled,
        commentFilter.storageKeyResolved,
        commentFilter.storageKeyNotifications,
        SETTINGS_LOCAL_REPO_ROOT,
        SETTINGS_THEME,
        SETTINGS_CODE_FONT,
        SETTINGS_EXTERNAL_TOOLS
    ];

    function getLocalRepoRoot() {
        return getStoredJson(SETTINGS_LOCAL_REPO_ROOT, "") || "";
    }

    function setLocalRepoRoot(root) {
        setStoredJson(SETTINGS_LOCAL_REPO_ROOT, root);
    }

    function getCodeFont() {
        return getStoredJson(SETTINGS_CODE_FONT, FONT_OPTIONS[0].value) || FONT_OPTIONS[0].value;
    }

    function setCodeFont(font) {
        setStoredJson(SETTINGS_CODE_FONT, font);
    }

    function getThemePreference() {
        return getStoredJson(SETTINGS_THEME, "auto") || "auto";
    }

    function setThemePreference(preference) {
        setStoredJson(SETTINGS_THEME, preference);
    }

    function getExternalTools() {
        const stored = getStoredJson(SETTINGS_EXTERNAL_TOOLS, null);

        if (!Array.isArray(stored) || stored.length === 0) {
            return DEFAULT_EXTERNAL_TOOLS.slice();
        }

        return stored
            .filter((tool) => tool && tool.name && tool.template)
            .map((tool) => ({ name: tool.name, template: tool.template }));
    }

    function setExternalTools(tools) {
        setStoredJson(SETTINGS_EXTERNAL_TOOLS, tools);
    }

    function buildExternalUrl(template, filePath) {
        const root = getLocalRepoRoot().replace(/\/+$/, "");
        const relative = String(filePath || "").replace(/^\/+/, "");
        const absolute = root ? root + "/" + relative : relative;

        const pageInfo = parsePullRequestUrl();
        const repoSlug = pageInfo ? pageInfo.workspace + "/" + pageInfo.repoSlug : "";

        return String(template || "")
            .replace(/\{path\}/g, absolute)
            .replace(/\{repo\}/g, root)
            .replace(/\{file\}/g, relative)
            .replace(/\{repoSlug\}/g, repoSlug);
    }

    function openExternalTool(template, filePath) {
        const root = getLocalRepoRoot().replace(/\/+$/, "");

        if (!root) {
            showToast("Set your local repository path in the comment filter settings first.", "warning");
            return;
        }

        const url = buildExternalUrl(template, filePath);

        if (!url) {
            showToast("Invalid external tool URL.", "error");
            return;
        }

        globalThis.location.href = url;
    }

    function exportSettings() {
        const data = {};

        for (const key of SETTINGS_KEYS) {
            data[key] = getStoredJson(key, null);
        }

        return JSON.stringify(data, null, 2);
    }

    function importSettings(json) {
        let parsed;

        try {
            parsed = JSON.parse(json);
        } catch {
            throw new Error("Invalid JSON.");
        }

        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("Settings must be a JSON object.");
        }

        for (const key of SETTINGS_KEYS) {
            if (Object.prototype.hasOwnProperty.call(parsed, key)) {
                setStoredJson(key, parsed[key]);
            }
        }
    }

    function getAuthorFromElement(element) {
        const triggers = element.querySelectorAll('[data-testid="profileCardTrigger"]');

        for (const trigger of triggers) {
            const ariaLabel = trigger.getAttribute("aria-label") || "";
            const match = ariaLabel.match(/^more information about (.+)$/i);

            if (match && match[1]) {
                return match[1].trim();
            }
        }

        const header = element.querySelector('[data-testid="comment-header"]');

        if (header) {
            const name = normalizeWhitespace(header.textContent)
                .split(/\s{2,}/)[0]
                .trim();

            if (name) {
                return name;
            }
        }

        return "";
    }

    function containsDiffCode(element) {
        return Boolean(
            element.querySelector(selectors.code) ||
            element.querySelector(selectors.row)
        );
    }

    function findCommentThreadContainer(commentElement) {
        const portal = commentElement.closest('[id^="portal-parent-"]')
            || commentElement.closest('[data-thread-controls-managed="true"]')
            || commentElement;

        const fileContainer = portal.closest('article[data-qa="branch-diff-file"]')
            || portal.closest(selectors.file);

        if (!fileContainer) {
            return portal;
        }

        // The portal only holds the portaled content; the visible "card" (with
        // its own border/background) is an ancestor of it. Climb up until we hit
        // a parent that actually contains diff code, then hide that card so no
        // empty box is left behind.
        let node = portal;
        let container = portal;

        while (node.parentElement && node.parentElement !== fileContainer) {
            node = node.parentElement;
            container = node;

            if (containsDiffCode(node.parentElement)) {
                break;
            }
        }

        return container;
    }

    function hideBlockedComments() {
        if (!isCommentFilterEnabled()) {
            return 0;
        }

        const blocked = getBlockedAuthors();

        if (blocked.length === 0) {
            return 0;
        }

        let hiddenCount = 0;

        for (const commentElement of document.querySelectorAll('[data-testid="comment"]')) {
            // Comments on the Overview page live inside a `pull-request-activity`
            // entry, which is removed wholesale by hideBlockedActivity().
            if (commentElement.closest('[data-qa="pull-request-activity"]')) {
                continue;
            }

            const container = findCommentThreadContainer(commentElement);

            if (!container || container.hasAttribute(commentFilter.processedAttribute)) {
                continue;
            }

            const author = getAuthorFromElement(commentElement);

            if (!BbDiffEnhancer.isAuthorBlocked(author, blocked)) {
                continue;
            }

            container.setAttribute(commentFilter.processedAttribute, commentFilter.reasonAuthor);
            container.setAttribute("aria-hidden", "true");
            container.style.display = "none";
            hiddenCount += 1;
        }

        return hiddenCount;
    }

    function hideBlockedActivity() {
        if (!isCommentFilterEnabled()) {
            return 0;
        }

        const blocked = getBlockedAuthors();

        if (blocked.length === 0) {
            return 0;
        }

        let hiddenCount = 0;

        for (const activityElement of document.querySelectorAll('[data-qa="pull-request-activity"]')) {
            if (activityElement.hasAttribute(commentFilter.processedAttribute)) {
                continue;
            }

            const author = getAuthorFromElement(activityElement);

            if (!BbDiffEnhancer.isAuthorBlocked(author, blocked)) {
                continue;
            }

            activityElement.setAttribute(commentFilter.processedAttribute, commentFilter.reasonAuthor);
            activityElement.setAttribute("aria-hidden", "true");
            activityElement.style.display = "none";
            hiddenCount += 1;
        }

        return hiddenCount;
    }

    function isResolvedThread(container) {
        return /resolved this (?:comment )?thread/i.test(normalizeWhitespace(container.textContent));
    }

    function hideResolvedComments() {
        if (!isHideResolvedEnabled()) {
            return 0;
        }

        let hiddenCount = 0;

        for (const commentElement of document.querySelectorAll('[data-testid="comment"]')) {
            // Resolved threads on the Overview page are handled by hideResolvedActivity().
            if (commentElement.closest('[data-qa="pull-request-activity"]')) {
                continue;
            }

            const container = findCommentThreadContainer(commentElement);

            if (!container || container.hasAttribute(commentFilter.processedAttribute)) {
                continue;
            }

            if (!isResolvedThread(container)) {
                continue;
            }

            container.setAttribute(commentFilter.processedAttribute, commentFilter.reasonResolved);
            container.setAttribute("aria-hidden", "true");
            container.style.display = "none";
            hiddenCount += 1;
        }

        return hiddenCount;
    }

    function hideResolvedActivity() {
        if (!isHideResolvedEnabled()) {
            return 0;
        }

        let hiddenCount = 0;

        for (const activityElement of document.querySelectorAll('[data-qa="pull-request-activity"]')) {
            if (activityElement.hasAttribute(commentFilter.processedAttribute)) {
                continue;
            }

            if (!isResolvedThread(activityElement)) {
                continue;
            }

            activityElement.setAttribute(commentFilter.processedAttribute, commentFilter.reasonResolved);
            activityElement.setAttribute("aria-hidden", "true");
            activityElement.style.display = "none";
            hiddenCount += 1;
        }

        return hiddenCount;
    }

    function restoreHiddenComments(reason) {
        const selector = `[${commentFilter.processedAttribute}]`;

        for (const container of document.querySelectorAll(selector)) {
            if (reason && container.getAttribute(commentFilter.processedAttribute) !== reason) {
                continue;
            }

            container.style.display = "";
            container.removeAttribute("aria-hidden");
            container.removeAttribute(commentFilter.processedAttribute);
        }
    }

    let lastCommentToastAt = 0;

    function notifyCommentsHidden(count) {
        if (!isNotificationsEnabled()) {
            return;
        }

        const now = Date.now();

        if (now - lastCommentToastAt < 8000) {
            return;
        }

        lastCommentToastAt = now;
        showToast(
            `Hidden ${count} comment thread${count === 1 ? "" : "s"}.`,
            "info"
        );
    }

    function openCommentFilterSettings() {
        closeModal();

        const theme = getTheme();

        const overlay = document.createElement("div");
        overlay.id = ids.settingsModal;
        overlay.style.position = "fixed";
        overlay.style.inset = "0";
        overlay.style.zIndex = "2147483647";
        overlay.style.background = theme.overlay;
        overlay.style.display = "flex";
        overlay.style.alignItems = "center";
        overlay.style.justifyContent = "center";

        const panel = document.createElement("div");
        panel.style.width = "min(520px, calc(100vw - 32px))";
        panel.style.background = theme.panelBg;
        panel.style.borderRadius = "8px";
        panel.style.boxShadow = "0 12px 32px rgba(9, 30, 66, 0.31)";
        panel.style.display = "flex";
        panel.style.flexDirection = "column";
        panel.style.overflow = "hidden";

        const header = document.createElement("div");
        header.style.display = "flex";
        header.style.alignItems = "center";
        header.style.justifyContent = "space-between";
        header.style.padding = "12px 16px";
        header.style.borderBottom = "1px solid " + theme.border;

        const title = document.createElement("div");
        title.textContent = "Comment filter settings";
        title.style.fontSize = "14px";
        title.style.fontWeight = "700";
        title.style.color = theme.text;

        header.appendChild(title);

        const headerActions = document.createElement("div");
        headerActions.style.display = "flex";
        headerActions.style.gap = "8px";

        headerActions.appendChild(createButton("Reset to defaults", () => {
            setBlockedAuthors(commentFilter.defaultAuthors.slice());
            setCommentFilterEnabled(true);
            setHideResolvedEnabled(false);
            setNotificationsEnabled(true);
            openCommentFilterSettings();
        }));

        headerActions.appendChild(createButton("Close", closeModal));
        header.appendChild(headerActions);

        const body = document.createElement("div");
        body.style.padding = "16px";
        body.style.display = "flex";
        body.style.flexDirection = "column";
        body.style.gap = "14px";

        const createToggleRow = (labelText, description, initialValue, onChange) => {
            const row = document.createElement("label");
            row.style.display = "flex";
            row.style.alignItems = "flex-start";
            row.style.gap = "8px";
            row.style.cursor = "pointer";

            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = initialValue;
            checkbox.style.marginTop = "1px";
            checkbox.style.flexShrink = "0";

            const textColumn = document.createElement("div");
            textColumn.style.display = "flex";
            textColumn.style.flexDirection = "column";
            textColumn.style.gap = "2px";

            const label = document.createElement("span");
            label.textContent = labelText;
            label.style.fontSize = "13px";
            label.style.color = theme.text;

            textColumn.appendChild(label);

            if (description) {
                const desc = document.createElement("span");
                desc.textContent = description;
                desc.style.fontSize = "12px";
                desc.style.color = theme.muted;
                textColumn.appendChild(desc);
            }

            row.appendChild(checkbox);
            row.appendChild(textColumn);

            checkbox.addEventListener("change", () => {
                onChange(checkbox.checked);
            });

            return row;
        };

        const authorToggleRow = createToggleRow(
            "Hide comments from blocked authors",
            "Hides inline comments from the blocked author patterns below.",
            isCommentFilterEnabled(),
            (checked) => {
                setCommentFilterEnabled(checked);

                if (!checked) {
                    restoreHiddenComments(commentFilter.reasonAuthor);
                }
            }
        );

        const resolvedToggleRow = createToggleRow(
            "Hide resolved comments",
            "Removes resolved comment threads from the diff view.",
            isHideResolvedEnabled(),
            (checked) => {
                setHideResolvedEnabled(checked);

                if (!checked) {
                    restoreHiddenComments(commentFilter.reasonResolved);
                }
            }
        );

        const notificationsToggleRow = createToggleRow(
            "Show hidden-comment notifications",
            "Displays a toast when comment threads are hidden.",
            isNotificationsEnabled(),
            (checked) => {
                setNotificationsEnabled(checked);
            }
        );

        const createSelectField = (labelText, options, selectedValue, onChange) => {
            const field = document.createElement("div");
            field.style.display = "flex";
            field.style.flexDirection = "column";
            field.style.gap = "4px";

            const label = document.createElement("div");
            label.textContent = labelText;
            label.style.fontSize = "12px";
            label.style.fontWeight = "700";
            label.style.color = theme.muted;
            label.style.textTransform = "uppercase";
            field.appendChild(label);

            const select = document.createElement("select");
            select.style.height = "30px";
            select.style.padding = "0 8px";
            select.style.border = "1px solid " + theme.border;
            select.style.borderRadius = "4px";
            select.style.fontSize = "13px";
            select.style.background = theme.inputBg;
            select.style.color = theme.text;

            for (const option of options) {
                const optionElement = document.createElement("option");
                optionElement.value = option.value;
                optionElement.textContent = option.label;

                if (option.value === selectedValue) {
                    optionElement.selected = true;
                }

                select.appendChild(optionElement);
            }

            select.addEventListener("change", () => {
                onChange(select.value);
            });

            field.appendChild(select);
            return field;
        };

        const themeSelectField = createSelectField(
            "Theme",
            [
                { label: "Auto", value: "auto" },
                { label: "Light", value: "light" },
                { label: "Dark", value: "dark" }
            ],
            getThemePreference(),
            (value) => setThemePreference(value)
        );

        const fontSelectField = createSelectField(
            "Diff viewer font",
            FONT_OPTIONS,
            getCodeFont(),
            (value) => setCodeFont(value)
        );

        const listLabel = document.createElement("div");
        listLabel.textContent = "Blocked authors";
        listLabel.style.fontSize = "12px";
        listLabel.style.fontWeight = "700";
        listLabel.style.color = theme.muted;
        listLabel.style.textTransform = "uppercase";

        const listHint = document.createElement("div");
        listHint.textContent = "Case-insensitive patterns. Use * for any characters and ? for a single character (e.g. *bot*).";
        listHint.style.fontSize = "12px";
        listHint.style.color = theme.muted;

        const list = document.createElement("div");
        list.style.display = "flex";
        list.style.flexDirection = "column";
        list.style.gap = "6px";
        list.style.maxHeight = "240px";
        list.style.overflowY = "auto";

        const renderList = () => {
            list.innerHTML = "";
            const authors = getBlockedAuthors();

            if (authors.length === 0) {
                const empty = document.createElement("div");
                empty.textContent = "No authors blocked yet.";
                empty.style.fontSize = "12px";
                empty.style.color = theme.muted;
                list.appendChild(empty);
                return;
            }

            for (const author of authors) {
                const row = document.createElement("div");
                row.style.display = "flex";
                row.style.alignItems = "center";
                row.style.justifyContent = "space-between";
                row.style.gap = "8px";
                row.style.padding = "6px 8px";
                row.style.background = theme.rowBg;
                row.style.borderRadius = "4px";

                const name = document.createElement("span");
                name.textContent = author;
                name.style.fontSize = "13px";
                name.style.color = theme.text;

                const removeButton = document.createElement("button");
                removeButton.type = "button";
                removeButton.textContent = "Remove";
                removeButton.style.fontSize = "12px";
                removeButton.style.cursor = "pointer";
                removeButton.style.border = "none";
                removeButton.style.background = "transparent";
                removeButton.style.color = "#de350b";

                removeButton.addEventListener("click", () => {
                    setBlockedAuthors(getBlockedAuthors().filter((item) => item !== author));
                    renderList();
                });

                row.appendChild(name);
                row.appendChild(removeButton);
                list.appendChild(row);
            }
        };

        renderList();

        const addRow = document.createElement("div");
        addRow.style.display = "flex";
        addRow.style.gap = "8px";

        const input = document.createElement("input");
        input.type = "text";
        input.placeholder = "Author pattern (e.g. DSO-PR-Bot or *bot*)";
        input.style.flex = "1";
        input.style.height = "30px";
        input.style.padding = "0 8px";
        input.style.border = "1px solid " + theme.border;
        input.style.borderRadius = "4px";
        input.style.fontSize = "13px";
        input.style.background = theme.inputBg;
        input.style.color = theme.text;

        const addButton = createButton("Add", () => {
            const value = input.value.trim();

            if (!value) {
                return;
            }

            const authors = getBlockedAuthors();

            if (!authors.includes(value)) {
                authors.push(value);
                setBlockedAuthors(authors);
                renderList();
            }

            input.value = "";
        }, { compact: true });

        addRow.appendChild(input);
        addRow.appendChild(addButton);

        input.addEventListener("keydown", (event) => {
            if (event.key === "Enter") {
                event.preventDefault();
                addButton.click();
            }
        });

        const repoRootLabel = document.createElement("div");
        repoRootLabel.textContent = "Local repository path";
        repoRootLabel.style.fontSize = "12px";
        repoRootLabel.style.fontWeight = "700";
        repoRootLabel.style.color = theme.muted;
        repoRootLabel.style.textTransform = "uppercase";

        const repoRootInput = document.createElement("input");
        repoRootInput.type = "text";
        repoRootInput.placeholder = "/absolute/path/to/your/local/repo";
        repoRootInput.value = getLocalRepoRoot();
        repoRootInput.style.width = "100%";
        repoRootInput.style.height = "30px";
        repoRootInput.style.padding = "0 8px";
        repoRootInput.style.border = "1px solid " + theme.border;
        repoRootInput.style.borderRadius = "4px";
        repoRootInput.style.fontSize = "13px";
        repoRootInput.style.background = theme.inputBg;
        repoRootInput.style.color = theme.text;

        repoRootInput.addEventListener("change", () => {
            setLocalRepoRoot(repoRootInput.value.trim());
        });

        const dataRow = document.createElement("div");
        dataRow.style.display = "flex";
        dataRow.style.gap = "8px";
        dataRow.style.alignItems = "flex-start";

        dataRow.appendChild(createButton("Export settings", () => {
            copyToClipboard(exportSettings());
            showToast("Settings copied to clipboard.", "info");
        }, { compact: true, title: "Copy all settings as JSON" }));

        const importArea = document.createElement("textarea");
        importArea.placeholder = "Paste exported settings JSON here…";
        importArea.style.width = "100%";
        importArea.style.height = "70px";
        importArea.style.display = "none";
        importArea.style.padding = "8px";
        importArea.style.border = "1px solid " + theme.border;
        importArea.style.borderRadius = "4px";
        importArea.style.fontSize = "12px";
        importArea.style.background = theme.inputBg;
        importArea.style.color = theme.text;
        importArea.style.resize = "vertical";

        const importApplyButton = createButton("Apply import", () => {
            try {
                importSettings(importArea.value);
                showToast("Settings imported.", "info");
                openCommentFilterSettings();
            } catch (error) {
                showError(error);
            }
        }, { compact: true });

        importApplyButton.style.display = "none";

        dataRow.appendChild(createButton("Import settings", () => {
            const show = importArea.style.display === "none";
            importArea.style.display = show ? "block" : "none";
            importApplyButton.style.display = show ? "inline-flex" : "none";

            if (show) {
                importArea.focus();
            }
        }, { compact: true, title: "Import settings from JSON" }));

        dataRow.appendChild(importApplyButton);

        body.appendChild(authorToggleRow);
        body.appendChild(resolvedToggleRow);
        body.appendChild(notificationsToggleRow);
        body.appendChild(themeSelectField);
        body.appendChild(fontSelectField);
        body.appendChild(listLabel);
        body.appendChild(listHint);
        body.appendChild(list);
        body.appendChild(addRow);
        body.appendChild(repoRootLabel);
        body.appendChild(repoRootInput);
        body.appendChild(dataRow);
        body.appendChild(importArea);

        panel.appendChild(header);
        panel.appendChild(body);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        overlay.addEventListener("click", (event) => {
            if (event.target === overlay) {
                closeModal();
            }
        });

        input.focus();
    }

    function findRequestChangesWrapper(stickyHeader) {
        const buttons = Array.from(stickyHeader.querySelectorAll("button"));

        const requestChangesButton = buttons.find((button) => {
            const ariaLabel = button.getAttribute("aria-label") || "";
            const text = button.textContent || "";

            return ariaLabel.toLowerCase().includes("changes requested") ||
                text.toLowerCase().includes("request changes");
        });

        if (!requestChangesButton) {
            return null;
        }

        return requestChangesButton.closest('div[role="presentation"]') || requestChangesButton;
    }

    function findToolbarInsertionPoint() {
        const approveButton = document.querySelector(
            'button[aria-label="Approve this pull request"]'
        );

        if (approveButton) {
            const wrapper = approveButton.closest('div[role="presentation"]');

            if (wrapper?.parentElement) {
                return wrapper;
            }
        }

        const actionsDropdown = document.querySelector(
            '[data-qa="pr-header-actions-drop-down-menu-styles"]'
        );

        if (actionsDropdown) {
            const outerGroup = actionsDropdown.closest('div[role="group"]');

            if (outerGroup?.parentElement) {
                return outerGroup;
            }

            if (actionsDropdown.parentElement) {
                return actionsDropdown;
            }
        }

        const possibleHeaders = [
            document.querySelector(selectors.stickyHeader),
            document.querySelector(selectors.prHeader),
            document.querySelector('[data-testid="compare-header"]'),
            document.querySelector("main h1")?.closest("div")
        ].filter(Boolean);

        for (const header of possibleHeaders) {
            const requestChangesWrapper = findRequestChangesWrapper(header);

            if (requestChangesWrapper?.parentElement) {
                return requestChangesWrapper;
            }
        }

        for (const header of possibleHeaders) {
            if (header.parentElement) {
                return header;
            }
        }

        return null;
    }

    function extractPrMetadataFromDom() {
        const pickText = (selectors) => {
            for (const selector of selectors) {
                const element = document.querySelector(selector);

                if (element && element.textContent.trim()) {
                    return normalizeWhitespace(element.textContent).trim();
                }
            }

            return "";
        };

        return {
            title: pickText(['[data-testid="pr-title"]', 'h1[data-testid="pull-request-title"]', "h1"]),
            author: "",
            sourceBranch: pickText(['[data-testid="source-branch-name"]', '[data-qa="source-branch-name"]']),
            destinationBranch: pickText(['[data-testid="destination-branch-name"]', '[data-qa="destination-branch-name"]']),
            description: ""
        };
    }

    async function getPrMetadata() {
        const pageInfo = parsePullRequestUrl();

        if (!pageInfo || pageInfo.type !== "pullrequest") {
            return {};
        }

        let metadata = null;

        try {
            metadata = await fetchPullRequestMetadata(pageInfo);
        } catch {
            metadata = null;
        }

        if (!metadata || !metadata.title) {
            metadata = extractPullRequestMetadataFromPage() || metadata;
        }

        const dom = extractPrMetadataFromDom();
        const resolved = metadata || {};

        return {
            title: resolved.title || dom.title || "",
            author: (resolved.author && (resolved.author.display_name || resolved.author.nickname)) || dom.author || "",
            sourceBranch: (resolved.source && resolved.source.branch && resolved.source.branch.name) || dom.sourceBranch || "",
            destinationBranch: (resolved.destination && resolved.destination.branch && resolved.destination.branch.name) || dom.destinationBranch || "",
            description: resolved.description || dom.description || ""
        };
    }

    async function getDiffstatTotals(pageInfo) {
        try {
            const diffstat = await fetchPullRequestDiffstat(pageInfo);

            return {
                files: diffstat.length,
                added: diffstat.reduce((sum, entry) => sum + (entry.lines_added || 0), 0),
                removed: diffstat.reduce((sum, entry) => sum + (entry.lines_removed || 0), 0)
            };
        } catch {
            return { files: 0, added: 0, removed: 0 };
        }
    }

    async function getPullRequestSummary() {
        const pageInfo = parsePullRequestUrl();

        if (!pageInfo || pageInfo.type !== "pullrequest") {
            throw new Error("This action works on a pull request page.");
        }

        const meta = await getPrMetadata();
        const totals = await getDiffstatTotals(pageInfo);
        const ticket = BbDiffEnhancer.extractJiraTicket(meta.title + " " + meta.sourceBranch);

        return BbDiffEnhancer.buildPullRequestSummary({
            title: meta.title,
            url: globalThis.location.href,
            author: meta.author,
            ticket,
            sourceBranch: meta.sourceBranch,
            destinationBranch: meta.destinationBranch,
            files: totals.files,
            added: totals.added,
            removed: totals.removed,
            description: meta.description
        });
    }

    async function getAiReviewPrompt() {
        const result = await extractFullDiff();
        const meta = await getPrMetadata();

        return BbDiffEnhancer.buildAiReviewPrompt({
            title: meta.title,
            sourceBranch: meta.sourceBranch,
            destinationBranch: meta.destinationBranch,
            diff: result.text
        });
    }

    async function getReviewTemplate(type) {
        const meta = await getPrMetadata();

        return BbDiffEnhancer.buildReviewTemplate({
            type,
            title: meta.title,
            url: globalThis.location.href
        });
    }

    const openMenus = [];

    function closeAllMenus() {
        while (openMenus.length > 0) {
            openMenus.pop().style.display = "none";
        }
    }

    document.addEventListener("click", (event) => {
        if (openMenus.length > 0 && !event.target.closest(".bbde-menu")) {
            closeAllMenus();
        }
    }, true);

    function createMenuButton(label, items, options = {}) {
        const theme = getTheme();

        const container = document.createElement("div");
        container.className = "bbde-menu";
        container.style.position = "relative";
        container.style.display = "inline-flex";

        const menu = document.createElement("div");
        menu.style.display = "none";
        menu.style.position = "absolute";
        menu.style.top = "calc(100% + 4px)";
        menu.style.right = "0";
        menu.style.minWidth = "240px";
        menu.style.background = theme.panelBg;
        menu.style.border = "1px solid " + theme.border;
        menu.style.borderRadius = "6px";
        menu.style.boxShadow = "0 8px 16px rgba(9, 30, 66, 0.25)";
        menu.style.zIndex = "2147483647";
        menu.style.padding = "4px";
        menu.style.overflow = "hidden";

        const toggleMenu = () => {
            const isOpen = menu.style.display !== "none";
            closeAllMenus();

            if (!isOpen) {
                menu.style.display = "block";
                openMenus.push(menu);
            }
        };

        const button = options.iconSvg
            ? createIconButton(options.iconSvg, options.title || label, toggleMenu)
            : createButton(label, toggleMenu, { compact: true, title: options.title || "More actions" });

        for (const item of items) {
            const itemButton = document.createElement("button");
            itemButton.type = "button";
            itemButton.textContent = item.label;
            itemButton.style.display = "block";
            itemButton.style.width = "100%";
            itemButton.style.textAlign = "left";
            itemButton.style.padding = "8px 12px";
            itemButton.style.background = "transparent";
            itemButton.style.border = "0";
            itemButton.style.cursor = "pointer";
            itemButton.style.fontSize = "13px";
            itemButton.style.fontFamily = "Arial, sans-serif";
            itemButton.style.color = theme.text;
            itemButton.style.borderRadius = "4px";

            itemButton.addEventListener("click", (event) => {
                stopHeaderToggle(event);
                closeAllMenus();

                try {
                    item.onClick(event);
                } catch (error) {
                    showError(error);
                }
            });

            itemButton.addEventListener("mouseenter", () => {
                itemButton.style.background = theme.rowBg;
            });

            itemButton.addEventListener("mouseleave", () => {
                itemButton.style.background = "transparent";
            });

            menu.appendChild(itemButton);
        }

        container.appendChild(button);
        container.appendChild(menu);

        return container;
    }

    function addPageToolbar() {
        if (!document.querySelector(selectors.file) && !parsePullRequestUrl()) {
            return;
        }

        const insertionPoint = findToolbarInsertionPoint();

        if (!insertionPoint?.parentElement) {
            return;
        }

        let group = document.getElementById(ids.pageToolbar);

        if (!group) {
            const wrapper = document.createElement("div");
            wrapper.id = ids.pageToolbar;
            wrapper.style.display = "inline-flex";
            wrapper.style.flexDirection = "column";
            wrapper.style.alignItems = "stretch";
            wrapper.style.marginRight = "8px";
            wrapper.style.flexShrink = "0";

            group = document.createElement("div");
            group.setAttribute("role", "presentation");
            group.style.display = "inline-flex";
            group.style.alignItems = "center";
            group.style.justifyContent = "center";
            group.style.gap = "6px";

            group.addEventListener("mousedown", stopHeaderToggle);
            group.addEventListener("pointerdown", stopHeaderToggle);
            group.addEventListener("click", stopHeaderToggle);

            group.appendChild(createButton("View full diff", async (event) => {
                await withButtonLoading(event.currentTarget, async (onProgress) => {
                    const result = await extractFullDiff(onProgress);
                    showModal(
                        buildFullDiffModalTitle(result),
                        result.text,
                        "bitbucket-readable.diff",
                        result
                    );

                    if (result.isFallback) {
                        showToast(result.fallbackReason, "warning");
                    }
                }, { progressContainer: wrapper });
            }, {
                compact: true,
                title: "View complete pull request diff from Bitbucket API"
            }));

            group.appendChild(createButton("Copy full diff", async (event) => {
                await withButtonLoading(event.currentTarget, async (onProgress) => {
                    const result = await extractFullDiff(onProgress);
                    await copyToClipboard(result.text);

                    if (result.isFallback) {
                        showToast(result.fallbackReason, "warning");
                    } else {
                        showToast("Full diff copied to clipboard");
                    }
                }, { progressContainer: wrapper });
            }, {
                compact: true,
                title: "Copy complete pull request diff from Bitbucket API"
            }));

            group.appendChild(createButton("Comment filter", () => {
                openCommentFilterSettings();
            }, {
                compact: true,
                title: "Configure which authors' comments to hide"
            }));

            group.appendChild(createMenuButton("More", [
                {
                    label: "Copy PR summary",
                    onClick: async () => {
                        const summary = await getPullRequestSummary();
                        await copyToClipboard(summary);
                        showToast("PR summary copied to clipboard.");
                    }
                },
                {
                    label: "Copy for AI review",
                    onClick: async () => {
                        showToast("Generating AI review prompt…", "info");
                        const prompt = await getAiReviewPrompt();
                        await copyToClipboard(prompt);
                        showToast("AI review prompt copied to clipboard.");
                    }
                },
                {
                    label: "Copy approval template",
                    onClick: async () => {
                        await copyToClipboard(await getReviewTemplate("approve"));
                        showToast("Approval template copied.");
                    }
                },
                {
                    label: "Copy changes-requested template",
                    onClick: async () => {
                        await copyToClipboard(await getReviewTemplate("changes"));
                        showToast("Changes-requested template copied.");
                    }
                }
            ].concat(
                getLocalRepoRoot()
                    ? getExternalTools().map((tool) => ({
                        label: "Open repository in " + tool.name,
                        onClick: () => openExternalTool(tool.template, "")
                    }))
                    : []
            )));

            wrapper.appendChild(group);
            insertionPoint.parentElement.insertBefore(wrapper, insertionPoint);
        }

        const wrapper = document.getElementById(ids.pageToolbar);

        if (wrapper && wrapper.nextElementSibling !== insertionPoint) {
            insertionPoint.parentElement.insertBefore(wrapper, insertionPoint);
        }
    }

    function addFileButtons(fileElement) {
        if (fileElement.getAttribute(attributes.fileButtonsAdded) === "true") {
            return;
        }

        const headerElement = fileElement.querySelector(selectors.fileHeader);
        const actionsElement = fileElement.querySelector(selectors.fileActions);

        if (!headerElement || !actionsElement) {
            return;
        }

        const filePath = getFilePath(fileElement);

        actionsElement.style.display = "flex";
        actionsElement.style.alignItems = "center";
        actionsElement.style.justifyContent = "flex-end";
        actionsElement.style.gap = "8px";
        actionsElement.style.marginLeft = "auto";

        const group = document.createElement("div");
        group.style.display = "inline-flex";
        group.style.alignItems = "center";
        group.style.justifyContent = "center";
        group.style.gap = "6px";
        group.style.marginRight = "8px";
        group.style.flexShrink = "0";
        group.style.height = "32px";

        group.addEventListener("mousedown", stopHeaderToggle);
        group.addEventListener("pointerdown", stopHeaderToggle);
        group.addEventListener("click", stopHeaderToggle);

        group.appendChild(createButton("View diff", () => {
            const diff = extractFileDiff(fileElement);
            showModal(filePath, diff, `${safeFileName(filePath)}.diff`);
        }, {
            compact: true,
            title: `View readable diff for ${filePath}`
        }));

        group.appendChild(createButton("Copy diff", async () => {
            await copyToClipboard(extractFileDiff(fileElement));
        }, {
            compact: true,
            title: `Copy readable diff for ${filePath}`
        }));

        group.appendChild(createIconButton(GEAR_ICON_SVG, "Comment filter settings", () => {
            openCommentFilterSettings();
        }));

        if (getLocalRepoRoot()) {
            const tools = getExternalTools().map((tool) => ({
                label: "Open in " + tool.name,
                onClick: () => openExternalTool(tool.template, filePath)
            }));

            group.appendChild(createMenuButton("", tools, {
                iconSvg: CODE_ICON_SVG,
                title: "Open file in external tool"
            }));
        }

        actionsElement.insertBefore(group, actionsElement.firstChild);
        fileElement.setAttribute(attributes.fileButtonsAdded, "true");
    }

    function addFileButtonsToVisibleFiles() {
        const fileElements = Array.from(document.querySelectorAll(selectors.file));

        for (const fileElement of fileElements) {
            addFileButtons(fileElement);
        }
    }

    function startCommentFiltering() {
        let scheduleTimer = null;

        const runCommentFilter = () => {
            const authorHidden = hideBlockedComments();
            const activityHidden = hideBlockedActivity();
            const resolvedHidden = hideResolvedComments();
            const resolvedActivityHidden = hideResolvedActivity();
            const hiddenCount = authorHidden + activityHidden + resolvedHidden + resolvedActivityHidden;

            if (hiddenCount > 0) {
                notifyCommentsHidden(hiddenCount);
            }
        };

        const schedule = () => {
            globalThis.clearTimeout(scheduleTimer);
            scheduleTimer = globalThis.setTimeout(runCommentFilter, 150);
        };

        runCommentFilter();

        const observer = new MutationObserver(schedule);

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        // Safety net: Bitbucket lazy-loads activity/diff content as you scroll,
        // and some mutations may slip past the debounced observer. Re-check on a
        // fixed interval so newly loaded content is always filtered.
        globalThis.setInterval(runCommentFilter, 1000);
    }

    function init() {
        let debounceTimer = null;

        const runInit = () => {
            addPageToolbar();
            addFileButtonsToVisibleFiles();
        };

        const debouncedInit = () => {
            globalThis.clearTimeout(debounceTimer);
            debounceTimer = globalThis.setTimeout(runInit, 100);
        };

        runInit();

        // Keep the observer (and the interval) running for the life of the page:
        // Bitbucket lazy-loads diff files as you scroll, so newly mounted files
        // must still get their buttons.
        const observer = new MutationObserver(debouncedInit);

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        globalThis.setInterval(runInit, 1500);

        globalThis.addEventListener("popstate", debouncedInit);

        const originalPushState = history.pushState.bind(history);
        const originalReplaceState = history.replaceState.bind(history);

        history.pushState = (...args) => {
            originalPushState(...args);
            debouncedInit();
        };

        history.replaceState = (...args) => {
            originalReplaceState(...args);
            debouncedInit();
        };
    }

    loadStoredSettings().then(() => {
        init();
        startCommentFiltering();
    });
})();