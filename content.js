// xpost_to_pdf — content script. Injected on toolbar click.
// Finds the main tweet, hides X clutter, waits for images, reports the rect;
// later receives the captured PNG chunks and assembles them into a paginated
// PDF with bundled jsPDF, breaking pages between content blocks.

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
      makePdf(msg)
        .then(sendResponse)
        .catch((err) => {
          cleanup();
          sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
        });
      return true; // async
    }
    if (msg.cmd === "collectBreaks") {
      const article = window.__xpdfArticle;
      if (article) {
        const pageH = Math.round(article.getBoundingClientRect().width * 1.4142);
        window.__xpdfBreaks = {
          rectTop: article.getBoundingClientRect().top + window.scrollY,
          noCut: collectNoCutIntervals(article, pageH * 0.85),
        };
      }
      sendResponse({ ok: true });
      return false;
    }
    if (msg.cmd === "scrollTo") {
      window.scrollTo({ top: Math.max(0, msg.y), behavior: "instant" });
      sendResponse({ ok: true });
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
    markSticky(article);
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

  // Sticky/fixed bars inside the main column ("← Post" / "← Article" headers)
  // re-anchor to wherever the capture viewport is and get stamped into the
  // middle of pages. Hide any of them that aren't part of the tweet itself.
  function markSticky(article) {
    const root =
      document.querySelector('[data-testid="primaryColumn"]') ||
      document.querySelector('main[role="main"]') ||
      document.body;
    let level = [root];
    for (let depth = 0; depth < 6 && level.length; depth++) {
      const next = [];
      for (const el of level) {
        for (const child of el.children) {
          if (child === article || article.contains(child) || child.contains(article)) {
            if (child.contains(article) && child !== article) next.push(child);
            continue;
          }
          const pos = getComputedStyle(child).position;
          if (pos === "sticky" || pos === "fixed") {
            child.setAttribute("data-xpdf-hide", "1");
          } else {
            next.push(child);
          }
        }
      }
      level = next;
    }
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
    delete window.__xpdfBreaks;
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

  // Blocks that must never be split across a page break: their document-Y
  // intervals, collected from the article's leaf content elements.
  function collectNoCutIntervals(article, maxBlockH) {
    const intervals = [];
    const add = (el) => {
      const r = el.getBoundingClientRect();
      if (r.height <= 0 || r.width <= 0) return;
      if (r.height > maxBlockH && el.children.length) {
        // Too tall to keep whole (long paragraph/thread of divs) — protect
        // its children instead so a break can land between them.
        Array.from(el.children).forEach(add);
        return;
      }
      intervals.push([r.top + window.scrollY, r.bottom + window.scrollY]);
    };
    article
      .querySelectorAll("p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, figure, img, video, table, hr")
      .forEach(add);
    // Plain-tweet text and media live in divs; protect direct text holders too.
    article.querySelectorAll("div").forEach((div) => {
      const hasText = Array.from(div.childNodes).some(
        (n) => n.nodeType === 3 && n.textContent.trim()
      );
      if (hasText) add(div);
    });
    intervals.sort((a, b) => a[0] - b[0]);
    // Merge overlaps.
    const merged = [];
    for (const iv of intervals) {
      const last = merged[merged.length - 1];
      if (last && iv[0] <= last[1] + 1) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    return merged;
  }

  function loadImage(b64) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Could not decode captured image."));
      img.src = "data:image/png;base64," + b64;
    });
  }

  async function makePdf({ chunks, wCss, hCss }) {
    try {
      const article = window.__xpdfArticle;
      const pageW = wCss;
      const pageH = Math.round(pageW * 1.4142); // A4 proportions
      const breaks =
        window.__xpdfBreaks ||
        (article
          ? {
              rectTop: article.getBoundingClientRect().top + window.scrollY,
              noCut: collectNoCutIntervals(article, pageH * 0.85),
            }
          : { rectTop: 0, noCut: [] });
      const rectTop = breaks.rectTop;
      const noCut = breaks.noCut;

      const images = await Promise.all(chunks.map((c) => loadImage(c.b64)));
      // Effective device scale can exceed devicePixelRatio (display scaling
      // x page zoom); derive it from the actual bitmap and cap output at 2x.
      const mult = images[0].naturalWidth / wCss;
      const outScale = Math.min(mult, 2);

      const bg = getComputedStyle(document.body).backgroundColor || "#ffffff";

      // Choose page cut points (offsets within the capture, CSS px).
      const cuts = [];
      let cur = 0;
      while (cur < hCss) {
        let cut = Math.min(cur + pageH, hCss);
        if (cut < hCss) {
          const docY = rectTop + cut;
          const straddling = noCut.find(([t, b]) => docY > t + 2 && docY < b - 2);
          if (straddling) {
            const candidate = straddling[0] - rectTop - 4;
            if (candidate > cur + pageH * 0.35) cut = candidate;
          }
        }
        cuts.push([cur, cut]);
        cur = cut;
      }

      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({
        unit: "px",
        format: [pageW, pageH],
        orientation: pageW > pageH ? "landscape" : "portrait",
        hotfixes: ["px_scaling"],
        compress: true,
      });

      cuts.forEach(([start, end], i) => {
        const canvas = document.createElement("canvas");
        canvas.width = Math.round(pageW * outScale);
        canvas.height = Math.round(pageH * outScale);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        chunks.forEach((c, j) => {
          const cTop = c.offCss;
          const cBot = c.offCss + c.hCss;
          const segTop = Math.max(start, cTop);
          const segBot = Math.min(end, cBot);
          if (segBot <= segTop) return;
          const img = images[j];
          const yScale = img.naturalHeight / c.hCss;
          ctx.drawImage(
            img,
            0,
            (segTop - cTop) * yScale,
            img.naturalWidth,
            (segBot - segTop) * yScale,
            0,
            (segTop - start) * outScale,
            pageW * outScale,
            (segBot - segTop) * outScale
          );
        });
        if (i > 0) doc.addPage([pageW, pageH]);
        doc.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, pageW, pageH);
      });

      const dataUrl = doc.output("datauristring");
      return { ok: true, dataUrl };
    } finally {
      cleanup();
    }
  }
})();
