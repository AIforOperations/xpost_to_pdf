// xpost_to_pdf — content script. Injected on toolbar click.
// Finds the main tweet, hides X clutter, waits for images, reports the rect;
// later receives the captured PNG and builds the PDF with bundled jsPDF.

(() => {
  if (window.__xpdfLoaded) return;
  window.__xpdfLoaded = true;

  const STYLE_ID = "xpdf-hide-style";

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.cmd === "prepare") {
      prepare(msg.statusId)
        .then(sendResponse)
        .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
      return true; // async
    }
    if (msg.cmd === "makePdf") {
      try {
        sendResponse(makePdf(msg));
      } catch (err) {
        cleanup();
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      }
      return false;
    }
    if (msg.cmd === "remeasure") {
      const article = window.__xpdfArticle;
      sendResponse(article ? { ok: true, rect: measureRect(article) } : { ok: false });
      return false;
    }
    if (msg.cmd === "cleanup") {
      cleanup();
      return false;
    }
  });

  async function prepare(statusId) {
    const article = findMainTweet(statusId);
    if (!article) {
      return { ok: false, error: "Could not find the post. Scroll it into view and try again." };
    }

    article.scrollIntoView({ block: "center", behavior: "instant" });
    injectHideStyle();
    markClutter(article);
    await waitForImages(article, 6000);
    await nextFrame();
    await nextFrame();

    // Measure last, after hiding clutter (it changes the height).
    const rect = measureRect(article);
    if (!rect || rect.width < 10 || rect.height < 10) {
      cleanup();
      return { ok: false, error: "Post has no visible content to capture." };
    }

    window.__xpdfArticle = article;
    return {
      ok: true,
      rect,
      dpr: window.devicePixelRatio || 1,
      handle: findHandle(article),
    };
  }

  function measureRect(article) {
    const r = article.getBoundingClientRect();
    return {
      x: Math.max(0, r.left + window.scrollX),
      y: Math.max(0, r.top + window.scrollY),
      width: Math.ceil(r.width),
      height: Math.ceil(r.height),
    };
  }

  // Tag the engagement bar precisely instead of hiding every [role="group"]
  // (X also uses role="group" on multi-image media grids).
  function markClutter(article) {
    document.querySelectorAll("[data-xpdf-hide]").forEach((el) => el.removeAttribute("data-xpdf-hide"));
    article.querySelectorAll('[role="group"]').forEach((group) => {
      const label = (group.getAttribute("aria-label") || "").toLowerCase();
      const isActionBar =
        group.querySelector(
          '[data-testid="reply"], [data-testid="retweet"], [data-testid="like"], [data-testid="bookmark"]'
        ) || /repl|repost|like|view|bookmark/.test(label);
      if (isActionBar) group.setAttribute("data-xpdf-hide", "1");
    });
  }

  function findMainTweet(statusId) {
    // Logged-in X tags tweets with data-testid; logged-out / article layouts
    // serve plain <article> elements. Support both.
    let articles = Array.from(document.querySelectorAll('article[data-testid="tweet"]'));
    if (!articles.length) articles = Array.from(document.querySelectorAll("article"));
    if (!articles.length) return null;
    // The main tweet on a status page contains a permalink to this status id
    // (parents/replies link to their own ids).
    const byPermalink = articles.find((a) =>
      a.querySelector(`a[href*="/status/${statusId}"]`)
    );
    if (byPermalink) return byPermalink;
    // Fallback: the main tweet renders its timestamp unlinked as a full date.
    const byUnlinkedTime = articles.find(
      (a) => a.querySelector("time") && !a.querySelector("a time")
    );
    return byUnlinkedTime || articles[0];
  }

  function findHandle(article) {
    // First profile link inside the tweet header, e.g. href="/eptwts".
    const link = article.querySelector('[data-testid="User-Name"] a[href^="/"]');
    if (link) {
      const m = link.getAttribute("href").match(/^\/([A-Za-z0-9_]+)/);
      if (m) return m[1];
    }
    const m = location.pathname.match(/^\/([A-Za-z0-9_]+)\/status\//);
    return m ? m[1] : "post";
  }

  function injectHideStyle() {
    removeHideStyle();
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* Instant scrolling so rect measurement isn't taken mid-animation */
      html, body { scroll-behavior: auto !important; }
      /* Engagement bar, tagged by markClutter() */
      [data-xpdf-hide] { display: none !important; }
      /* Grok actions and translate prompts */
      article [aria-label*="Grok" i],
      article [data-testid="GrokTranslate"] { display: none !important; }
      /* Reply composer under the post */
      [data-testid="inline_reply_offscreen"] { display: none !important; }
      /* Page chrome outside the tweet — visibility keeps layout stable */
      header[role="banner"] { visibility: hidden !important; }
      [data-testid="sidebarColumn"] { visibility: hidden !important; }
      /* Toasts, banners, login CTAs and fixed bars that could overlap the clip */
      #layers [role="alert"], [data-testid="toast"] { display: none !important; }
      #layers [role="dialog"], [data-testid="sheetDialog"],
      [data-testid="BottomBar"] { display: none !important; }
    `;
    document.documentElement.appendChild(style);
  }

  function removeHideStyle() {
    const el = document.getElementById(STYLE_ID);
    if (el) el.remove();
  }

  function cleanup() {
    removeHideStyle();
    document.querySelectorAll("[data-xpdf-hide]").forEach((el) => el.removeAttribute("data-xpdf-hide"));
    delete window.__xpdfArticle;
  }

  function waitForImages(article, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve) => {
      (function check() {
        const imgs = Array.from(article.querySelectorAll("img"));
        const pending = imgs.some((img) => !(img.complete && img.naturalWidth > 0));
        const spinner = article.querySelector('[role="progressbar"]');
        if (Date.now() > deadline) {
          resolve();
        } else if (!pending && !spinner) {
          // Grace period so the full-res swap paints, then verify once more.
          setTimeout(() => {
            const stillPending = Array.from(article.querySelectorAll("img")).some(
              (img) => !(img.complete && img.naturalWidth > 0)
            );
            if (stillPending && Date.now() < deadline) check();
            else resolve();
          }, 250);
        } else {
          setTimeout(check, 200);
        }
      })();
    });
  }

  function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => r()));
  }

  function makePdf({ pngBase64, wCss, hCss }) {
    try {
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({
        unit: "px",
        format: [wCss, hCss],
        orientation: wCss > hCss ? "landscape" : "portrait",
        hotfixes: ["px_scaling"],
        compress: true,
      });
      doc.addImage("data:image/png;base64," + pngBase64, "PNG", 0, 0, wCss, hCss);
      const dataUrl = doc.output("datauristring");
      return { ok: true, dataUrl };
    } finally {
      cleanup();
    }
  }
})();
