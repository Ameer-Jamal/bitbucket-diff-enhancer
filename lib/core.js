// Bitbucket Diff Enhancer — shared core (pure, testable functions).
//
// Loaded as a UMD module so it works:
//   - in the browser (exposes `window.BbDiffEnhancer`), and
//   - in Node for unit tests (via `module.exports`).

(function (root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.BbDiffEnhancer = factory();
    }
})(typeof self !== "undefined" ? self : this, function () {
    "use strict";

    // Replaces non-breaking spaces and normalizes to a plain space.
    function normalizeWhitespace(value) {
        return String(value || "").replace(/\u00a0/g, " ");
    }

    // Escapes regex metacharacters so a literal character matches literally.
    function escapeRegExp(value) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    // Converts a glob pattern (* and ?) into a RegExp.
    function globToRegExp(pattern) {
        const source = String(pattern)
            .split("")
            .map((character) => {
                if (character === "*") {
                    return ".*";
                }

                if (character === "?") {
                    return ".";
                }

                return escapeRegExp(character);
            })
            .join("");

        return new RegExp("^" + source + "$", "i");
    }

    // Case-insensitive glob match. `*` matches any run of characters and `?`
    // matches a single character. Patterns without wildcards match exactly.
    function matchesGlob(pattern, text) {
        return globToRegExp(pattern).test(String(text || ""));
    }

    // True when the author matches any blocked pattern. Patterns may contain
    // `*`/`?` wildcards; matching is case-insensitive.
    function isAuthorBlocked(author, patterns) {
        if (!author || !Array.isArray(patterns) || patterns.length === 0) {
            return false;
        }

        return patterns.some((pattern) => matchesGlob(pattern, author));
    }

    // Counts added (+) and removed (-) lines in a unified diff, ignoring the
    // `---`/`+++` file header lines.
    function countDiffLines(text) {
        let added = 0;
        let removed = 0;

        for (const line of String(text || "").split("\n")) {
            if (line.startsWith("+") && !line.startsWith("+++")) {
                added += 1;
            } else if (line.startsWith("-") && !line.startsWith("---")) {
                removed += 1;
            }
        }

        return { added, removed };
    }

    // Filters a concatenated multi-file diff to files whose path contains the
    // query (case-insensitive). Returns the full text when the query is empty.
    function filterDiffByFilename(fullText, filterQuery) {
        const query = String(filterQuery || "").trim().toLowerCase();

        if (!query) {
            return fullText;
        }

        const blocks = String(fullText || "").split(/\n(?=diff --git )/);
        const matched = blocks.filter((block) => {
            const pathMatch = block.match(/^diff --git a\/(.+?) b\//m);

            return pathMatch && pathMatch[1].toLowerCase().includes(query);
        });

        return matched.join("\n\n");
    }

    // Sanitizes a file path into a safe filename.
    function safeFileName(filePath) {
        return String(filePath)
            .replace(/[\\/:"*?<>|]+/g, "_")
            .replace(/\s+/g, "_")
            .slice(-180) || "bitbucket-file";
    }

    // Extracts the first Jira-style ticket id (e.g. RU-27680) from a string.
    function extractJiraTicket(text) {
        const match = String(text || "").match(/\b([A-Z][A-Z0-9]+-\d+)\b/);

        return match ? match[1] : "";
    }

    // Classifies a unified-diff line so the viewer can color it.
    function classifyDiffLine(line) {
        if (line.startsWith("diff --git ") || line.startsWith("--- ") || line.startsWith("+++ ")) {
            return "header";
        }

        if (line.startsWith("@@")) {
            return "hunk";
        }

        if (line.startsWith("+")) {
            return "add";
        }

        if (line.startsWith("-")) {
            return "remove";
        }

        return "context";
    }

    // Formats a structured pull request summary as plain text.
    function buildPullRequestSummary(input) {
        input = input || {};
        const lines = [];

        const push = (label, value) => {
            if (value !== undefined && value !== null && value !== "") {
                lines.push(label + ": " + value);
            }
        };

        push("Title", input.title);
        push("URL", input.url);
        push("Author", input.author);
        push("Ticket", input.ticket || "-");
        push("Branch", (input.sourceBranch || "?") + " -> " + (input.destinationBranch || "?"));

        if (input.files !== undefined && input.files !== null) {
            lines.push("Files changed: " + input.files);
        }

        if (input.added !== undefined || input.removed !== undefined) {
            lines.push("Lines: +" + (input.added || 0) + " / -" + (input.removed || 0));
        }

        if (input.description) {
            const description = String(input.description)
                .replace(/\s+/g, " ")
                .trim();

            if (description) {
                lines.push("Description: " + description.slice(0, 400));
            }
        }

        return lines.join("\n");
    }

    // Builds a prompt (with the diff embedded) for pasting into an AI reviewer.
    function buildAiReviewPrompt(input) {
        input = input || {};

        return [
            "You are an experienced software engineer reviewing a pull request.",
            "",
            "Title: " + (input.title || "Untitled"),
            "Branch: " + (input.sourceBranch || "?") + " -> " + (input.destinationBranch || "?"),
            "",
            "Review the diff below for bugs, security issues, correctness, and maintainability.",
            "Respond with a prioritized list of concrete findings, each including the file/location and a suggested fix.",
            "",
            "```diff",
            input.diff || "",
            "```"
        ].join("\n");
    }

    // Builds a pre-filled review message template (approval or changes requested).
    function buildReviewTemplate(input) {
        input = input || {};
        const title = input.title || "Untitled pull request";

        if (input.type === "changes") {
            return [
                "Requesting changes: " + title,
                "",
                "Summary of requested changes:",
                "- ",
                "",
                "Follow-ups:",
                "- ",
                "",
                input.url || ""
            ].join("\n");
        }

        return [
            "Approved: " + title,
            "",
            "Looks good to me.",
            "",
            input.url || ""
        ].join("\n");
    }

    return {
        normalizeWhitespace,
        escapeRegExp,
        globToRegExp,
        matchesGlob,
        isAuthorBlocked,
        countDiffLines,
        filterDiffByFilename,
        safeFileName,
        classifyDiffLine,
        extractJiraTicket,
        buildPullRequestSummary,
        buildAiReviewPrompt,
        buildReviewTemplate
    };
});
