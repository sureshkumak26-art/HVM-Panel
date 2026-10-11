# HVM Node Agent: Mining Detection

This agent endpoint is authenticated with `Authorization: Bearer <HVM_NODE_TOKEN>`.
Do not expose port 8787 directly to the public internet. Use a private network, firewall allowlist, and TLS when crossing hosts.

## What it checks

- KVM guests: reads process arguments through QEMU Guest Agent (`qemu-guest-agent` must be installed and running inside each guest).
- LXC guests: runs `ps` through the local LXD/LXC CLI.
- A high-confidence match requires a known miner process name and a mining pool / algorithm indicator on the same process command line.

## Automatic containment

When a high-confidence match is found, the current implementation stops the entire affected guest:
- KVM: `virsh destroy <guest>` (immediate power-off)
- LXC: `lxc stop <container> --force`

This can interrupt customer workloads. Use only on nodes you administer, inform customers in your service terms, and test on disposable guests first. It intentionally does not stop guests if inspection fails or QEMU Guest Agent is unavailable. Process-name and command-line matching is heuristic; it can miss obfuscated miners and can occasionally flag unusual legitimate workloads. Review evidence before restarting a stopped guest.

## Configure

1. Copy `.env.example` to `.env` and set a long random `HVM_NODE_TOKEN`.
2. Install dependencies with `npm ci` (or `npm install` if no lockfile exists).
3. Run `npm start` under a dedicated service account with only the required libvirt/LXD permissions.
4. Configure the bot's environment with the same token in `NODE_AGENT_TOKEN`, set `NODE_AGENT_URL` to this agent, and set a numeric `MINING_ALERT_CHANNEL_ID`.
5. Allow only the bot host to connect to the agent. Never commit either real token.
6. Test `POST /security/scan` using an authorized token before enabling long-running automatic monitoring.

## API

- `GET /health` — authenticated health check
- `GET /vms` — authenticated KVM inventory
- `POST /security/scan` — authenticated KVM + LXC scan and containment actions

Example (run on a trusted host; substitute your secret locally):

```bash
curl -fsS -X POST http://127.0.0.1:8787/security/scan \
  -H "Authorization: Bearer $HVM_NODE_TOKEN"
```
