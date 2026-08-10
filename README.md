# X Post to PDF

Chrome extension that saves any X (Twitter) post as a pixel-perfect PDF — with all images, avatars, and quote cards intact. Chrome's built-in print-to-PDF drops X's images; this extension captures the post exactly as rendered.

## How it works

1. Open a single post (`x.com/<user>/status/<id>`).
2. Click the extension icon.
3. A native save dialog opens with a default filename like `handle_postid.pdf`. Pick a location, done.

The output keeps the author, text, media, and timestamp, and hides X clutter: the reply composer, the like/repost/share bar, Grok buttons, and sidebars.

## Technique

- On click, a content script finds the main tweet (`article[data-testid="tweet"]` matched by the status id permalink), hides UI clutter with an injected stylesheet, scrolls it into view, and waits for every image to finish loading.
- The background worker attaches the Chrome debugger to the tab and takes a `Page.captureScreenshot` with a clip set to the tweet's exact bounding box (`captureBeyondViewport: true`), so the capture is Chrome's own compositor output — exact fonts, exact images, full resolution, dark or light mode preserved.
- The content script wraps the PNG in a single custom-sized PDF page via bundled jsPDF, and `chrome.downloads.download({saveAs: true})` shows the save dialog.

You'll see Chrome's "started debugging this browser" bar for a second during capture — that's the screenshot API, it detaches immediately after.

## Install

1. Clone or download this repo.
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open any X post and click the icon.

## Permissions

- `activeTab` + `scripting` — inject the capture script only when you click, only on the current tab. No persistent access to any site.
- `debugger` — the screenshot API.
- `downloads` — the save dialog.

No analytics, no network calls, no remote code. jsPDF is bundled locally (`lib/jspdf.umd.min.js`, v2.5.2, MIT).

## Limitations

- Videos are captured as their current poster/frame (a PDF can't play video).
- Captures a single post, not a whole thread.
- If DevTools is already open on the tab, close it first (only one debugger can attach).
