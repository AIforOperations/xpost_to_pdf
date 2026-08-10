// xpost_to_pdf — background service worker.
// Flow: toolbar click -> guard URL -> inject content script -> content prepares
// the tweet (hides clutter, waits for images, measures rect) -> capture via
// chrome.debugger Page.captureScreenshot -> content builds the PDF (jsPDF) ->
// downloads.download with saveAs so the user picks location + name.

const STATUS_RE = /^https:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/;

const busyTabs = new Set();

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;
  const match = tab.url && tab.url.match(STATUS_RE);
  if (!match) {
    notify(tab.id, "Open a single X post (a /status/ page) first, then click again.");
    return;
  }
  if (busyTabs.has(tab.id)) return;
  busyTabs.add(tab.id);
  try {
    await capturePost(tab, match[1]);
  } catch (err) {
    console.error("xpost_to_pdf failed:", err);
    notify(tab.id, "Could not create the PDF: " + (err && err.message ? err.message : err));
    sendToTab(tab.id, { cmd: "cleanup" });
  } finally {
    busyTabs.delete(tab.id);
  }
});

async function capturePost(tab, statusId) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["lib/jspdf.umd.min.js", "content.js"],
  });

  // Attach the debugger BEFORE measuring: the "is being debugged" infobar can
  // resize the viewport and shift document coordinates.
  let attached = false;
  let shot;
  let prep;
  try {
    await attachDebugger(tab.id);
    attached = true;

    prep = await sendToTab(tab.id, { cmd: "prepare", statusId });
    if (!prep || !prep.ok) {
      throw new Error((prep && prep.error) || "Could not find the post on this page.");
    }

    // X virtualizes its feed: content rendered outside the viewport gets
    // recycled, which corrupts captureBeyondViewport shots (duplicated
    // sections). Instead, temporarily grow the viewport to cover the whole
    // post so everything really renders, then take a plain clipped shot.
    const metrics = await cdp(tab.id, "Page.getLayoutMetrics", {});
    const viewW = Math.ceil(metrics.cssLayoutViewport.clientWidth);
    const viewH = Math.min(Math.ceil(prep.rect.height) + 200, 8000);
    await cdp(tab.id, "Emulation.setDeviceMetricsOverride", {
      width: viewW,
      height: viewH,
      deviceScaleFactor: 0,
      mobile: false,
    });

    let chunks;
    try {
      // Let the page re-render at full height, then confirm the rect is
      // stable (late loads above the post shift the clip).
      for (let attempt = 0; attempt < 3; attempt++) {
        const check = await sendToTab(tab.id, { cmd: "remeasure" });
        if (check && check.ok) {
          if (attempt > 0 && rectsClose(check.rect, prep.rect)) break;
          prep.rect = check.rect;
        }
        await new Promise((r) => setTimeout(r, 400));
      }

      // Capture in vertical chunks. The rendered surface can be scaled far
      // beyond devicePixelRatio (display scaling x page zoom), and a single
      // tall shot past Chrome's ~16384px texture ceiling comes back
      // truncated. 2000 CSS px per chunk stays safe up to 8x scaling.
      const CHUNK = 2000;
      const needsScroll = prep.rect.height + 200 > viewH;
      chunks = [];
      let off = 0;
      while (off < prep.rect.height) {
        const h = Math.min(CHUNK, prep.rect.height - off);
        if (needsScroll) {
          await sendToTab(tab.id, { cmd: "scrollTo", y: prep.rect.y + off - 100 });
          await new Promise((r) => setTimeout(r, 350));
          const check = await sendToTab(tab.id, { cmd: "remeasure" });
          if (check && check.ok) prep.rect = check.rect;
        }
        const shotPart = await cdp(tab.id, "Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          fromSurface: true,
          clip: {
            x: prep.rect.x,
            y: prep.rect.y + off,
            width: prep.rect.width,
            height: h,
            scale: 1,
          },
        });
        chunks.push({ b64: shotPart.data, offCss: off, hCss: h });
        off += h;
      }
      // Page-break geometry must be read while the enlarged viewport is
      // still active — restoring it below can reflow the article.
      await sendToTab(tab.id, { cmd: "collectBreaks" });
    } finally {
      await cdp(tab.id, "Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
    }
    shot = chunks;
  } finally {
    if (attached) {
      try {
        await chrome.debugger.detach({ tabId: tab.id });
      } catch (e) {
        // Tab may have gone away; nothing to do.
      }
    }
  }

  const pdf = await sendToTab(tab.id, {
    cmd: "makePdf",
    chunks: shot,
    wCss: prep.rect.width,
    hCss: prep.rect.height,
  });
  if (!pdf || !pdf.ok) {
    throw new Error((pdf && pdf.error) || "PDF generation failed.");
  }

  const handle = sanitize(prep.handle || "post");
  await chrome.downloads.download({
    url: pdf.dataUrl,
    filename: `${handle}_${statusId}.pdf`,
    saveAs: true,
  });
}

function rectsClose(a, b) {
  return (
    Math.abs(a.x - b.x) <= 2 &&
    Math.abs(a.y - b.y) <= 2 &&
    Math.abs(a.width - b.width) <= 2 &&
    Math.abs(a.height - b.height) <= 2
  );
}

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) {
        const msg = /another debugger/i.test(err.message)
          ? "DevTools (or another extension) is already attached to this tab. Close it and try again."
          : err.message;
        reject(new Error(msg));
      } else resolve();
    });
  });
}

function cdp(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

function sendToTab(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (response) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(response);
    });
  });
}

function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40) || "post";
}

function notify(tabId, message) {
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (text) => {
        const el = document.createElement("div");
        el.textContent = text;
        el.style.cssText =
          "position:fixed;top:16px;left:50%;transform:translateX(-50%);" +
          "background:#1d1d1f;color:#fff;padding:10px 18px;border-radius:8px;" +
          "font:14px -apple-system,sans-serif;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.3)";
        document.documentElement.appendChild(el);
        setTimeout(() => el.remove(), 4000);
      },
      args: [message],
    })
    .catch(() => {});
}
