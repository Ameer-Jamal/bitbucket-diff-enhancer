"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const core = require("../lib/core.js");

test("normalizeWhitespace replaces non-breaking spaces", () => {
    assert.equal(core.normalizeWhitespace("a\u00a0b"), "a b");
    assert.equal(core.normalizeWhitespace("plain"), "plain");
    assert.equal(core.normalizeWhitespace(null), "");
    assert.equal(core.normalizeWhitespace(undefined), "");
});

test("escapeRegExp escapes regex metacharacters", () => {
    assert.equal(core.escapeRegExp("a.b"), "a\\.b");
    assert.equal(core.escapeRegExp("[x]"), "\\[x\\]");
});

test("matchesGlob matches exact strings case-insensitively", () => {
    assert.equal(core.matchesGlob("DSO-PR-Bot", "dso-pr-bot"), true);
    assert.equal(core.matchesGlob("DSO-PR-Bot", "someone-else"), false);
});

test("matchesGlob supports * wildcards", () => {
    assert.equal(core.matchesGlob("*bot*", "DSO-PR-Bot"), true);
    assert.equal(core.matchesGlob("*bot*", "BotFarm"), true);
    assert.equal(core.matchesGlob("*bot*", "my-bot"), true);
    assert.equal(core.matchesGlob("*bot*", "Amanda"), false);

    assert.equal(core.matchesGlob("*bot", "DSO-PR-Bot"), true);
    assert.equal(core.matchesGlob("*bot", "bot"), true);
    assert.equal(core.matchesGlob("*bot", "bother"), false);

    assert.equal(core.matchesGlob("bot*", "bother"), true);
    assert.equal(core.matchesGlob("bot*", "robot"), false);
});

test("matchesGlob supports ? wildcards", () => {
    assert.equal(core.matchesGlob("d?g", "dog"), true);
    assert.equal(core.matchesGlob("d?g", "dig"), true);
    assert.equal(core.matchesGlob("d?g", "DOG"), true);
    assert.equal(core.matchesGlob("d?g", "doog"), false);
});

test("matchesGlob treats regex metacharacters literally", () => {
    assert.equal(core.matchesGlob("a.b", "a.b"), true);
    assert.equal(core.matchesGlob("a.b", "axb"), false);
    assert.equal(core.matchesGlob("a(b", "a(b"), true);
});

test("matchesGlob coerces non-string text", () => {
    assert.equal(core.matchesGlob("42", 42), true);
    assert.equal(core.matchesGlob("", ""), true);
    assert.equal(core.matchesGlob("*", ""), true);
});

test("isAuthorBlocked matches blocked patterns", () => {
    assert.equal(core.isAuthorBlocked("", ["DSO-PR-Bot"]), false);
    assert.equal(core.isAuthorBlocked("Ameer Jamal", []), false);
    assert.equal(core.isAuthorBlocked("Ameer Jamal", null), false);

    assert.equal(core.isAuthorBlocked("DSO-PR-Bot", ["dso-pr-bot"]), true);
    assert.equal(core.isAuthorBlocked("DSO-PR-Bot", ["*bot*"]), true);
    assert.equal(core.isAuthorBlocked("Ameer Jamal", ["*bot*"]), false);
    assert.equal(core.isAuthorBlocked("Renovate Bot", ["*bot*", "Ameer Jamal"]), true);
});

test("countDiffLines counts added and removed lines", () => {
    const diff = [
        "diff --git a/f b/f",
        "--- a/f",
        "+++ b/f",
        "@@ -1,3 +1,3 @@",
        "-removed",
        "+added",
        " context",
        "-another"
    ].join("\n");

    assert.deepEqual(core.countDiffLines(diff), { added: 1, removed: 2 });
    assert.deepEqual(core.countDiffLines(""), { added: 0, removed: 0 });
});

test("filterDiffByFilename filters file blocks by path", () => {
    const full = [
        "diff --git a/src/foo.js b/src/foo.js",
        "-old",
        "+new",
        "diff --git a/src/bar.js b/src/bar.js",
        "-x",
        "+y"
    ].join("\n");

    assert.equal(core.filterDiffByFilename(full, ""), full);
    assert.equal(core.filterDiffByFilename(full, "foo"), "diff --git a/src/foo.js b/src/foo.js\n-old\n+new");
    assert.equal(core.filterDiffByFilename(full, "BAR").includes("bar.js"), true);
    assert.equal(core.filterDiffByFilename(full, "missing"), "");
});

test("safeFileName sanitizes paths", () => {
    assert.equal(core.safeFileName("src/my file.ts"), "src_my_file.ts");
    assert.equal(core.safeFileName("a/b:c*d?e"), "a_b_c_d_e");
    assert.equal(core.safeFileName(""), "bitbucket-file");

    const long = "x".repeat(300);
    assert.equal(core.safeFileName(long).length, 180);
});

test("extractJiraTicket finds a ticket id", () => {
    assert.equal(core.extractJiraTicket("RU-27680 do the thing"), "RU-27680");
    assert.equal(core.extractJiraTicket("fix bug (ABC-123)"), "ABC-123");
    assert.equal(core.extractJiraTicket("no ticket here"), "");
    assert.equal(core.extractJiraTicket(""), "");
});

test("buildPullRequestSummary formats fields", () => {
    const summary = core.buildPullRequestSummary({
        title: "Add S3 access",
        url: "https://bitbucket.org/ws/repo/pull-requests/1",
        author: "Ameer Jamal",
        ticket: "RU-27680",
        sourceBranch: "feature/x",
        destinationBranch: "main",
        files: 3,
        added: 10,
        removed: 2
    });

    assert.match(summary, /Title: Add S3 access/);
    assert.match(summary, /Ticket: RU-27680/);
    assert.match(summary, /Branch: feature\/x -> main/);
    assert.match(summary, /Files changed: 3/);
    assert.match(summary, /Lines: \+10 \/ -2/);
});

test("buildAiReviewPrompt embeds the diff", () => {
    const prompt = core.buildAiReviewPrompt({
        title: "Fix bug",
        sourceBranch: "feature",
        destinationBranch: "main",
        diff: "-old\n+new"
    });

    assert.match(prompt, /Title: Fix bug/);
    assert.match(prompt, /```diff/);
    assert.match(prompt, /-old\n\+new/);
});

test("buildReviewTemplate supports approval and changes", () => {
    const approve = core.buildReviewTemplate({ type: "approve", title: "My PR" });
    assert.match(approve, /Approved: My PR/);

    const changes = core.buildReviewTemplate({ type: "changes", title: "My PR" });
    assert.match(changes, /Requesting changes: My PR/);
});
