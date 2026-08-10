# X Post to PDF

Chrome extension that saves any X (Twitter) post as a clean, paginated PDF — with all images, avatars, and quote cards intact. Chrome's built-in print-to-PDF drops X's images; this extension captures the post exactly as rendered, then lays it out on proper PDF pages.

## How to use

1. Open a single post (`x.com/<user>/status/<id>`).
2. Click the extension icon.
3. A native save dialog opens with a default filename like `handle_postid.pdf`. Pick a location, done.

Works on regular posts, long posts, and X Articles, in light or dark mode. The output keeps the author, text, media, and timestamp, and hides X clutter: the reply composer, the like/repost/share bar, Grok buttons, sticky headers, and sidebars.

During capture (2–3 seconds) you'll see Chrome's "started debugging this browser" bar and, if your zoom isn't 100%, the page briefly snapping to 100% — both revert automatically when the capture finishes.

## Install

1. Clone or download this repo (Code → Download ZIP, then unzip).
2. Open `chrome://extensions`, enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.
4. Open any X post and click the icon (pin it via the puzzle-piece menu for quick access).

## How it works

- On click, a content script finds the main post (matched by its status-id permalink, with fallbacks for the logged-out DOM), hides UI clutter and sticky bars with an injected stylesheet, and waits for every image to finish loading.
- The background worker normalizes tab zoom to 100% (screenshot clip coordinates are zoom-sensitive), attaches the Chrome debugger, temporarily grows the viewport to the post's full height so X's virtualized feed renders everything, and captures the post in vertical chunks via `Page.captureScreenshot` — Chrome's own compositor output, so fonts and images are exact. Chunking keeps captures under Chrome's 16384px texture ceiling even on scaled displays.
- The content script assembles the chunks into A4-proportioned pages via bundled jsPDF, choosing page breaks between content blocks — a paragraph or image is never split across two pages.
- `chrome.downloads.download({saveAs: true})` shows the native save dialog. Zoom, styles, and the debugger are always restored afterwards, including on errors.

## Permissions

- `activeTab` + `scripting` — inject the capture script only when you click, only on the current tab. No persistent access to any site.
- `debugger` — the screenshot API (this is what triggers the temporary "debugging this browser" bar).
- `downloads` — the save dialog.

No analytics, no network calls, no remote code. jsPDF is bundled locally (`lib/jspdf.umd.min.js`, v2.5.2, MIT).

## Limitations

- Videos are captured as their current poster/frame (a PDF can't play video).
- Captures a single post, not a whole thread.
- If DevTools is already open on the tab, close it first (only one debugger can attach at a time).
- Output is an image-based PDF (pixel-exact, but text isn't selectable).

## License

MIT
