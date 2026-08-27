// ==UserScript==
// @name         Bitbucket Readable Diff Extractor
// @namespace    https://bitbucket.org/
// @version      1.6.1
// @description  Extract Bitbucket Cloud PR diffs as readable unified-diff text, with per-file buttons, API full-diff support, and the ability to hide PR comments from configured authors (e.g. bots).
// @match        https://bitbucket.org/*
// @connect      api.bitbucket.org
// @connect      bitbucket.org
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// ==/UserScript==

(function () {
    "use strict";

    const DEBUG = false;

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

    function normalizeWhitespace(value) {
        return String(value || "").replace(/\u00a0/g, " ");
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
            const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
            const timeoutMs = 120000;

            const timer = globalThis.setTimeout(() => {
                document.removeEventListener(PAGE_FETCH_EVENT, handler);
                reject(new Error("Page fetch timed out"));
            }, timeoutMs);

            const handler = (event) => {
                const detail = event.detail;

                if (!detail || detail.requestId !== requestId) {
                    return;
                }

                globalThis.clearTimeout(timer);
                document.removeEventListener(PAGE_FETCH_EVENT, handler);

                if (detail.error) {
                    reject(new Error(detail.error));
                    return;
                }

                if (detail.status < 200 || detail.status >= 300) {
                    reject(new Error(`HTTP ${detail.status} ${detail.statusText || ""}`.trim()));
                    return;
                }

                resolve({
                    status: detail.status,
                    statusText: detail.statusText || "",
                    text: detail.text || "",
                    responseUrl: detail.responseUrl || url
                });
            };

            document.addEventListener(PAGE_FETCH_EVENT, handler);

            const script = document.createElement("script");
            script.textContent = `(async function () {
                const requestId = ${JSON.stringify(requestId)};
                const eventName = ${JSON.stringify(PAGE_FETCH_EVENT)};

                try {
                    const response = await fetch(${JSON.stringify(url)}, {
                        credentials: "include",
                        redirect: "follow",
                        headers: {
                            Accept: ${JSON.stringify(accept)}
                        }
                    });
                    const text = await response.text();

                    document.dispatchEvent(new CustomEvent(eventName, {
                        detail: {
                            requestId: requestId,
                            status: response.status,
                            statusText: response.statusText,
                            text: text,
                            responseUrl: response.url
                        }
                    }));
                } catch (error) {
                    document.dispatchEvent(new CustomEvent(eventName, {
                        detail: {
                            requestId: requestId,
                            error: error && error.message ? error.message : String(error)
                        }
                    }));
                }
            })();`;

            (document.documentElement || document.head || document.body).appendChild(script);
            script.remove();
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

    function countDiffLines(text) {
        let added = 0;
        let removed = 0;

        for (const line of text.split("\n")) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
                added += 1;
            } else if (line.startsWith("-") && !line.startsWith("---")) {
                removed += 1;
            }
        }

        return { added, removed };
    }

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

    function filterDiffByFilename(fullText, filterQuery) {
        const query = filterQuery.trim().toLowerCase();

        if (!query) {
            return fullText;
        }

        const blocks = fullText.split(/\n(?=diff --git )/);
        const matched = blocks.filter((block) => {
            const pathMatch = block.match(/^diff --git a\/(.+?) b\//m);

            return pathMatch && pathMatch[1].toLowerCase().includes(query);
        });

        return matched.join("\n\n");
    }

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

    function safeFileName(filePath) {
        return filePath
            .replace(/[\\/:"*?<>|]+/g, "_")
            .replace(/\s+/g, "_")
            .slice(-180) || "bitbucket-file";
    }

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

        const overlay = document.createElement("div");
        overlay.id = ids.modal;
        overlay.style.position = "fixed";
        overlay.style.inset = "0";
        overlay.style.zIndex = "2147483647";
        overlay.style.background = "rgba(9, 30, 66, 0.54)";
        overlay.style.display = "flex";
        overlay.style.alignItems = "center";
        overlay.style.justifyContent = "center";

        const panel = document.createElement("div");
        panel.style.width = "min(1200px, calc(100vw - 48px))";
        panel.style.height = "min(800px, calc(100vh - 48px))";
        panel.style.background = "#ffffff";
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
        header.style.borderBottom = "1px solid #dfe1e6";

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
        title.style.color = "#172b4d";
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
            metaLine.style.color = "#5e6c84";
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
        toolbar.style.borderBottom = "1px solid #dfe1e6";
        toolbar.style.background = "#fafbfc";

        const filterInput = document.createElement("input");
        filterInput.type = "search";
        filterInput.placeholder = "Filter by filename…";
        filterInput.style.flex = "1";
        filterInput.style.height = "28px";
        filterInput.style.padding = "0 8px";
        filterInput.style.border = "1px solid #dfe1e6";
        filterInput.style.borderRadius = "4px";
        filterInput.style.fontSize = "12px";

        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.readOnly = true;
        textarea.spellcheck = false;
        textarea.style.flex = "1";
        textarea.style.width = "100%";
        textarea.style.resize = "none";
        textarea.style.border = "0";
        textarea.style.outline = "none";
        textarea.style.padding = "12px";
        textarea.style.fontFamily = "Menlo, Monaco, Consolas, monospace";
        textarea.style.fontSize = "12px";
        textarea.style.lineHeight = "1.45";
        textarea.style.whiteSpace = "pre";
        textarea.style.color = "#172b4d";

        const getFilteredText = () => filterDiffByFilename(text, filterInput.value);

        filterInput.addEventListener("input", () => {
            textarea.value = getFilteredText();
        });

        toolbar.appendChild(filterInput);

        actions.appendChild(createButton("Copy", async () => {
            await copyToClipboard(textarea.value);
        }));

        actions.appendChild(createButton("Copy filtered", async () => {
            await copyToClipboard(getFilteredText());
        }, { compact: true, title: "Copy filtered diff" }));

        actions.appendChild(createButton("Download", () => {
            downloadText(downloadFileName, textarea.value);
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
        panel.appendChild(textarea);
        overlay.appendChild(panel);
        document.body.appendChild(overlay);

        textarea.focus();
        textarea.select();

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

        const colors = {
            info: { bg: "#172b4d", color: "#ffffff" },
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
        defaultAuthors: ["DSO-PR-Bot"],
        processedAttribute: "data-bb-comment-filtered"
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

    function getCommentAuthor(commentElement) {
        const triggers = commentElement.querySelectorAll('[data-testid="profileCardTrigger"]');

        for (const trigger of triggers) {
            const ariaLabel = trigger.getAttribute("aria-label") || "";
            const match = ariaLabel.match(/^more information about (.+)$/i);

            if (match && match[1]) {
                return match[1].trim();
            }
        }

        const header = commentElement.querySelector('[data-testid="comment-header"]');

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

        const blockedSet = new Set(blocked.map((name) => name.toLowerCase()));
        let hiddenCount = 0;

        for (const commentElement of document.querySelectorAll('[data-testid="comment"]')) {
            const container = findCommentThreadContainer(commentElement);

            if (!container || container.hasAttribute(commentFilter.processedAttribute)) {
                continue;
            }

            const author = getCommentAuthor(commentElement);

            if (!author || !blockedSet.has(author.toLowerCase())) {
                continue;
            }

            container.setAttribute(commentFilter.processedAttribute, "true");
            container.setAttribute("aria-hidden", "true");
            container.style.display = "none";
            hiddenCount += 1;
        }

        return hiddenCount;
    }

    function restoreHiddenComments() {
        const selector = `[${commentFilter.processedAttribute}="true"]`;

        for (const container of document.querySelectorAll(selector)) {
            container.style.display = "";
            container.removeAttribute("aria-hidden");
            container.removeAttribute(commentFilter.processedAttribute);
        }
    }

    let lastCommentToastAt = 0;

    function notifyCommentsHidden(count) {
        const now = Date.now();

        if (now - lastCommentToastAt < 8000) {
            return;
        }

        lastCommentToastAt = now;
        showToast(
            `Hidden ${count} comment${count === 1 ? "" : "s"} from blocked author${count === 1 ? "" : "s"}.`,
            "info"
        );
    }

    function openCommentFilterSettings() {
        closeModal();

        const overlay = document.createElement("div");
        overlay.id = ids.settingsModal;
        overlay.style.position = "fixed";
        overlay.style.inset = "0";
        overlay.style.zIndex = "2147483647";
        overlay.style.background = "rgba(9, 30, 66, 0.54)";
        overlay.style.display = "flex";
        overlay.style.alignItems = "center";
        overlay.style.justifyContent = "center";

        const panel = document.createElement("div");
        panel.style.width = "min(520px, calc(100vw - 32px))";
        panel.style.background = "#ffffff";
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
        header.style.borderBottom = "1px solid #dfe1e6";

        const title = document.createElement("div");
        title.textContent = "Comment filter settings";
        title.style.fontSize = "14px";
        title.style.fontWeight = "700";
        title.style.color = "#172b4d";

        header.appendChild(title);
        header.appendChild(createButton("Close", closeModal));

        const body = document.createElement("div");
        body.style.padding = "16px";
        body.style.display = "flex";
        body.style.flexDirection = "column";
        body.style.gap = "14px";

        const toggleRow = document.createElement("label");
        toggleRow.style.display = "flex";
        toggleRow.style.alignItems = "center";
        toggleRow.style.gap = "8px";
        toggleRow.style.cursor = "pointer";
        toggleRow.style.fontSize = "13px";
        toggleRow.style.color = "#172b4d";

        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = isCommentFilterEnabled();

        const toggleLabel = document.createElement("span");
        toggleLabel.textContent = "Hide comments from blocked authors";

        toggleRow.appendChild(toggle);
        toggleRow.appendChild(toggleLabel);

        toggle.addEventListener("change", () => {
            setCommentFilterEnabled(toggle.checked);

            if (!toggle.checked) {
                restoreHiddenComments();
            }
        });

        const listLabel = document.createElement("div");
        listLabel.textContent = "Blocked authors";
        listLabel.style.fontSize = "12px";
        listLabel.style.fontWeight = "700";
        listLabel.style.color = "#5e6c84";
        listLabel.style.textTransform = "uppercase";

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
                empty.style.color = "#5e6c84";
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
                row.style.background = "#f4f5f7";
                row.style.borderRadius = "4px";

                const name = document.createElement("span");
                name.textContent = author;
                name.style.fontSize = "13px";
                name.style.color = "#172b4d";

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
        input.placeholder = "Author username (e.g. DSO-PR-Bot)";
        input.style.flex = "1";
        input.style.height = "30px";
        input.style.padding = "0 8px";
        input.style.border = "1px solid #dfe1e6";
        input.style.borderRadius = "4px";
        input.style.fontSize = "13px";

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

        body.appendChild(toggleRow);
        body.appendChild(listLabel);
        body.appendChild(list);
        body.appendChild(addRow);

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

        actionsElement.insertBefore(group, actionsElement.firstChild);
        fileElement.setAttribute(attributes.fileButtonsAdded, "true");
    }

    function addFileButtonsToVisibleFiles() {
        const fileElements = Array.from(document.querySelectorAll(selectors.file));

        for (const fileElement of fileElements) {
            addFileButtons(fileElement);
        }
    }

    function isInitComplete() {
        const toolbar = document.getElementById(ids.pageToolbar);
        const fileElements = document.querySelectorAll(selectors.file);

        if (!toolbar) {
            return false;
        }

        if (fileElements.length === 0) {
            return Boolean(parsePullRequestUrl());
        }

        return Array.from(fileElements).every(
            (fileElement) => fileElement.getAttribute(attributes.fileButtonsAdded) === "true"
        );
    }

    function startCommentFiltering() {
        let scheduleTimer = null;

        const runCommentFilter = () => {
            const hiddenCount = hideBlockedComments();

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
    }

    function init() {
        let debounceTimer = null;
        let observer = null;
        let intervalId = null;

        const runInit = () => {
            addPageToolbar();
            addFileButtonsToVisibleFiles();

            if (isInitComplete()) {
                observer?.disconnect();
                observer = null;

                if (intervalId != null) {
                    globalThis.clearInterval(intervalId);
                    intervalId = null;
                }
            }
        };

        const debouncedInit = () => {
            globalThis.clearTimeout(debounceTimer);
            debounceTimer = globalThis.setTimeout(runInit, 100);
        };

        runInit();

        observer = new MutationObserver(debouncedInit);

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        intervalId = globalThis.setInterval(runInit, 1500);

        const onNavigation = () => {
            if (intervalId == null) {
                intervalId = globalThis.setInterval(runInit, 1500);
            }

            if (!observer) {
                observer = new MutationObserver(debouncedInit);
                observer.observe(document.documentElement, {
                    childList: true,
                    subtree: true
                });
            }

            debouncedInit();
        };

        globalThis.addEventListener("popstate", onNavigation);

        const originalPushState = history.pushState.bind(history);
        const originalReplaceState = history.replaceState.bind(history);

        history.pushState = (...args) => {
            originalPushState(...args);
            onNavigation();
        };

        history.replaceState = (...args) => {
            originalReplaceState(...args);
            onNavigation();
        };
    }

    init();
    startCommentFiltering();
})();