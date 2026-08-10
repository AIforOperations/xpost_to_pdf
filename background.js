// xpost_to_pdf — background service worker.
// Flow: toolbar click -> guard URL -> inject content script -> content prepares
// the tweet (hides clutter, waits for images, measures rect) -> capture via
// chrome.debugger Page.captureScreenshot -> content builds the PDF (jsPDF) ->
// downloads.download with saveAs so the user picks location + name.

const STATUS_RE = /^https:\/\/(?:mobile\.)?(?:x|twitter)\.com\/[^/]+\/status\/(\d+)/;

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

    // Keep the capture under Chrome's texture ceiling (~16k px per side).
    let scale = prep.dpr || 1;
    if (prep.rect.height * scale > 16000 || prep.rect.width * scale > 16000) {
      scale = 1;
    }

    shot = await cdp(tab.id, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      fromSurface: true,
      clip: {
        x: prep.rect.x,
        y: prep.rect.y,
        width: prep.rect.width,
        height: prep.rect.height,
        scale,
      },
    });
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
    pngBase64: shot.data,
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

function attachDebugger(tabId) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
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
