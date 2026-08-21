import express from 'express';
import helmet from 'helmet';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const app = express();
app.use(helmet());
app.use(express.json());

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.HVM_NODE_TOKEN || '';
const auth = (req, res, next) => {
  if (!TOKEN || req.headers.authorization !== `Bearer ${TOKEN}`) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

async function virsh(args) {
  const { stdout } = await exec('virsh', args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
  return stdout.trim();
}

app.get('/health', auth, async (_req, res) => {
  try { await virsh(['version']); res.json({ ok: true, hypervisor: 'libvirt' }); }
  catch (e) { res.status(503).json({ ok: false, error: e.message }); }
});

app.get('/vms', auth, async (_req, res) => {
  try {
    const raw = await virsh(['list', '--all', '--name']);
    const names = raw.split('\n').map(x => x.trim()).filter(Boolean);
    const vms = [];
    for (const name of names) {
      let state = 'unknown';
      try { state = (await virsh(['domstate', name])).trim(); } catch {}
      vms.push({ name, state });
    }
    res.json(vms);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/vms/:name/:action', auth, async (req, res) => {
  const allowed = { start: 'start', stop: 'destroy', shutdown: 'shutdown', restart: 'reboot', delete: 'undefine' };
  const command = allowed[req.params.action];
  if (!command) return res.status(400).json({ error: 'Unsupported action' });
  try {
    const args = [command, req.params.name];
    if (command === 'undefine') args.push('--remove-all-storage');
    const output = await virsh(args);
    res.json({ ok: true, output });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.listen(PORT, () => console.log(`HVM node agent listening on ${PORT}`));
