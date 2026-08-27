// Bitbucket Diff Enhancer — background service worker.
// Performs cross-origin fetches on behalf of the content script using the
// user's Bitbucket session (granted via host_permissions).

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "bb-diff-enhancer-fetch") {
        return false;
    }

    const requestHeaders = Object.assign({}, message.headers || {});

    if (message.accept) {
        requestHeaders.Accept = message.accept;
    }

    fetch(message.url, {
        method: message.method || "GET",
        credentials: "include",
        redirect: "follow",
        headers: requestHeaders
    })
        .then(async (response) => {
            const text = await response.text();

            let responseHeaders = "";
            response.headers.forEach((value, key) => {
                responseHeaders += key + ": " + value + "\n";
            });

            sendResponse({
                ok: true,
                status: response.status,
                statusText: response.statusText,
                text: text,
                responseHeaders: responseHeaders,
                finalUrl: response.url
            });
        })
        .catch((error) => {
            sendResponse({
                ok: false,
                error: String((error && error.message) || error)
            });
        });

    // Keep the message channel open for the async sendResponse.
    return true;
});
