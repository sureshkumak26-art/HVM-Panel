import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NAME_RE = /^[a-z][a-z0-9-]{1,39}$/;
const ALLOWED_LXC_IMAGES = new Set([
  'images:ubuntu/24.04',
  'images:ubuntu/22.04',
  'images:debian/12',
  'images:debian/13',
]);

function safeName(value) {
  return typeof value === 'string' && NAME_RE.test(value);
}

function runInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(options.env || {}) },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { if (stdout.length < 65536) stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { if (stderr.length < 65536) stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve({ stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 500)}`));
    });
    child.stdin.end(input);
  });
}

async function execText(exec, command, args, timeout = 30000) {
  const result = await exec(command, args, { timeout, maxBuffer: 2 * 1024 * 1024 });
  return String(result.stdout || '').trim();
}

async function listGuests(exec, virsh) {
  const guests = [];
  const kvmRaw = await virsh(['list', '--all', '--name']);
  for (const name of kvmRaw.split('\n').map(v => v.trim()).filter(Boolean)) {
    let state = 'unknown';
    try { state = await virsh(['domstate', name]); } catch {}
    guests.push({ name, type: 'kvm', state: state.toLowerCase() });
  }
  try {
    const raw = await execText(exec, 'lxc', ['list', '--format=json']);
    const containers = JSON.parse(raw || '[]');
    for (const item of containers) {
      guests.push({
        name: item.name,
        type: 'lxc',
        state: String(item.status || 'unknown').toLowerCase(),
        ipv4: (item.state?.network?.eth0?.addresses || [])
          .filter(address => address.family === 'inet').map(address => address.address),
      });
    }
  } catch (error) {
    // LXC is optional on KVM-only nodes; report a visible warning in the response.
    return { guests, lxcWarning: error.message };
  }
  return { guests, lxcWarning: null };
}

async function guestInfo(exec, virsh, type, name) {
  if (!safeName(name)) throw new Error('Invalid guest name');
  if (type === 'kvm') {
    const info = await virsh(['dominfo', name]);
    let ips = '';
    try { ips = await virsh(['domifaddr', name, '--source', 'agent']); } catch {}
    return { name, type, info, ip_info: ips };
  }
  if (type === 'lxc') {
    const [info, config] = await Promise.all([
      execText(exec, 'lxc', ['info', name]),
      execText(exec, 'lxc', ['config', 'show', name, '--expanded']),
    ]);
    return { name, type, info, config };
  }
  throw new Error('Type must be kvm or lxc');
}

async function guestAction(exec, virsh, type, name, action) {
  if (!safeName(name)) throw new Error('Invalid guest name');
  const actions = new Set(['start', 'stop', 'restart', 'delete']);
  if (!actions.has(action)) throw new Error('Unsupported action');
  if (type === 'kvm') {
    if (action === 'start') return virsh(['start', name]);
    if (action === 'stop') return virsh(['shutdown', name]);
    if (action === 'restart') return virsh(['reboot', name]);
    await virsh(['destroy', name]).catch(() => {});
    return virsh(['undefine', name, '--remove-all-storage']);
  }
  if (type === 'lxc') {
    if (action === 'start') return execText(exec, 'lxc', ['start', name]);
    if (action === 'stop') return execText(exec, 'lxc', ['stop', name, '--force']);
    if (action === 'restart') return execText(exec, 'lxc', ['restart', name, '--force']);
    return execText(exec, 'lxc', ['delete', name, '--force']);
  }
  throw new Error('Type must be kvm or lxc');
}

async function createGuest(exec, virsh, body) {
  const type = body?.type;
  const name = String(body?.name || '').trim().toLowerCase();
  const cpu = Number(body?.cpu);
  const ram = Number(body?.ram_gb);
  const storage = Number(body?.storage_gb);
  if (!safeName(name)) throw new Error('Name must be 2–40 lowercase letters, digits or hyphens, starting with a letter');
  if (!Number.isInteger(cpu) || cpu < 1 || cpu > 16) throw new Error('CPU must be an integer from 1 to 16');
  if (!Number.isInteger(ram) || ram < 1 || ram > 64) throw new Error('RAM must be an integer from 1 to 64 GB');
  if (!Number.isInteger(storage) || storage < 5 || storage > 500) throw new Error('Disk must be an integer from 5 to 500 GB');

  const username = `hvmuser${randomBytes(3).toString('hex')}`;
  const password = randomBytes(18).toString('base64url');
  if (type === 'lxc') {
    const image = String(body?.image || 'images:ubuntu/24.04');
    if (!ALLOWED_LXC_IMAGES.has(image)) throw new Error('Unsupported LXC image; choose a supported Ubuntu or Debian image');
    await execText(exec, 'lxc', [
      'launch', image, name,
      '--config', `limits.cpu=${cpu}`,
      '--config', `limits.memory=${ram}GB`,
      '--device', `root,size=${storage}GB`,
    ], 120000);
    try {
      await execText(exec, 'lxc', ['exec', name, '--', 'useradd', '-m', '-s', '/bin/bash', username], 30000);
      await runInput('lxc', ['exec', name, '--', 'chpasswd'], `${username}:${password}\n`, { timeout: 30000 });
    } catch (error) {
      await execText(exec, 'lxc', ['delete', name, '--force']).catch(() => {});
      throw error;
    }
    return { name, type, username, password, state: 'running' };
  }

  if (type !== 'kvm') throw new Error('Type must be kvm or lxc');
  const image = process.env.HVM_KVM_IMAGE || '';
  const imageFormat = process.env.HVM_KVM_IMAGE_FORMAT || 'qcow2';
  const storageDir = path.resolve(process.env.HVM_KVM_STORAGE_DIR || '/var/lib/libvirt/images');
  if (!image) throw new Error('KVM creation is disabled: configure HVM_KVM_IMAGE to a cloud-init-enabled base image on the node');
  if (!['qcow2', 'raw'].includes(imageFormat)) throw new Error('HVM_KVM_IMAGE_FORMAT must be qcow2 or raw');
  await fs.access(image);
  await fs.mkdir(storageDir, { recursive: true });
  const diskPath = path.join(storageDir, `${name}.qcow2`);
  try { await fs.access(diskPath); throw new Error('A disk with this name already exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let tempDir;
  try {
    const hashResult = await runInput('openssl', ['passwd', '-6', '-stdin'], password + '\n');
    const passwordHash = hashResult.stdout;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hvm-cloudinit-'));
    const userData = [
      '#cloud-config',
      'users:',
      '  - name: ' + username,
      '    groups: [sudo]',
      '    shell: /bin/bash',
      '    sudo: ALL=(ALL) NOPASSWD:ALL',
      '    lock_passwd: false',
      "    passwd: '" + passwordHash + "'",
      'ssh_pwauth: true',
      'chpasswd:',
      '  expire: true',
      '',
    ].join('\n');
    const userDataPath = path.join(tempDir, 'user-data');
    await fs.writeFile(userDataPath, userData, { mode: 0o600 });
    await execText(exec, 'qemu-img', [
      'create', '-f', 'qcow2', '-F', imageFormat, '-b', path.resolve(image), diskPath, `${storage}G`,
    ], 120000);
    await execText(exec, 'virt-install', [
      '--name', name,
      '--memory', String(ram * 1024),
      '--vcpus', String(cpu),
      '--disk', `path=${diskPath},format=qcow2`,
      '--import',
      '--os-variant', 'generic',
      '--network', 'network=default',
      '--graphics', 'none',
      '--noautoconsole',
      '--cloud-init', `user-data=${userDataPath},disable=on`,
    ], 180000);
    return { name, type, username, password, state: 'running' };
  } catch (error) {
    await virsh(['destroy', name]).catch(() => {});
    await virsh(['undefine', name, '--remove-all-storage']).catch(() => {});
    await fs.rm(diskPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    if (tempDir) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function registerGuestRoutes(app, auth, exec, virsh) {
  app.get('/guests', auth, async (_req, res) => {
    try {
      const result = await listGuests(exec, virsh);
      res.json({ ok: true, ...result });
    } catch (error) {
      res.status(500).json({ ok: false, error: String(error.message || 'Guest listing failed').slice(0, 500) });
    }
  });

  app.get('/guests/:type/:name/info', auth, async (req, res) => {
    try {
      const guest = await guestInfo(exec, virsh, req.params.type, req.params.name);
      res.json({ ok: true, guest });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error.message || 'Guest info failed').slice(0, 500) });
    }
  });

  app.post('/guests', auth, async (req, res) => {
    try {
      const guest = await createGuest(exec, virsh, req.body || {});
      res.status(201).json({ ok: true, guest });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error.message || 'Guest creation failed').slice(0, 500) });
    }
  });

  app.post('/guests/:type/:name/:action', auth, async (req, res) => {
    try {
      if (req.params.action === 'delete' && req.body?.confirm !== true) {
        return res.status(400).json({ ok: false, error: 'Deletion requires confirm=true' });
      }
      const output = await guestAction(exec, virsh, req.params.type, req.params.name, req.params.action);
      res.json({ ok: true, output: String(output || '').slice(0, 1000) });
    } catch (error) {
      res.status(400).json({ ok: false, error: String(error.message || 'Guest action failed').slice(0, 500) });
    }
  });
}
