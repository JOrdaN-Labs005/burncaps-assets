#!/usr/bin/env node
// Does the live site work for a customer? (8 Nov 2026.) A build made with the
// export gate's fake key reached production; the health check and /api/pass
// both still answered as expected, and every export failed for hours. Only the
// page itself can show that: its public key has to match the server's key.
//
// Headless Chrome opens a small file on the site (no visit counted, no tracker
// loaded), asks /api/pass for a pass on the sample's file id (never counted, no
// free video used) and runs the page's own readPass and passAllows. The server
// is checked first: home page, the four settings in health, /api/pass alive.
//
//   node tools/live-pass-check.mjs [--site https://burncaps.app] [--page-only]
//   exit 0: the site works. exit 1: it does not.
//
// Two callers, one file: `npm run deploy` (tools/deploy.mjs) and the watcher
// outside this Mac (tools/watch/watch.mjs). `node tools/watch-sync.mjs` copies
// it to the watcher, and tools/deploy-guard.mjs refuses a deploy when the two
// copies differ. Standard library only, it also runs on GitHub's machines.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE = 'https://burncaps.app';
const SAMPLE_FILE = '000000000000000000000003'; // netlify/functions/pass.mjs SAMPLE_ID
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// siteDown: the site itself does not answer, so going back to an older version
// would not help (Netlify out of credits, a Netlify outage, no network).
export async function checkServer(site = SITE) {
  const call = (p, init = {}) => fetch(site + p, { redirect: 'manual', signal: AbortSignal.timeout(25000), ...init });
  let home;
  try { home = await call('/', { method: 'HEAD' }); }
  catch (err) { return { ok: false, siteDown: true, why: `the home page did not answer (${err.message})` }; }
  if (home.status !== 200) return { ok: false, siteDown: true, why: `the home page answered ${home.status}` };
  const problems = [];
  try {
    const r = await call('/api/activate?health=1');
    const j = r.ok ? await r.json() : null;
    const off = j ? Object.entries(j).filter(([, v]) => v !== true).map(([k]) => k) : [];
    if (!j) problems.push(`health answered ${r.status}`);
    else if (Object.keys(j).length < 4) problems.push('health answered too few settings');
    else if (off.length) problems.push(`health says these are missing: ${off.join(', ')}`);
  } catch (err) { problems.push(`health did not answer (${err.message})`); }
  try {
    const r = await call('/api/pass', { method: 'POST' });
    if (r.status !== 400) problems.push(`/api/pass answered ${r.status} to an empty request (400 expected)`);
  } catch (err) { problems.push(`/api/pass did not answer (${err.message})`); }
  return { ok: !problems.length, siteDown: false, why: problems.join('; ') };
}

export async function checkPage(site = SITE) {
  const chromePath = process.env.CHROME_PATH || (existsSync(MAC_CHROME) ? MAC_CHROME : 'google-chrome');
  const profile = mkdtempSync(path.join(os.tmpdir(), 'bc-live-pass-'));
  const flags = ['--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--remote-debugging-port=0', 'about:blank'];
  if (process.platform === 'linux') flags.unshift('--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
  const chrome = spawn(chromePath, flags, { stdio: 'ignore' });
  let ws;
  const finish = (result) => {
    try { ws && ws.close(); } catch {}
    try { chrome.kill('SIGKILL'); } catch {}
    setTimeout(() => { try { rmSync(profile, { recursive: true, force: true }); } catch {} }, 300);
    return result;
  };
  const work = async () => {
    let port;
    for (let i = 0; i < 80 && !port; i++) {
      try { port = Number(readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch {}
      if (!port) await sleep(250);
    }
    if (!port) return { ok: false, why: 'Chrome did not start' };
    let target;
    for (let i = 0; i < 40 && !target; i++) {
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch {}
      if (!target) await sleep(250);
    }
    if (!target) return { ok: false, why: 'Chrome did not open a page' };
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('no connection to Chrome')); });
    let id = 0;
    const waiting = new Map();
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; waiting.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Page.enable');
    await send('Page.navigate', { url: `${site}/robots.txt?src=owner` });
    for (let i = 0; i < 60; i++) {
      const s = await send('Runtime.evaluate', { expression: 'location.origin + "|" + document.readyState', returnByValue: true });
      const v = String(s.result?.result?.value || '');
      if (v.startsWith(site) && v.endsWith('|complete')) break;
      await sleep(250);
    }
    const expression = `(async () => {
      const a = await import('/js/account.js'), p = await import('/js/pass.js');
      const device = a.deviceInfo().id, file = ${JSON.stringify(SAMPLE_FILE)};
      const r = await fetch('/api/pass', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device, file, mode: 'whole' }) });
      const j = await r.json();
      return JSON.stringify({ status: r.status, signed: !!(await p.readPass(j.pass)), allows: await p.passAllows(j.pass, file) });
    })()`;
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    const value = res.result?.result?.value;
    if (!value) return { ok: false, why: `the page could not run the check: ${res.result?.exceptionDetails?.exception?.description || 'no value'}` };
    const o = JSON.parse(value);
    if (o.status === 200 && o.signed && o.allows) return { ok: true, why: '' };
    return { ok: false, why: `the live page refuses its own export passes, every export is failing (${value})` };
  };
  const timeout = sleep(75000).then(() => ({ ok: false, why: 'the page check got no answer in 75 s' }));
  try { return finish(await Promise.race([work(), timeout])); }
  catch (err) { return finish({ ok: false, why: `the page check broke: ${err.message}` }); }
}

export async function liveCheck(site = SITE, { pageOnly = false } = {}) {
  const server = pageOnly ? { ok: true, siteDown: false, why: '' } : await checkServer(site);
  if (server.siteDown) return server;
  const page = await checkPage(site);
  return { ok: server.ok && page.ok, siteDown: false, why: [server.why, page.why].filter(Boolean).join('; ') };
}

// A failure must hold on every try: one dropped connection is not an outage.
export async function liveCheckRetried(site = SITE, { tries = 3, gapMs = 30000, pageOnly = false } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    if (i) await sleep(gapMs);
    last = await liveCheck(site, { pageOnly });
    if (last.ok) return last;
  }
  return last;
}

const isMain = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  const at = process.argv.indexOf('--site');
  const site = at > 0 ? process.argv[at + 1] : SITE;
  const r = await liveCheckRetried(site, { tries: 2, gapMs: 15000, pageOnly: process.argv.includes('--page-only') });
  if (r.ok) console.log('live-pass-check: PASSED: the site answers and the live page accepts a real export pass');
  else console.error(`live-pass-check: FAILED: ${r.why}`);
  process.exit(r.ok ? 0 : 1);
}
