'use strict';

// Fetch the Whisper model that ships inside the app (local transcription's
// default engine) into resources/models, where electron-builder picks it up
// as an extraResources entry (<resources>/models in the packaged app).
//
//   npm run fetch:whisper                    the bundled default (base.en, ~80 MB)
//   node tools/fetch-whisper-model.cjs --model large   the optional larger one
//   ... --out <dir>                          somewhere else
//
// Run it before `npm run dist*` in a release build. It is deliberately NOT part
// of `npm run build`: dev builds and CI test runs should not pull 80 MB, and an
// app without the bundled copy downloads the same files on first use.
//
// Files come from a pinned Hugging Face commit and are verified against the
// catalog (src/main/features/transcribe/models.json, shared with the app):
// sha256 for the ONNX weights, the git blob id for the small JSON files. A file
// already present at the right size and hash is kept; nothing unverified is
// ever left under its final name.

const { createHash } = require('node:crypto');
const { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } = require('node:fs');
const { dirname, join, resolve } = require('node:path');

const ROOT = join(__dirname, '..');
const catalog = JSON.parse(readFileSync(join(ROOT, 'src/main/features/transcribe/models.json'), 'utf8'));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const which = arg('model', 'base');
const outRoot = resolve(ROOT, arg('out', 'resources/models'));
const spec = catalog.models[which];
if (!spec) {
  console.error(`[fetch-whisper] unknown model "${which}" (known: ${Object.keys(catalog.models).join(', ')})`);
  process.exit(2);
}

function hasher(file) {
  if (file.sha256) {
    const h = createHash('sha256');
    return { update: (c) => h.update(c), ok: () => h.digest('hex') === file.sha256 };
  }
  const h = createHash('sha1');
  h.update(`blob ${file.size}\0`);
  return { update: (c) => h.update(c), ok: () => h.digest('hex') === file.gitOid };
}

function verifyExisting(path, file) {
  try {
    if (statSync(path).size !== file.size) return false;
  } catch {
    return false;
  }
  const v = hasher(file);
  v.update(readFileSync(path));
  return v.ok();
}

async function download(url, part, file) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const v = hasher(file);
  const out = createWriteStream(part);
  let got = 0;
  let lastLog = 0;
  for await (const chunk of res.body) {
    got += chunk.byteLength;
    if (got > file.size) throw new Error(`${file.path}: larger than expected`);
    v.update(chunk);
    if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
    if (file.size > 5e6 && Date.now() - lastLog > 2000) {
      lastLog = Date.now();
      process.stdout.write(`  ${file.path} ${Math.round((got / file.size) * 100)}%\n`);
    }
  }
  await new Promise((r, j) => out.end((e) => (e ? j(e) : r())));
  if (got !== file.size || !v.ok()) throw new Error(`${file.path}: checksum mismatch`);
}

(async () => {
  const dir = join(outRoot, ...spec.repo.split('/'));
  const total = spec.files.reduce((n, f) => n + f.size, 0);
  console.log(`[fetch-whisper] ${spec.repo}@${spec.revision.slice(0, 8)} (${(total / 1e6).toFixed(1)} MB) -> ${dir}`);
  for (const file of spec.files) {
    const target = join(dir, ...file.path.split('/'));
    if (existsSync(target) && verifyExisting(target, file)) {
      console.log(`  ok   ${file.path}`);
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    const part = `${target}.part`;
    rmSync(part, { force: true });
    const url = `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${file.path}`;
    try {
      await download(url, part, file);
    } catch (e) {
      rmSync(part, { force: true });
      throw e;
    }
    renameSync(part, target);
    console.log(`  got  ${file.path}`);
  }
  console.log('[fetch-whisper] done');
})().catch((e) => {
  console.error(`[fetch-whisper] failed: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
