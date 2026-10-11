import { setTimeout as sleep } from 'node:timers/promises';

const MINER_PROCESS = /\b(xmrig|xmr-stak|cpuminer|minerd|sgminer|cgminer|nbminer|lolminer|t-rex|gminer|teamredminer|phoenixminer|nanominer|ethminer|cryptonight|randomx)\b/i;
const POOL_OR_ALGO = /(stratum\+tcp|stratum\+ssl|pool\.[a-z0-9.-]+|cryptonight|randomx|kawpow|ethash|etchash|nicehash|monero|moneroocean|supportxmr)/i;

function classifyProcessOutput(output) {
  const matches = [];
  for (const line of String(output || '').split('\n')) {
    if (!MINER_PROCESS.test(line)) continue;
    const processName = line.trim().split(/\s+/).slice(1, 3).join(' ').slice(0, 160);
    const poolEvidence = POOL_OR_ALGO.test(line);
    matches.push({
      evidence: [ 'known-miner-process', ...(poolEvidence ? ['pool-or-mining-algorithm-argument'] : []) ],
      score: poolEvidence ? 2 : 1,
      process: processName || line.trim().slice(0, 160)
    });
  }
  return matches;
}

async function guestExec(virsh, vmName, path, args = []) {
  const payload = JSON.stringify({
    execute: 'guest-exec',
    arguments: { path, arg: args, 'capture-output': true }
  });
  const raw = await virsh(['qemu-agent-command', vmName, payload]);
  const parsed = JSON.parse(raw);
  const pid = parsed.return && parsed.return.pid;
  if (!pid) throw new Error('QEMU guest agent did not return a process ID');
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const statusRaw = await virsh(['qemu-agent-command', vmName, JSON.stringify({
      execute: 'guest-exec-status', arguments: { pid }
    })]);
    const status = JSON.parse(statusRaw).return || {};
    if (!status.exited) continue;
    const stdout = status['out-data'] ? Buffer.from(status['out-data'], 'base64').toString('utf8') : '';
    return { exitCode: status.exitcode ?? 1, stdout };
  }
  throw new Error('Guest process timed out');
}

async function scanKvm(virsh) {
  const names = (await virsh(['list', '--all', '--name'])).split('\n').map(x => x.trim()).filter(Boolean);
  const results = [];
  for (const name of names) {
    let state = 'unknown';
    try { state = (await virsh(['domstate', name])).trim().toLowerCase(); } catch {}
    if (!state.startsWith('running')) continue;
    try {
      const result = await guestExec(virsh, name, '/bin/ps', ['-eo', 'pid,comm,args']);
      const matches = classifyProcessOutput(result.stdout);
      results.push({ type: 'kvm', name, state, supported: true, detections: matches });
    } catch (error) {
      results.push({ type: 'kvm', name, state, supported: false, detections: [], note: 'Guest agent unavailable; no automatic action taken' });
    }
  }
  return results;
}

async function scanLxc(exec) {
  let raw;
  try {
    const result = await exec('lxc', ['list', '--format=json'], { timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
    raw = JSON.parse(result.stdout || '[]');
  } catch {
    return [];
  }
  const results = [];
  for (const item of raw) {
    if (!item.name || item.status !== 'Running') continue;
    try {
      const result = await exec('lxc', ['exec', item.name, '--', 'ps', '-eo', 'pid,comm,args'], { timeout: 12000, maxBuffer: 2 * 1024 * 1024 });
      results.push({ type: 'lxc', name: item.name, state: 'running', supported: true, detections: classifyProcessOutput(result.stdout) });
    } catch {
      results.push({ type: 'lxc', name: item.name, state: 'running', supported: false, detections: [], note: 'Process inspection failed; no automatic action taken' });
    }
  }
  return results;
}

export function registerMiningRoutes(app, auth, exec, virsh) {
  app.post('/security/scan', auth, async (_req, res) => {
    try {
      const targets = [
        ...(await scanKvm(virsh)),
        ...(await scanLxc(exec))
      ];
      const actions = [];
      for (const target of targets) {
        const confirmed = target.supported && target.detections.some(d => d.score >= 2);
        if (!confirmed) continue;
        try {
          if (target.type === 'kvm') {
            // Prefer a guest-coordinated shutdown to reduce filesystem corruption risk.
            try { await virsh(['shutdown', target.name]); } catch {}
            let stopped = false;
            for (let attempt = 0; attempt < 10; attempt++) {
              await sleep(1000);
              try {
                const state = (await virsh(['domstate', target.name])).toLowerCase();
                if (!state.startsWith('running')) { stopped = true; break; }
              } catch { stopped = true; break; }
            }
            if (!stopped) await virsh(['destroy', target.name]);
          } else {
            // Try graceful stop first; force only if the runtime rejects it.
            try {
              await exec('lxc', ['stop', target.name], { timeout: 20000 });
            } catch {
              await exec('lxc', ['stop', target.name, '--force'], { timeout: 20000 });
            }
          }
          actions.push({ type: target.type, name: target.name, action: 'stopped', reason: 'Multiple miner indicators matched', detections: target.detections });
          target.action = 'stopped';
        } catch {
          actions.push({ type: target.type, name: target.name, action: 'stop-failed', reason: 'Confirmed miner indicators matched but guest stop failed', detections: target.detections });
          target.action = 'stop-failed';
        }
      }
      res.json({ ok: true, scannedAt: new Date().toISOString(), targets, actions });
    } catch {
      res.status(500).json({ ok: false, error: 'Security scan failed' });
    }
  });
}
