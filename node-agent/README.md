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


## KVM and LXC guest management API

All routes below require `Authorization: Bearer $HVM_NODE_TOKEN`. Keep the agent on a private network or behind a firewall; never expose its port publicly.

- `GET /guests` — list KVM guests and LXC containers.
- `GET /guests/:type/:name/info` — guest details; type is `kvm` or `lxc`.
- `POST /guests` — create a guest with JSON `{"type":"lxc","name":"demo-vm","cpu":2,"ram_gb":2,"storage_gb":20,"image":"images:ubuntu/24.04"}`. KVM requests use the configured cloud image.
- `POST /guests/:type/:name/start`, `/stop`, `/restart` — lifecycle operations.
- `POST /guests/:type/:name/delete` — requires JSON `{"confirm":true}`; this permanently deletes the guest and requests storage removal.

### KVM provisioning requirements

Set `HVM_KVM_IMAGE` to an existing cloud-init-enabled Ubuntu/Debian cloud image on the node, `HVM_KVM_IMAGE_FORMAT` to `qcow2` or `raw`, and `HVM_KVM_STORAGE_DIR` to the libvirt image directory. Install `qemu-img`, `virt-install`, `openssl`, and libvirt. The configured image must support cloud-init and the libvirt `default` network must exist. KVM provisioning is rejected when no image is configured.

### LXC provisioning requirements

Install and initialize LXD/LXC on the node and configure a storage pool whose root device supports the requested size. Only the Ubuntu 22.04/24.04 and Debian 12/13 image aliases are accepted. The agent creates a generated user and password; the bot should deliver credentials only via private Discord DM. If the DM fails, the bot requests guest deletion.

These endpoints return real command failures; they do not simulate guest creation or state. Validate configuration on a staging node before production use.
