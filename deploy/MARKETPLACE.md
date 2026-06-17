# Deploying agentpeek on Linode & DigitalOcean

Three artifacts live in this directory:

| File | Use |
| --- | --- |
| `cloud-init.sh` | Paste into the **User Data** field when creating a Linode or DO droplet. Edit the three vars at the top first. |
| `linode-stackscript.sh` | A Linode **StackScript** (User-Defined Fields → form inputs). The basis of a Marketplace listing. |
| `MARKETPLACE.md` | This file — how to publish on each provider's Marketplace. |

All paths assume Ubuntu 22.04/24.04 and install agentpeek **as root** (`setup.sh`
sets `IS_SANDBOX=1` so Claude works as root). agentpeek binds `127.0.0.1`; the
only intended remote door is Tailscale — supply a `TS_AUTHKEY` so the box joins
your tailnet and `tailscale serve` exposes it over HTTPS. **Never** port-forward
`8090`/`7681` to the public internet.

---

## 1. Quick deploy via User Data (no Marketplace needed)

This works on **both** providers today, without any partner process.

### Linode
1. Use a region/plan with the **Metadata** service (most current regions). Distro: Ubuntu 24.04 LTS.
2. **Create Linode** → scroll to **Add User Data** → paste `cloud-init.sh`.
3. Edit the top of the script first: set `TS_AUTHKEY` (from
   <https://login.tailscale.com/admin/settings/keys>), and optionally `AGENTPEEK_PASSWORD`.
4. Boot. After ~2–3 min, reach it at `https://<host>.<tailnet>.ts.net:9443`
   (also written to `/etc/motd`). If you left the password blank, it was
   auto-generated — read it from the cloud-init log or
   `/root/.config/agentpeek/initial-password.txt`.

### DigitalOcean
1. **Create Droplet** → Ubuntu 24.04 → under **Advanced options** enable
   **Add Initialization scripts (free)** and paste `cloud-init.sh` (edit the vars first).
2. Boot, then reach it over your tailnet exactly as above.

> Inspect the run with `cat /var/log/cloud-init-output.log` (DO) or the Linode
> equivalent if the URL doesn't come up.

---

## 2. Linode Marketplace (One-Click App)

The Linode/Akamai Marketplace is built on **StackScripts** (plus, for the official
listing, Ansible playbooks and a git repo to clone from). You have two tiers:

### a. Personal / shareable StackScript — available immediately
1. Cloud Manager → **StackScripts** → **Create**.
2. Paste `linode-stackscript.sh`. The `# <UDF ... />` tags at the top become the
   input fields (password, Tailscale key, serve port) in the deploy form.
3. Pick the compatible images (Ubuntu 22.04, 24.04) and **Save**.
4. Deploy from **StackScripts → your script → Deploy New Linode**, or mark it
   public to share the URL. This *is* a one-click installer; it just isn't in the
   curated Marketplace catalog.

### b. Official Marketplace listing — requires review
Submitted as a pull request to the Akamai Marketplace repo. Per Akamai's
"contribute" guide, a Marketplace app has three parts: **a StackScript, Ansible
playbooks, and a git repo to clone from**. To submit you provide:
- The StackScript (start from `linode-stackscript.sh`).
- An **app description** (100–125 words).
- A **support URL** (contact form, community thread, or active social account).
- **Design/brand assets** (required — submissions are rejected without them).

Open a PR against **`akamai-compute-marketplace/marketplace-apps`** on GitHub
with the StackScript, an assets folder, and a `.txt`/`.md` describing the listing.
The Marketplace team reviews and schedules the release. Start here:
- Contribute guide: <https://techdocs.akamai.com/cloud-computing/docs/contribute-to-marketplace>
- Marketplace repo: <https://github.com/akamai-compute-marketplace/marketplace-apps>
- StackScripts reference: <https://techdocs.akamai.com/cloud-computing/docs/stackscripts>

---

## 3. DigitalOcean Marketplace (1-Click App)

DO 1-Click apps are **pre-baked snapshot images**, built with **Packer** and
validated with DO's image-check scripts, then submitted through the Vendor Portal.

### Build the image
1. Clone DO's Packer template repo: **`digitalocean/droplet-1-clicks`**.
2. Point the provisioning script at agentpeek's bootstrap — reuse the body of
   `cloud-init.sh` (drop the per-deploy `TS_AUTHKEY`/`tailscale up` lines; an image
   must be generic, with no baked-in secrets — Tailscale is joined at first boot
   by the buyer, e.g. via the droplet's user-data or a first-login step).
3. `packer build …` spins up a build droplet, runs your script, cleans it,
   powers down, and snapshots it.
4. Validate the snapshot with **`digitalocean/marketplace-partners`**
   (`img_check.sh` / cleanup scripts) — it must pass before submission.

### Submit
1. Request vendor access / the Vendor Portal by emailing
   **one-clicks-team@digitalocean.com** if you don't have credentials.
2. In the Vendor Portal, create the listing, attach the validated snapshot, fill
   in description/assets/support info, and submit for review.

Start here:
- Packer build repo: <https://github.com/digitalocean/droplet-1-clicks>
- Validation tools: <https://github.com/digitalocean/marketplace-partners>
- Walkthrough: <https://www.digitalocean.com/blog/using-packer-to-create-a-1-click-nkn-image-on-digitalocean>

> **Image hygiene for both marketplaces:** never bake secrets (Tailscale keys,
> passwords, Claude tokens) into a public image. agentpeek already defers Claude
> sign-in to first run and auto-generates a one-time password on headless install,
> which is the right posture — the buyer supplies their own Tailscale key and
> Claude login after deploy.
