/* Safe Feed - hidden face-check page.
 * For every job the app has a small JPEG ready at /job?id=N. This page looks for faces,
 * guesses the gender of each one (all on the phone, nothing is sent anywhere) and tells
 * the app:  0 = no woman's face   1 = a woman's face   2 = could not check
 */
(function () {
  'use strict';

  var CFG = {
    score: 0.25,       // how sure the detector must be that something is a face (low = more careful)
    female: 0.20,      // chance of "woman" from which a face counts as a woman (low = more careful)
    bigFrom: 480,      // pictures at least this big get extra, bigger looks (finds small faces)
    avatarMax: 256,    // small, nearly square pictures are treated like profile photos
    models: '/assets/ml/models'
  };

  var queue = [];
  var running = false;
  var ready = false;
  var canvas = document.createElement('canvas');

  function nReady(s) { try { window.MlBridge.ready(String(s)); } catch (e) { /* ignore */ } }
  function nFail(s) { try { window.MlBridge.fail(String(s).slice(0, 300)); } catch (e) { /* ignore */ } }
  function nLog(s) { try { window.MlBridge.log(String(s).slice(0, 300)); } catch (e) { /* ignore */ } }
  function nResult(id, v, info) { try { window.MlBridge.result(id, v, String(info || '')); } catch (e) { /* ignore */ } }

  // Chance (0..1) that this face is a woman's. Unknown -> treated as a woman (stay blurred).
  function femaleScore(r) {
    var p = Number(r && r.genderProbability);
    if (!isFinite(p)) { return 1; }
    return r.gender === 'female' ? p : 1 - p;
  }
  function anyFemale(list) {
    for (var i = 0; i < list.length; i++) {
      if (femaleScore(list[i]) >= CFG.female) { return true; }
    }
    return false;
  }

  // fill = how much of the canvas the picture's long side covers (below 1 = grey border around it,
  // which makes faces that fill the whole picture smaller and easier for the detector)
  function canvasFor(src, size, fill) {
    if (canvas.width !== size || canvas.height !== size) { canvas.width = size; canvas.height = size; }
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, size, size);
    var s = (size * (fill || 1)) / Math.max(src.width, src.height);
    var dw = Math.max(1, Math.round(src.width * s));
    var dh = Math.max(1, Math.round(src.height * s));
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, Math.floor((size - dw) / 2), Math.floor((size - dh) / 2), dw, dh);
    return canvas;
  }

  async function detect(cv, size) {
    var fa = window.faceapi;
    var opts = new fa.TinyFaceDetectorOptions({ inputSize: size, scoreThreshold: CFG.score });
    return await fa.detectAllFaces(cv, opts).withAgeAndGender();
  }

  // Which looks to take: [canvas size, fill]
  function planFor(w, h, video) {
    var mx = Math.max(w, h), ratio = w / h;
    if (video) { return { avatar: false, passes: [[320, 1.0], [320, 0.55]] }; }
    if (mx <= CFG.avatarMax && ratio >= 0.7 && ratio <= 1.43) {
      return { avatar: true, passes: [[320, 1.0], [320, 0.6], [320, 0.42]] };
    }
    if (mx >= CFG.bigFrom) { return { avatar: false, passes: [[320, 1.0], [512, 1.0], [608, 1.0]] }; }
    return { avatar: false, passes: [[320, 1.0]] };
  }

  async function runJob(id, video) {
    var r = await fetch('/job?id=' + id, { cache: 'no-store' });
    if (!r.ok) { throw new Error('job fetch ' + r.status); }
    var blob = await r.blob();
    var bmp = await createImageBitmap(blob);
    try {
      var plan = planFor(bmp.width, bmp.height, video);
      var sawFace = false;
      for (var i = 0; i < plan.passes.length; i++) {
        var size = plan.passes[i][0];
        var res = await detect(canvasFor(bmp, size, plan.passes[i][1]), size);
        if (res.length) { sawFace = true; }
        if (anyFemale(res)) { return 1; }
      }
      // a small square picture (profile photo) where no face could be found: stay blurred to be safe
      if (plan.avatar && !sawFace) { return 1; }
      return 0;
    } finally {
      if (bmp && bmp.close) { bmp.close(); }
    }
  }

  async function pump() {
    if (running || !ready) { return; }
    running = true;
    try {
      while (queue.length) {
        var item = queue.shift();
        var verdict = 2, info = '';
        try { verdict = await runJob(item.id, item.video); } catch (e) { info = String((e && e.message) || e); }
        nResult(item.id, verdict, info);
      }
    } finally { running = false; }
  }

  // priority = 1: video frames jump the queue (a video keeps playing while it waits)
  window.mlRun = function (id, priority) {
    var item = { id: id, video: priority === 1 };
    if (item.video) { queue.unshift(item); } else { queue.push(item); }
    pump();
  };

  async function init() {
    var fa = window.faceapi;
    if (!fa) { throw new Error('faceapi.js did not load'); }
    var backend = 'default';
    try {
      await fa.tf.setBackend('webgl');
      await fa.tf.ready();
      backend = fa.tf.getBackend();
    } catch (e) {
      nLog('webgl not available (' + e + '), using cpu');
      await fa.tf.setBackend('cpu');
      await fa.tf.ready();
      backend = fa.tf.getBackend();
    }
    await fa.nets.tinyFaceDetector.loadFromUri(CFG.models);
    await fa.nets.ageGenderNet.loadFromUri(CFG.models);
    ready = true;
    nReady('backend=' + backend);
    pump();
  }

  window.__mlCore = { anyFemale: anyFemale, femaleScore: femaleScore, cfg: CFG };

  init().catch(function (e) { nFail((e && e.message) || e); });
})();
