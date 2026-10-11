# HVM Node Agent

This service controls KVM guests through libvirt and can inspect local LXC containers. Keep it on a private network and configure a unique `HVM_NODE_TOKEN` in `.env`.

Install and run:
```bash
cp .env.example .env
nano .env
npm install
npm start
```

For the mining security endpoint, read [MINING-SECURITY.md](MINING-SECURITY.md). KVM guest process inspection requires QEMU Guest Agent inside each guest. Automatic containment currently stops the whole guest only when a known miner process and a pool/algorithm indicator both match. Inspection failures are not treated as detections.

Do not expose this service directly to the internet. Use a firewall allowlist and HTTPS/private networking for remote bot connections. Never commit `.env` or real tokens.
