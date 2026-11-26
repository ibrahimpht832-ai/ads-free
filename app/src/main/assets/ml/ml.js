/* Safe Feed - hidden face-check page.
 * For every job the app has a small JPEG ready at /job?id=N. This page looks for faces,
 * guesses the gender of each one (all on the phone, nothing is sent anywhere) and tells
 * the app:  0 = no woman's face   1 = a woman's face   2 = could not check
 */
(function () {
  'use strict';

  var CFG = {
    small: 320,        // first look: whole picture at 320 px
    big: 512,          // second look (bigger pictures only): helps to find small faces
    bigFrom: 480,      // pictures at least this big get the second look
    score: 0.3,        // how sure the detector must be that something is a face (low = more careful)
    female: 0.3,       // chance of "woman" from which a face counts as a woman (low = more careful)
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

  function canvasFor(src, size) {
    if (canvas.width !== size || canvas.height !== size) { canvas.width = size; canvas.height = size; }
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, size, size);
    var s = size / Math.max(src.width, src.height);
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

  async function runJob(id) {
    var r = await fetch('/job?id=' + id, { cache: 'no-store' });
    if (!r.ok) { throw new Error('job fetch ' + r.status); }
    var blob = await r.blob();
    var bmp = await createImageBitmap(blob);
    try {
      var res = await detect(canvasFor(bmp, CFG.small), CFG.small);
      if (anyFemale(res)) { return 1; }
      if (Math.max(bmp.width, bmp.height) >= CFG.bigFrom) {
        res = await detect(canvasFor(bmp, CFG.big), CFG.big);
        if (anyFemale(res)) { return 1; }
      }
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
        var id = queue.shift();
        var verdict = 2, info = '';
        try { verdict = await runJob(id); } catch (e) { info = String((e && e.message) || e); }
        nResult(id, verdict, info);
      }
    } finally { running = false; }
  }

  window.mlRun = function (id) { queue.push(id); pump(); };

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
