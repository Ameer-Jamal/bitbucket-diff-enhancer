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

    return {
        normalizeWhitespace,
        escapeRegExp,
        globToRegExp,
        matchesGlob,
        isAuthorBlocked,
        countDiffLines,
        filterDiffByFilename,
        safeFileName
    };
});
