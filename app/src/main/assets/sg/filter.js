/* Safe Feed - page filter. Runs inside the Facebook page (top frame only).
 *
 * Rule: every picture / video stays BLURRED until the on-phone face check says
 * "no woman's face". If anything fails (no answer, error, timeout) it stays blurred.
 *
 * Verdicts coming back from the app:  0 = no woman   1 = woman   2 = error
 */
(function () {
  'use strict';
  var W = window, D = document;
  try { if (W.top !== W) { return; } } catch (e) { return; }
  if (W.__sg) { return; }

  var CFG = {
    blurPx: 32,            // blur strength
    iconPx: 24,            // a picture whose real size is smaller than this = icon/dot, shown without a check
    rootMargin: '600px 0px 600px 0px',
    imgMax: 640,           // longest side (px) of the copy sent for checking
    imgQuality: 0.85,
    videoMax: 224,
    videoQuality: 0.7,
    videoEveryMs: 400,     // how often playing videos are sampled
    videoBudget: 3,        // videos sampled per round
    videoCleanNeeded: 2,   // clean samples needed before a video is shown
    videoStaleMs: 2500,    // a playing video with no fresh "clean" answer for this long is blurred again
    videoWaitMs: 1200,     // an unanswered video frame older than this no longer blocks the next one
    reelRatio: 1.6,        // taller than this (height / width) = Reel-like video: never shown
    maxTries: 3,
    retryMs: 3000,
    pendingMs: 60000,
    maintainMs: 2000,
    corsFailLimit: 4,
    memoMax: 4000
  };

  var token = ('s' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36))
    .replace(/[^A-Za-z0-9]/g, '');
  var SG = W.__sg = {
    v: 1,
    token: token,
    st: { seen: 0, ok: 0, female: 0, err: 0, memo: 0, cors: 0, native: 0, frames: 0, reels: 0, reelVideos: 0 },
    errs: []
  };

  function bridge() { try { return W.SgBridge || null; } catch (e) { return null; } }
  function note(m) {
    m = String(m).slice(0, 160);
    SG.errs.push(m);
    if (SG.errs.length > 12) { SG.errs.shift(); }
    try { var b = bridge(); if (b && b.log) { b.log(m); } } catch (e) { /* ignore */ }
  }

  // ------------------------------------------------------------------ CSS (blur by default + hide Reels)
  var CSS = ''
    + 'img:not([data-sgok]):not([src*="/rsrc.php/"]):not([src*="//static."]),'
    + 'video:not([data-sgok]),'
    + '[style*="url("]:not([data-sgok]):not([style*="rsrc.php"]):not([style*="//static."])'
    + '{filter:blur(' + CFG.blurPx + 'px)!important;}'
    + 'svg:not([data-sgok]):has(image){filter:blur(' + CFG.blurPx + 'px)!important;}'
    + 'video[data-sgreel]{visibility:hidden!important;}'
    + 'a[href*="/reel/"],a[href*="/reels"],a[href^="/reel"],'
    + '[aria-label="Reels"],[aria-label="Reels and short videos"],[aria-label="\u09B0\u09BF\u09B2\u09B8"]'
    + '{display:none!important;}';

  function ensureCss() {
    try {
      if (D.getElementById('__sg_css')) { return; }
      var host = D.head || D.documentElement;
      if (!host) { return; }
      var s = D.createElement('style');
      s.id = '__sg_css';
      s.textContent = CSS;
      host.appendChild(s);
    } catch (e) { note('css ' + e); }
  }

  // ------------------------------------------------------------------ helpers
  function hash(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0).toString(36);
  }
  function abs(u) { try { return new URL(u, D.baseURI).href; } catch (e) { return u; } }
  function nkey(u) {
    try {
      if (u.slice(0, 5) === 'data:') { return 'd' + u.length + ':' + hash(u); }
      var x = new URL(u, D.baseURI);
      if (x.protocol !== 'https:' && x.protocol !== 'http:') { return u; }
      return x.pathname + '|' + (x.searchParams.get('stp') || '');
    } catch (e) { return u; }
  }
  function isStatic(u) { return /\/rsrc\.php\/|\/\/static\.|emoji\.php/.test(u); }

  function urlOf(el) {
    var n = el.localName;
    if (n === 'img') {
      // With a srcset the browser picks the file (currentSrc). Without one the attribute is the truth,
      // even in the moment before the browser has caught up with a change.
      if (el.getAttribute('srcset')) { return el.currentSrc || ''; }
      return el.getAttribute('src') || '';
    }
    if (n === 'image') { return el.getAttribute('href') || el.getAttribute('xlink:href') || ''; }
    var s = el.getAttribute('style') || '';
    var re = /url\(\s*(['"]?)(.*?)\1\s*\)/gi, mm;
    while ((mm = re.exec(s)) !== null) { if (mm[2] && !isStatic(mm[2])) { return mm[2]; } }
    return '';
  }

  // Is this really a tiny icon? Uses the picture's own size, NOT how big it looks right now
  // (a picture inside a carousel / zoom animation can look tiny for a moment).
  // true = icon, false = real picture, null = cannot tell yet.
  function iconSized(el, raw) {
    if (/\.svg(\?|#|$)|^data:image\/svg/i.test(raw)) { return true; }
    var n = el.localName;
    if (n === 'img') {
      var nw = el.naturalWidth, nh = el.naturalHeight;
      if (nw > 0 && nh > 0) { return Math.max(nw, nh) < CFG.iconPx; }
      return null;
    }
    if (n === 'image') {
      var w = parseFloat(el.getAttribute('width')), h = parseFloat(el.getAttribute('height'));
      if (isFinite(w) && isFinite(h) && w > 0 && h > 0) { return Math.max(w, h) < CFG.iconPx; }
      return false;
    }
    var ow = el.offsetWidth || 0, oh = el.offsetHeight || 0;
    if (ow === 0 && oh === 0) { return null; }
    return Math.max(ow, oh) < CFG.iconPx;
  }

  // ------------------------------------------------------------------ state
  var nextEl = 1, nextJob = 1;
  var byId = new Map();      // id -> element
  var visible = new Set();   // elements near the screen
  var jobs = new Map();      // jobId -> job
  var pendKey = new Map();   // key -> jobId (same picture being checked right now)
  var memo = new Map();      // key -> 0 (no woman) / 1 (woman)
  var videos = new Set();
  var useNativeOnly = false, corsFails = 0;
  var io = null;

  function memoPut(key, v) {
    if (memo.size >= CFG.memoMax) { memo.delete(memo.keys().next().value); }
    memo.set(key, v);
  }

  // ------------------------------------------------------------------ show / hide
  function target(el) { return el.localName === 'image' ? (el.closest('svg') || el) : el; }
  function reveal(el) {
    var t = target(el);
    if (t !== el) {
      // an SVG picture is shown only when every picture inside it has passed
      var imgs = t.querySelectorAll('image');
      for (var i = 0; i < imgs.length; i++) {
        var mm = imgs[i].__sg;
        if (!mm || mm.st !== 2) { return; }
      }
    }
    t.setAttribute('data-sgok', '1');
  }
  function unreveal(el) { target(el).removeAttribute('data-sgok'); }

  // ------------------------------------------------------------------ tracking
  function track(el) {
    if (el.__sg) { return; }
    unreveal(el);   // a copied element may carry a "shown" mark that was not earned
    var m = el.__sg = {
      id: nextEl++, raw: null, key: '', st: 0, tries: 0, seq: 0, waitLoad: false,
      vstate: '', clean: 0, vbusy: false, vseq: 0, taint: 0
    };
    byId.set(m.id, el);
    SG.st.seen++;
    if (el.localName === 'video') { videos.add(el); }
    if (io) { io.observe(el); } else { visible.add(el); }
  }

  function onIntersect(entries) {
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      if (e.isIntersecting) { visible.add(e.target); consider(e.target); } else { visible.delete(e.target); }
    }
  }

  // A picture's address changed: hide it again right away, then check the new one.
  function touch(el) {
    var m = el.__sg;
    if (!m) { return; }
    m.raw = null; m.st = 0; m.tries = 0; m.seq++;
    unreveal(el);
    if (el.localName === 'img' && el.getAttribute('srcset')) {
      // the browser has not picked the new file yet; check again once it has loaded
      if (!m.waitLoad) {
        m.waitLoad = true;
        el.addEventListener('load', function () { m.waitLoad = false; consider(el); }, { once: true });
      }
      return;
    }
    consider(el);
  }

  function waitLoad(el, m) {
    m.waitLoad = true;
    el.addEventListener('load', function () { m.waitLoad = false; consider(el); }, { once: true });
  }

  // m.st: 0 new, 1 waiting for answer, 2 clean (shown), 3 woman (stays blurred), 4 error
  function consider(el) {
    var m = el.__sg;
    if (!m || el.localName === 'video') { return; }
    var raw = urlOf(el);
    if (!raw) {
      if (el.localName === 'img' && !el.complete && !m.waitLoad) { waitLoad(el, m); }
      return;
    }
    if (raw === m.raw && m.st !== 0) { return; }
    if (raw !== m.raw) {
      m.raw = raw; m.key = nkey(raw); m.st = 0; m.tries = 0; m.seq++;
      unreveal(el);
    }
    if (isStatic(raw)) { m.st = 2; reveal(el); return; }
    var ic = iconSized(el, raw);
    if (ic === null) { if (el.localName === 'img' && !m.waitLoad) { waitLoad(el, m); } return; }
    if (ic) { m.st = 2; reveal(el); return; }
    var hit = memo.get(m.key);
    if (hit === 0) { m.st = 2; SG.st.memo++; reveal(el); return; }
    if (hit === 1) { m.st = 3; SG.st.memo++; return; }
    var jp = pendKey.get(m.key);
    if (jp !== undefined && jobs.has(jp)) { jobs.get(jp).waiters.push({ el: el, seq: m.seq }); m.st = 1; return; }
    send(el, m, abs(raw));
  }

  // ------------------------------------------------------------------ sending pictures for checking
  function send(el, m, url) {
    var job = nextJob++;
    m.st = 1;
    jobs.set(job, { kind: 'i', key: m.key, waiters: [{ el: el, seq: m.seq }] });
    pendKey.set(m.key, job);
    setTimeout(function () { if (jobs.has(job)) { finishImage(job, 2, 'timeout'); } }, CFG.pendingMs);
    var b = bridge();
    if (!b) { finishImage(job, 2, 'no bridge'); return; }
    if (!useNativeOnly) {
      viaCanvas(url, function (err, b64) {
        if (!jobs.has(job)) { return; }
        if (!err) {
          SG.st.cors++;
          try { b.frame(token, job, b64); } catch (e) { finishImage(job, 2, 'frame ' + e); }
          return;
        }
        corsFails++;
        if (corsFails >= CFG.corsFailLimit && SG.st.cors === 0) { useNativeOnly = true; note('page cannot read pictures (' + err + '); app will download them'); }
        sendNative(job, url);
      });
    } else {
      sendNative(job, url);
    }
  }

  function sendNative(job, url) {
    var b = bridge();
    if (!b || !/^https:/i.test(url)) { finishImage(job, 2, 'cannot send ' + url.slice(0, 40)); return; }
    SG.st.native++;
    try { b.check(token, job, url); } catch (e) { finishImage(job, 2, 'check ' + e); }
  }

  // Load the picture with CORS and draw it small. If the server does not allow it, the
  // picture cannot be read here and the app downloads it instead.
  function viaCanvas(url, cb) {
    var done = false, t = 0;
    var im = new Image();
    var finish = function (err, b64) {
      if (done) { return; }
      done = true; clearTimeout(t); im.onload = null; im.onerror = null;
      cb(err, b64);
    };
    t = setTimeout(function () { finish('timeout'); }, 20000);
    im.onload = function () {
      try {
        var w = im.naturalWidth, h = im.naturalHeight;
        if (!w || !h) { finish('empty'); return; }
        var s = Math.min(1, CFG.imgMax / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
        var c = D.createElement('canvas');
        c.width = cw; c.height = ch;
        c.getContext('2d').drawImage(im, 0, 0, cw, ch);
        finish(null, c.toDataURL('image/jpeg', CFG.imgQuality));
      } catch (e) { finish(String((e && e.name) || e)); }
    };
    im.onerror = function () { finish('load/cors'); };
    im.crossOrigin = 'anonymous';
    im.src = url;
  }

  function finishImage(job, verdict, why) {
    var j = jobs.get(job);
    if (!j) { return; }
    jobs.delete(job);
    if (pendKey.get(j.key) === job) { pendKey.delete(j.key); }
    if (verdict === 0 || verdict === 1) { memoPut(j.key, verdict); }
    for (var i = 0; i < j.waiters.length; i++) {
      var w = j.waiters[i], el = w.el, m = el.__sg;
      if (!m || m.seq !== w.seq) { continue; }
      if (verdict === 0) { m.st = 2; SG.st.ok++; reveal(el); }
      else if (verdict === 1) { m.st = 3; SG.st.female++; }
      else { fail(el, m, why); }
    }
  }

  function fail(el, m, why) {
    m.st = 4; SG.st.err++;
    if (why) { note('picture: ' + why); }
    if (m.tries < CFG.maxTries) {
      var seq = m.seq;
      setTimeout(function () {
        if (el.__sg === m && m.seq === seq && m.st === 4) { m.tries++; m.st = 0; consider(el); }
      }, CFG.retryMs * (m.tries + 1));
    }
  }

  // The app calls this with the answer.
  W.__sgResult = function (tok, job, verdict) {
    if (tok !== token) { return; }
    var j = jobs.get(job);
    if (!j) { return; }
    if (j.kind === 'v') {
      jobs.delete(job);
      var v = j.el, m = v.__sg;
      if (!m || m.vseq !== j.vseq) { return; }
      m.vbusy = false;
      if (verdict === 1) {
        m.vstate = 'female'; v.removeAttribute('data-sgok'); SG.st.female++;
      } else if (verdict === 0) {
        if (m.vstate === 'female') { return; }
        m.clean++;
        m.lastClean = Date.now();
        if (m.clean >= CFG.videoCleanNeeded) {
          if (m.vstate !== 'ok') { SG.st.ok++; }
          m.vstate = 'ok'; v.setAttribute('data-sgok', '1');
        }
      } else { SG.st.err++; }
      return;
    }
    finishImage(job, verdict, 'answer ' + verdict);
  };

  // ------------------------------------------------------------------ videos
  // A video is shown only after it has been sampled clean; one woman's face blurs it for good
  // (until the video source changes).
  function resetVideo(v) {
    var m = v.__sg;
    if (!m) { return; }
    m.vstate = ''; m.clean = 0; m.vbusy = false; m.vseq++; m.taint = 0; m.lastClean = 0;
    v.removeAttribute('data-sgok');
    v.removeAttribute('data-sgreel');
  }
  ['loadstart', 'emptied'].forEach(function (name) {
    D.addEventListener(name, function (e) {
      var v = e.target;
      if (v && v.localName === 'video' && v.__sg) { resetVideo(v); }
    }, true);
  });
  D.addEventListener('seeking', function (e) {
    var v = e.target;
    if (v && v.localName === 'video' && v.__sg && v.__sg.vstate !== 'female') {
      v.__sg.vstate = ''; v.__sg.clean = 0; v.removeAttribute('data-sgok');
    }
  }, true);

  var vTickBusy = false, vc = null;
  function videoTick() {
    var b = bridge();
    if (!b || vTickBusy) { return; }
    vTickBusy = true;
    try {
      var budget = CFG.videoBudget, now = Date.now();
      videos.forEach(function (v) {
        if (!v.isConnected) { videos.delete(v); return; }
        var m = v.__sg;
        if (!m) { return; }
        // tall videos look like Reels: never shown at all
        if (v.videoWidth && v.videoHeight && v.videoHeight / v.videoWidth >= CFG.reelRatio) {
          if (!v.hasAttribute('data-sgreel')) { v.setAttribute('data-sgreel', '1'); SG.st.reelVideos++; }
          m.vstate = 'female';
          v.removeAttribute('data-sgok');
          return;
        }
        // no fresh "clean" answer for a while (slow phone, busy checker): blur again, check again
        if (m.vstate === 'ok' && !v.paused && now - (m.lastClean || 0) > CFG.videoStaleMs) {
          m.vstate = ''; m.clean = 0;
          v.removeAttribute('data-sgok');
        }
        var waiting = m.vbusy && (now - (m.vsent || 0) <= CFG.videoWaitMs);
        if (budget <= 0 || waiting || m.vstate === 'female') { return; }
        if (!visible.has(v)) { return; }
        if (m.vstate === 'ok' && v.paused) { return; }
        if (v.readyState < 2 || !v.videoWidth || !v.videoHeight) { return; }
        budget--;
        sampleVideo(v, m, b);
      });
    } finally { vTickBusy = false; }
  }

  function sampleVideo(v, m, b) {
    try {
      var w = v.videoWidth, h = v.videoHeight;
      var s = Math.min(1, CFG.videoMax / Math.max(w, h));
      var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
      if (!vc) { vc = D.createElement('canvas'); }
      vc.width = cw; vc.height = ch;
      vc.getContext('2d').drawImage(v, 0, 0, cw, ch);
      var b64 = vc.toDataURL('image/jpeg', CFG.videoQuality);
      var job = nextJob++;
      m.vbusy = true;
      m.vsent = Date.now();
      jobs.set(job, { kind: 'v', el: v, vseq: m.vseq });
      setTimeout(function () {
        if (jobs.delete(job) && v.__sg) { v.__sg.vbusy = false; }
      }, 3000);   // a frame that has waited this long is out of date anyway
      SG.st.frames++;
      if (b.vframe) { b.vframe(token, job, b64); } else { b.frame(token, job, b64); }
    } catch (e) {
      m.vbusy = false;
      m.taint++;
      note('video ' + ((e && e.name) || e));
      if (m.taint === 1) { videoCors(v); }
    }
  }

  // Some video files cannot be read until they are loaded again with CORS switched on.
  function videoCors(v) {
    try {
      var src = v.currentSrc || '';
      if (!src || /^(blob:|mediastream:)/.test(src) || v.crossOrigin === 'anonymous') { return; }
      var t = v.currentTime, was = !v.paused;
      v.crossOrigin = 'anonymous';
      v.addEventListener('loadedmetadata', function once() {
        v.removeEventListener('loadedmetadata', once);
        try { v.currentTime = t; } catch (e) { /* ignore */ }
        if (was) { try { var p = v.play(); if (p && p.catch) { p.catch(function () { /* ignore */ }); } } catch (e) { /* ignore */ } }
      });
      v.load();
    } catch (e) { note('video cors ' + e); }
  }

  // ------------------------------------------------------------------ Reels
  var REEL_PATH = /^\/(reel|reels)(\/|$)/i;
  var REEL_LABELS = ['reels', '\u09B0\u09BF\u09B2\u09B8', '\u09B0\u09BF\u09B2', 'reels and short videos'];
  function hideNode(el) {
    el.__sgReel = true;
    el.style.setProperty('display', 'none', 'important');
    SG.st.reels++;
  }
  // The post / shelf that a Reel link belongs to: the biggest parent that is still smaller than the screen.
  function cardOf(a) {
    var c = a.closest('[role="article"],article,[data-pagelet^="FeedUnit"],[data-pagelet*="Reel"]');
    if (c) { return c; }
    var best = a, cur = a.parentElement, lim = (W.innerHeight || 800) * 1.2;
    for (var i = 0; i < 12 && cur && cur !== D.body && cur !== D.documentElement; i++) {
      var r = cur.getBoundingClientRect();
      if (r.height > lim) { break; }
      best = cur; cur = cur.parentElement;
    }
    return best;
  }
  function hideReels(root) {
    try {
      var scope = root || D;
      var as = scope.querySelectorAll('a[href*="/reel"]');
      for (var i = 0; i < as.length; i++) {
        var a = as[i];
        if (a.__sgSeen) { continue; }
        a.__sgSeen = true;
        hideNode(cardOf(a));
      }
      // menu entries / shelf headings that are just the word "Reels"
      var els = scope.querySelectorAll('span,h2,h3,h4,a,[role="heading"]');
      for (var j = 0; j < els.length; j++) {
        var e = els[j];
        if (e.children.length) { continue; }
        var t = (e.textContent || '').trim().toLowerCase();
        if (e.__sgText === t) { continue; }
        e.__sgText = t;
        if (t && t.length <= 30 && REEL_LABELS.indexOf(t) >= 0) {
          var host = e.closest('a,[role="tab"],[role="button"],[role="link"]');
          hideNode(host || cardOf(e));
        }
      }
    } catch (err) { note('reels ' + err); }
  }
  function guardLocation() {
    try { if (REEL_PATH.test(W.location.pathname)) { W.location.replace('/'); } } catch (e) { /* ignore */ }
  }
  try {
    ['pushState', 'replaceState'].forEach(function (k) {
      var orig = W.history[k];
      W.history[k] = function (s, t, url) {
        try { if (url && REEL_PATH.test(new URL(url, W.location.href).pathname)) { return; } } catch (e) { /* ignore */ }
        return orig.apply(this, arguments);
      };
    });
  } catch (e) { /* ignore */ }
  D.addEventListener('click', function (ev) {
    try {
      var a = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
      if (a && REEL_PATH.test(new URL(a.href, W.location.href).pathname)) { ev.preventDefault(); ev.stopPropagation(); }
    } catch (e) { /* ignore */ }
  }, true);

  // ------------------------------------------------------------------ finding pictures
  var SEL = 'img,video,image,[style*="url("]';
  function scanNode(n) {
    if (!n || n.nodeType !== 1) { return; }
    try {
      if (n.matches(SEL)) { track(n); }
      var list = n.querySelectorAll(SEL);
      for (var i = 0; i < list.length; i++) { track(list[i]); }
    } catch (e) { note('scan ' + e); }
  }

  function maintain() {
    ensureCss();
    guardLocation();
    scanNode(D.documentElement);
    hideReels(D);
    byId.forEach(function (el, id) {
      if (!el.isConnected) { byId.delete(id); visible.delete(el); videos.delete(el); return; }
      if (el.localName !== 'video' && visible.has(el)) { consider(el); }
    });
  }

  var started = false;
  function startObservers() {
    if (started) { return; }
    started = true;
    try { io = new IntersectionObserver(onIntersect, { rootMargin: CFG.rootMargin }); } catch (e) { io = null; }
    var queued = new Set(), timer = 0;
    var flush = function () {
      timer = 0;
      var arr = Array.from(queued);
      queued.clear();
      for (var i = 0; i < arr.length; i++) { scanNode(arr[i]); }
      hideReels(D);
    };
    var mo = new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var mu = list[i];
        if (mu.type === 'childList') {
          for (var j = 0; j < mu.addedNodes.length; j++) { queued.add(mu.addedNodes[j]); }
        } else if (mu.type === 'attributes') {
          var t = mu.target, an = mu.attributeName;
          if (!t.__sg) {
            if (t.hasAttribute && t.hasAttribute('data-sgok')) { unreveal(t); }
            if (an !== 'style') { queued.add(t); }
            else {
              var sv = t.getAttribute('style');
              if (sv && sv.indexOf('url(') >= 0) { queued.add(t); }
            }
          } else if (t.localName === 'video') {
            if (an === 'src') { resetVideo(t); }
          } else if (an === 'style') {
            consider(t);   // does something only when the picture inside the style really changed
          } else {
            touch(t);
          }
        }
      }
      if (!timer && queued.size) { timer = setTimeout(flush, 120); }
    });
    mo.observe(D.documentElement, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['src', 'srcset', 'href', 'xlink:href', 'style']
    });
    scanNode(D.documentElement);
    D.addEventListener('DOMContentLoaded', function () { scanNode(D.documentElement); hideReels(D); });
    setInterval(maintain, CFG.maintainMs);
    setInterval(videoTick, CFG.videoEveryMs);
  }

  // For the "Status" screen in the app.
  SG.dump = function () {
    return JSON.stringify({
      st: SG.st, errs: SG.errs.slice(-6), tracked: byId.size, visible: visible.size,
      jobs: jobs.size, memo: memo.size, appDownloadsOnly: useNativeOnly
    });
  };

  // ------------------------------------------------------------------ start
  guardLocation();
  var bootTries = 0;
  (function boot() {
    if (!D.documentElement) { if (bootTries++ < 600) { setTimeout(boot, 5); } return; }
    ensureCss();
    startObservers();
  })();
})();
