// The watcher outside the Mac (Milan, 8 Nov 2026, ASK 185: "even if I or the Mac
// is available or not this issue should not happen"). GitHub runs it every ten
// minutes. It does what a customer's browser does on the live site; if a new
// version broke that, it puts the last good version back by itself and says so.
//
// Source of truth: tools/watch/ in the private repo. `node tools/watch-sync.mjs`
// copies it to the public repo burncaps-assets, where GitHub's minutes are free.
// Nothing here is secret: the Netlify key and the push channel are GitHub secrets.
//
// When the site fails it asks three things before touching anything:
//   Is the site itself down?  Going back cannot help: tell Milan and stop.
//   Is the live version the one that last passed?  Then the deploy is not the
//     cause: tell Milan and stop.
//   Have I already undone this version?  One undo per bad version, never a loop.
//
// It remembers on the branch `watch-state` (state.json): the last good deploy,
// a heartbeat the hourly server alarm reads (so a dead watcher is noticed), and
// the incidents, which tools/customer-notes.mjs prints for the desks.

const REPEAT_MS = 2 * 3600e3;
const BEAT_MS = 55 * 60e3;
const UNDO_MEMORY_MS = 24 * 3600e3;

// What to do, as a plain function of what was seen.
export function decide({ result, token, deployId, state, now }) {
  if (result.ok) {
    if (token && !deployId) return { action: 'alert', kind: 'key-dead' };
    return { action: 'ok', newGood: deployId && deployId !== state.good ? deployId : '' };
  }
  if (result.siteDown) return { action: 'alert', kind: 'site-down' };
  if (result.inconclusive) return { action: 'alert', kind: 'inconclusive' };
  if (!token) return { action: 'alert', kind: 'no-key' };
  if (!deployId) return { action: 'alert', kind: 'no-deploy-id' };
  if (!state.good) return { action: 'alert', kind: 'no-good-version' };
  if (deployId === state.good) return { action: 'alert', kind: 'not-the-deploy' };
  const last = state.lastRollback;
  if (last && last.from === deployId && now - last.at < UNDO_MEMORY_MS) return { action: 'alert', kind: 'undo-did-not-help' };
  return { action: 'rollback', to: state.good };
}

// Adds an incident; true when Milan should be told (at most once per kind in two hours).
export function record(state, incident, { always = false } = {}) {
  state.incidents ??= [];
  state.alerted ??= {};
  const last = state.alerted[incident.kind] || 0;
  const tell = always || !last || incident.at - last >= REPEAT_MS;
  if (tell) {
    state.alerted[incident.kind] = incident.at;
    state.incidents.push({ ...incident, at: new Date(incident.at).toISOString() });
    state.incidents = state.incidents.slice(-30);
  }
  return tell;
}

const WORDS = {
  'site-down': (w) => `Burncaps is not answering: ${w}. Going back to an older version would not help, so nothing was changed.`,
  'key-dead': () => 'Burncaps is working, but Netlify refused the watcher\'s key, so the watcher can no longer undo a bad version. Make a new key.',
  inconclusive: (w) => `The watcher could not tell whether Burncaps works, so it changed nothing: ${w}`,
  'bad-target': (w) => `Burncaps is failing and the version the watcher would go back to is not a production version, so it changed nothing: ${w}`,
  'no-key': (w) => `Burncaps is failing and the watcher has no Netlify key, so it could not undo it: ${w}`,
  'no-deploy-id': (w) => `Burncaps is failing and Netlify refused the watcher's key, so it could not undo it: ${w}`,
  'no-good-version': (w) => `Burncaps is failing and the watcher has no earlier good version to go back to: ${w}`,
  'not-the-deploy': (w) => `Burncaps is failing but the live version is the one that last passed, so the cause is elsewhere. Nothing was changed: ${w}`,
  'undo-did-not-help': (w) => `Burncaps is still failing after the watcher went back to the last good version: ${w}`,
  rollback: (w, i) => (i.fixed ? `A bad version of Burncaps went live. The watcher put the last good version back and exports work again. What failed: ${w}` : `A bad version of Burncaps went live. The watcher went back to the last good version and the site still fails: ${w}`),
};

async function main() {
  // Beside this file in the public repo; loaded here so the tests can read the rules alone.
  const { liveCheckRetried, SITE } = await import('./live-pass-check.mjs');
  const repo = process.env.GITHUB_REPOSITORY;
  const siteId = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN || '';
  const gh = (p, init = {}) => fetch(`https://api.github.com/repos/${repo}${p}`, { ...init, headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'burncaps-watch' }, signal: AbortSignal.timeout(30000) });
  const netlify = (p, init = {}) => fetch(`https://api.netlify.com/api/v1${p}`, { ...init, headers: { authorization: `Bearer ${token}`, 'user-agent': 'burncaps-watch' }, signal: AbortSignal.timeout(30000) });

  // The state branch.
  const BRANCH = 'watch-state';
  let state = {}, sha;
  let read = await gh(`/contents/state.json?ref=${BRANCH}`);
  if (read.status === 404) {
    const refs = await gh(`/git/ref/heads/${BRANCH}`);
    if (refs.status === 404) {
      const main = await (await gh('/git/ref/heads/main')).json();
      await gh('/git/refs', { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: main.object.sha }) });
    }
  } else if (read.ok) {
    const j = await read.json();
    sha = j.sha;
    state = JSON.parse(Buffer.from(j.content, 'base64').toString('utf8'));
  } else throw new Error(`could not read the state: ${read.status}`);
  const before = JSON.stringify(state);
  const save = async (now) => {
    const body = { message: `watch ${new Date(now).toISOString()}`, content: Buffer.from(JSON.stringify(state, null, 1)).toString('base64'), branch: BRANCH, ...(sha ? { sha } : {}) };
    const r = await gh('/contents/state.json', { method: 'PUT', body: JSON.stringify(body) });
    if (r.ok) sha = (await r.json()).content.sha;
    else console.error(`could not save the state: ${r.status}`);
  };

  const liveDeploy = async () => {
    if (!token) return '';
    try {
      const r = await netlify(`/sites/${siteId}`);
      if (!r.ok) return '';
      return (await r.json()).published_deploy.id;
    } catch { return ''; }
  };
  const tell = async (text) => {
    console.log(text);
    const topic = process.env.NTFY_TOPIC;
    if (!topic) return;
    try { await fetch(`https://ntfy.sh/${encodeURIComponent(topic)}`, { method: 'POST', headers: { Title: 'Burncaps watcher', Priority: 'high' }, body: text, signal: AbortSignal.timeout(15000) }); }
    catch (err) { console.error('push failed', err.message); }
  };

  // A drill (run by hand from GitHub): pretend the check failed and go back to
  // the named deploy, to prove the whole path on the real site.
  const drillTo = process.env.DRILL_TO || '';
  const now = Date.now();
  // Which version was checked: read before and after, so a publish that lands
  // during the check is neither called good nor undone. The next run judges it.
  const deployBefore = await liveDeploy();
  let result = await liveCheckRetried(SITE, { tries: 3, gapMs: 30000 });
  const deployId = await liveDeploy();
  if (deployBefore !== deployId && !drillTo) {
    console.log(`the live version changed during the check (${deployBefore} to ${deployId}): judging it next run`);
    process.exit(0);
  }
  if (drillTo) { result = { ok: false, siteDown: false, why: 'drill: this failure is pretended' }; state.good = drillTo; delete state.lastRollback; }
  const plan = decide({ result, token: !!token, deployId, state, now });
  console.log(JSON.stringify({ result, deployId, good: state.good, plan }));
  // One odd run is not news: "could not tell" is only worth a word when it lasts half an hour.
  state.unclear = plan.kind === 'inconclusive' ? (state.unclear || 0) + 1 : 0;

  let exit = 0;
  if (plan.action === 'ok') {
    if (plan.newGood) { state.good = plan.newGood; state.goodAt = new Date(now).toISOString(); }
  } else if (plan.action === 'alert') {
    if (plan.kind !== 'inconclusive' || state.unclear >= 3) {
      if (record(state, { at: now, kind: plan.kind, why: result.why, deploy: deployId })) { exit = 1; await tell(WORDS[plan.kind](result.why)); }
    }
  } else if (plan.action === 'rollback') {
    exit = 1;
    let target = null;
    try { const r = await netlify(`/sites/${siteId}/deploys/${plan.to}`); if (r.ok) target = await r.json(); } catch {}
    if (!target || target.context !== 'production' || target.state !== 'ready') {
      const why = `${plan.to} is ${target ? `${target.context}, ${target.state}` : 'unreadable'}; ${result.why}`;
      if (record(state, { at: now, kind: 'bad-target', why, deploy: deployId })) await tell(WORDS['bad-target'](why));
    } else {
      let restored = false;
      try { restored = (await netlify(`/sites/${siteId}/deploys/${plan.to}/restore`, { method: 'POST' })).ok; } catch {}
      if (!restored) restored = (await liveDeploy()) === plan.to; // Netlify can answer an error while the restore worked
      if (!restored) {
        const why = `the undo was refused; ${result.why}`;
        if (record(state, { at: now, kind: 'no-deploy-id', why, deploy: deployId })) await tell(WORDS['no-deploy-id'](why));
      } else {
        // Saved at once: if this job dies now, the next one must know the undo happened.
        state.lastRollback = { from: deployId, to: plan.to, at: now };
        await save(now);
        await new Promise(res => setTimeout(res, 15000));
        const after = await liveCheckRetried(SITE, { tries: 2, gapMs: 20000 });
        const incident = { at: now, kind: 'rollback', why: result.why, from: deployId, to: plan.to, fixed: after.ok, ...(drillTo ? { drill: true } : {}) };
        record(state, incident, { always: true });
        await tell(WORDS.rollback(result.why, incident));
      }
    }
  }

  const beat = Date.parse(state.beat || 0) || 0;
  const changed = JSON.stringify(state) !== before;
  if (changed || now - beat >= BEAT_MS) { state.beat = new Date(now).toISOString(); await save(now); }
  process.exit(exit);
}

if (process.argv[1] && process.argv[1].endsWith('watch.mjs') && process.env.GITHUB_ACTIONS) await main();
