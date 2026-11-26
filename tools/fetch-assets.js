#!/usr/bin/env node
/* Downloads the free face-detection library and its two small models (the build runs this).
 * Source: npm package @vladmandic/face-api (pinned version). Falls back to the jsDelivr copy of the same package.
 * Result: app/src/main/assets/ml/faceapi.js and app/src/main/assets/ml/models/*
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PKG = '@vladmandic/face-api';
const VER = process.env.FACEAPI_VERSION || '1.7.15';
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'app', 'src', 'main', 'assets', 'ml');
const MODELS = ['tiny_face_detector_model', 'age_gender_model'];
const CDN = (process.env.FACEAPI_CDN || ('https://cdn.jsdelivr.net/npm/' + PKG + '@' + VER)).replace(/\/$/, '');

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// A weights manifest is a list of groups, or an object holding that list under weightsManifest.
function groupsOf(manifest) {
  if (Array.isArray(manifest)) return manifest;
  if (manifest && Array.isArray(manifest.weightsManifest)) return manifest.weightsManifest;
  throw new Error('unknown manifest format');
}

function checkOutputs() {
  const lib = path.join(OUT, 'faceapi.js');
  if (!fs.existsSync(lib) || fs.statSync(lib).size < 300000) throw new Error('faceapi.js missing or too small');
  if (!fs.readFileSync(lib, 'utf8').includes('TinyFaceDetectorOptions')) throw new Error('faceapi.js looks wrong');
  for (const m of MODELS) {
    const mf = path.join(OUT, 'models', m + '-weights_manifest.json');
    if (!fs.existsSync(mf)) throw new Error('missing ' + mf);
    const manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
    let shards = 0;
    for (const group of groupsOf(manifest)) {
      for (const p of group.paths) {
        const f = path.join(OUT, 'models', p);
        if (!fs.existsSync(f) || fs.statSync(f).size < 10000) throw new Error('missing/small ' + f);
        shards++;
      }
    }
    if (!shards) throw new Error('no weight files in ' + mf);
  }
}

function viaNpm() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'faceapi-'));
  execFileSync('npm', ['pack', PKG + '@' + VER, '--silent'], { cwd: tmp, stdio: ['ignore', 'ignore', 'inherit'] });
  const tgz = fs.readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no file');
  execFileSync('tar', ['-xzf', tgz], { cwd: tmp });
  const pk = path.join(tmp, 'package');
  ensureDir(path.join(OUT, 'models'));
  fs.copyFileSync(path.join(pk, 'dist', 'face-api.js'), path.join(OUT, 'faceapi.js'));
  for (const m of MODELS) {
    const manifestName = m + '-weights_manifest.json';
    const src = path.join(pk, 'model', manifestName);
    fs.copyFileSync(src, path.join(OUT, 'models', manifestName));
    for (const group of groupsOf(JSON.parse(fs.readFileSync(src, 'utf8')))) {
      for (const p of group.paths) fs.copyFileSync(path.join(pk, 'model', p), path.join(OUT, 'models', p));
    }
  }
}

async function get(url, tries) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + url);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      last = e;
      await new Promise((res) => setTimeout(res, 2000 * (i + 1)));
    }
  }
  throw last;
}

async function viaCdn() {
  ensureDir(path.join(OUT, 'models'));
  fs.writeFileSync(path.join(OUT, 'faceapi.js'), await get(CDN + '/dist/face-api.js', 3));
  for (const m of MODELS) {
    const manifestName = m + '-weights_manifest.json';
    const buf = await get(CDN + '/model/' + manifestName, 3);
    fs.writeFileSync(path.join(OUT, 'models', manifestName), buf);
    for (const group of groupsOf(JSON.parse(buf.toString('utf8')))) {
      for (const p of group.paths) fs.writeFileSync(path.join(OUT, 'models', p), await get(CDN + '/model/' + p, 3));
    }
  }
}

(async () => {
  try {
    viaNpm();
    checkOutputs();
    console.log('face-detection files ready (npm)');
    return;
  } catch (e) {
    console.log('npm route failed: ' + e.message + ' -> trying CDN');
  }
  fs.rmSync(OUT + '/faceapi.js', { force: true });
  fs.rmSync(OUT + '/models', { recursive: true, force: true });
  await viaCdn();
  checkOutputs();
  console.log('face-detection files ready (CDN)');
})().catch((e) => {
  console.error('FAILED to fetch face-detection files: ' + e.message);
  process.exit(1);
});
