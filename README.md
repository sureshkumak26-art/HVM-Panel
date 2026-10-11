# HVM Panel

Production-oriented KVM/libvirt virtualization control panel with a separate Node Agent.

## Architecture
- `panel/` — web control panel + API
- `node-agent/` — runs on each virtualization node and talks to libvirt locally
- `docker-compose.yml` — PostgreSQL + Redis development services

## Real VM operations
The node agent uses `virsh`/libvirt on the node. It does **not** fake VM state. Create/start/stop/restart/delete operations fail visibly when the hypervisor cannot perform them.

## Node agent
Install on a KVM host, configure `HVM_PANEL_URL` and `HVM_NODE_TOKEN`, then run the agent as a systemd service. The agent exposes an authenticated API for VM lifecycle operations and security scans.

## Mining security scan
The authenticated `POST /security/scan` route inspects running KVM guests through QEMU Guest Agent and LXC containers through the `lxc` CLI. It requires both a known miner process signature and a pool/algorithm indicator before stopping a guest. Confirmed KVM guests are stopped with libvirt; confirmed LXC containers are force-stopped. Guests that cannot be inspected are skipped without action.

**Warning:** containment stops the whole VM/container, not just one process. Enable QEMU Guest Agent inside KVM guests you want scanned. Make sure the node agent has the necessary permissions for `virsh` and `lxc`, but do not run the agent as a public internet service.

## Panel features
- Registration/login/loading states
- Admin/customer roles
- VM lifecycle UI
- Node health alerts
- Node registration
- IP/resource plans
- Settings: site name, logo and background video URL
- Tirupati background-video support via configurable URL (no copyrighted media bundled)
- User manager
- Store/install catalog foundation
- Audit-ready API boundaries

## Security
Never expose libvirt directly to the internet. Put the node agent behind TLS/reverse proxy/firewall or a private network and use a unique node token. Store secrets in environment variables.
