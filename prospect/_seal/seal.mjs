#!/usr/bin/env node
/*
 * Seals the private half of /prospect.
 *
 * This repo is public, so anything committed here can be read by anyone,
 * whatever the page's password prompt says. The video, the slides and every
 * word shown after the password are therefore stored only as ciphertext:
 * AES-256-GCM under a key derived from the password with PBKDF2-SHA256.
 * The browser derives the same key from what the visitor types and decrypts
 * in memory. A wrong password fails the GCM check, so no verifier is stored.
 *
 * Usage, from the repo root:
 *   node prospect/_seal/seal.mjs            reads prospect/_private/password.txt
 *   PROSPECT_PASSWORD='...' node prospect/_seal/seal.mjs
 *
 * Reads   prospect/_private/config.json and the files it names (gitignored).
 * Writes  prospect/vault/lock.json   public: KDF salt and the manifest's name
 *         prospect/vault/*.bin       ciphertext only
 *
 * Re-running with the same password keeps the salt, so unchanged files keep
 * their names and are not re-committed. A new password starts over.
 * Jekyll skips folders that start with "_", so this script and _private/
 * never reach the published site.
 */

import { webcrypto as crypto } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.resolve(HERE, '..');
const REPO = path.resolve(PAGE, '..');
const PRIVATE = path.join(PAGE, '_private');
const VAULT = path.join(PAGE, 'vault');

const ITERATIONS = 600_000;           // OWASP's 2023 floor for PBKDF2-SHA256
const AAD = new TextEncoder().encode('cardinal-prospect/v1');
const GITHUB_FILE_LIMIT = 100 * 1024 * 1024;
const WARN_BYTES = 60 * 1024 * 1024;  // above this the video takes a while to open

// Must match norm() in index.html: forgiving of case, spaces and punctuation.
const norm = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]/g, '');

function fail(msg) {
  console.error(`seal: ${msg}`);
  process.exit(1);
}

function mustBeIgnored(p) {
  try {
    execFileSync('git', ['check-ignore', '-q', p], { cwd: REPO });
  } catch {
    fail(`${path.relative(REPO, p)} is not gitignored. Refusing to run, since it holds the plaintext.`);
  }
}

async function deriveKeys(password, salt) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS }, base, 512));
  const aes = await crypto.subtle.importKey('raw', bits.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  // A second key names the files, so a name reveals nothing about the contents.
  const ids = await crypto.subtle.importKey('raw', bits.slice(32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return { aes, ids };
}

async function seal(aes, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, aes, bytes));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

async function unseal(aes, bytes) {
  return new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: AAD }, aes, bytes.slice(12)));
}

async function nameFor(ids, bytes) {
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', ids, bytes));
  return Buffer.from(mac).toString('hex').slice(0, 24) + '.bin';
}

function probeDuration(file) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
    const s = Number.parseFloat(out);
    return Number.isFinite(s) ? Math.round(s) : null;
  } catch {
    return null;   // ffprobe missing: the page reads the length off the video instead
  }
}

function mimeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4' }[ext]
    || fail(`no content type for ${file}`);
}

async function main() {
  mustBeIgnored(PRIVATE);

  let password = process.env.PROSPECT_PASSWORD;
  const pwFile = path.join(PRIVATE, 'password.txt');
  if (!password && fs.existsSync(pwFile)) password = fs.readFileSync(pwFile, 'utf8').trim();
  if (!password) fail('no password: set PROSPECT_PASSWORD or write prospect/_private/password.txt');
  const key = norm(password);
  if (key.length < 12) fail('password is too short once spaces and punctuation are dropped (12+ letters or digits)');

  const config = JSON.parse(fs.readFileSync(path.join(PRIVATE, 'config.json'), 'utf8'));
  fs.mkdirSync(VAULT, { recursive: true });

  // Keep the salt when the password is unchanged, so unchanged files keep their names.
  const lockPath = path.join(VAULT, 'lock.json');
  let salt = null;
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const oldSalt = Buffer.from(lock.kdf.salt, 'base64');
    const oldManifest = path.join(VAULT, lock.manifest);
    if (lock.kdf.iterations === ITERATIONS && fs.existsSync(oldManifest)) {
      const { aes } = await deriveKeys(key, oldSalt);
      try {
        await unseal(aes, new Uint8Array(fs.readFileSync(oldManifest)));
        salt = new Uint8Array(oldSalt);
      } catch { /* different password: start over with a fresh salt */ }
    }
  }
  const reused = salt !== null;
  if (!salt) salt = crypto.getRandomValues(new Uint8Array(16));
  const { aes, ids } = await deriveKeys(key, salt);

  const keep = new Set(['lock.json']);
  let written = 0;

  async function put(relFile) {
    const src = path.join(PRIVATE, relFile);
    if (!fs.existsSync(src)) fail(`missing ${path.relative(REPO, src)}`);
    const bytes = new Uint8Array(fs.readFileSync(src));
    if (bytes.length + 28 >= GITHUB_FILE_LIMIT) fail(`${relFile} is over GitHub's 100 MB file limit; re-encode it smaller`);
    if (bytes.length > WARN_BYTES) console.warn(`seal: ${relFile} is ${(bytes.length / 1048576).toFixed(0)} MB; it downloads in full before it plays`);
    const name = await nameFor(ids, bytes);
    keep.add(name);
    if (!fs.existsSync(path.join(VAULT, name))) {
      fs.writeFileSync(path.join(VAULT, name), await seal(aes, bytes));
      written++;
    }
    return { src: name, type: mimeFor(relFile), bytes: bytes.length };
  }

  // Everything the page shows after the password lives in this manifest.
  const manifest = {
    v: 1,
    sealed: new Date().toISOString().slice(0, 10),
    header: config.header,
    closing: config.closing,
    signature: config.signature,
    role: config.role,
    email: config.email,
    site: config.site,
    footer: config.footer,
    video: null,
    deck: { label: config.deckLabel || 'From the deck', slides: [] },
  };

  const v = config.video || {};
  if (v.youtube || v.vimeo) {
    manifest.video = { kind: v.youtube ? 'youtube' : 'vimeo', url: v.youtube || v.vimeo, caption: v.caption || null };
  } else if (v.file) {
    const file = await put(v.file);
    manifest.video = {
      kind: 'file',
      ...file,
      poster: v.poster ? await put(v.poster) : null,
      seconds: v.seconds ?? probeDuration(path.join(PRIVATE, v.file)),
      caption: v.caption || null,
    };
  }

  for (const s of config.slides || []) {
    manifest.deck.slides.push({ ...(await put(s.file)), title: s.title });
  }

  // The manifest gets a fresh name every run, so no browser serves a stale one.
  const manifestName = 'm' + Buffer.from(crypto.getRandomValues(new Uint8Array(10))).toString('hex') + '.bin';
  fs.writeFileSync(path.join(VAULT, manifestName), await seal(aes, new TextEncoder().encode(JSON.stringify(manifest))));
  keep.add(manifestName);

  fs.writeFileSync(lockPath, JSON.stringify({
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: Buffer.from(salt).toString('base64') },
    manifest: manifestName,
  }, null, 2) + '\n');

  let removed = 0;
  for (const f of fs.readdirSync(VAULT)) {
    if (!keep.has(f)) { fs.unlinkSync(path.join(VAULT, f)); removed++; }
  }

  const total = [...keep].reduce((n, f) => n + fs.statSync(path.join(VAULT, f)).size, 0);
  console.log(`sealed ${manifest.deck.slides.length} slides${manifest.video ? ` and a ${manifest.video.kind} video` : ''}`);
  console.log(`vault: ${keep.size} files, ${(total / 1048576).toFixed(1)} MB; ${written} newly encrypted, ${removed} removed; salt ${reused ? 'kept' : 'new'}`);
  // The part after # never leaves the browser: it is not sent to GitHub or logged.
  console.log(`link:  ${config.site || 'https://cardinalcapital.xyz'}/prospect/#${encodeURIComponent(password.trim())}`);
}

main().catch((e) => fail(e.stack || String(e)));
