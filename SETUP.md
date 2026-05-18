# cardinalcapital.xyz — Setup Playbook

Three Lego bricks, ~30 minutes end to end:

1. **Cloudflare** — DNS switchboard (free)
2. **Google Workspace** — real mailbox at @cardinalcapital.xyz ($7/mo)
3. **Cloudflare Pages** — host the landing page (free)

---

## 1. Cloudflare: take over DNS

Why first: every other step needs DNS records, and Cloudflare is the easiest place to manage them.

- Create a Cloudflare account → **Add a Site** → enter `cardinalcapital.xyz` → pick the **Free** plan.
- Cloudflare scans your existing records and gives you two nameservers (e.g., `lana.ns.cloudflare.com`).
- Go to your registrar (wherever you bought the .xyz — Namecheap, Porkbun, Cloudflare Registrar, etc.) → replace the nameservers with Cloudflare's.
- Wait 5–60 min for propagation. Cloudflare emails you when active.

> Tip: if your registrar is anything other than Cloudflare, consider transferring the domain to Cloudflare Registrar after 60 days — they sell at wholesale cost (no markup) and DNS lives in one place.

---

## 2. Google Workspace: email at @cardinalcapital.xyz

- Sign up at **workspace.google.com** → start the Business Starter trial ($7/user/mo).
- Domain: enter `cardinalcapital.xyz`.
- Choose your primary username — I'd suggest `alex@cardinalcapital.xyz` (or `alex.r.f.` if you want to mirror your personal). Aliases are free; create more later (`hello@`, `ir@`, etc.).
- Workspace gives you **verification records** to add. In Cloudflare → DNS → add each one:

| Type  | Name           | Value / Target                                | Notes              |
|-------|----------------|-----------------------------------------------|--------------------|
| TXT   | `@`            | `google-site-verification=…`                  | Domain ownership   |
| MX    | `@`            | `smtp.google.com` (priority 1)                | Inbound mail       |
| TXT   | `@`            | `v=spf1 include:_spf.google.com ~all`         | SPF (anti-spoof)   |
| TXT   | `google._domainkey` | (long key Workspace gives you)           | DKIM (signing)     |
| TXT   | `_dmarc`       | `v=DMARC1; p=quarantine; rua=mailto:alex@cardinalcapital.xyz` | DMARC (policy) |

> Set DMARC to `p=none` for the first week to monitor, then ratchet to `quarantine` once you confirm legit mail is signing correctly. Workspace's admin console walks you through this.

- Back in Workspace admin, click **Verify** for each record. Send yourself a test email to confirm.

---

## 3. Cloudflare Pages: host the landing page

- In Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets** (skip GitHub for now).
- Project name: `cardinalcapital`
- Drag the folder `cardinalcapital-landing/` into the uploader.
- Cloudflare gives you a `*.pages.dev` URL. Test it loads.
- Then → **Custom domains** → add `cardinalcapital.xyz` and `www.cardinalcapital.xyz`. Cloudflare auto-creates the DNS records and SSL cert.

Total time: 5 minutes after DNS is live.

---

## Optional polish

- **Email signature**: in Gmail → Settings → Signature. Keep it as restrained as the landing page — name, title, mobile.
- **Catch-all**: in Workspace admin → Routing → set unmatched addresses to forward to alex@. So `partner@`, `intro@`, `whatever@` all reach you.
- **Calendly / scheduling**: hook a Cal.com or Calendly URL to `cardinalcapital.xyz/meet` later via a Cloudflare redirect rule.
- **GitHub deploy**: when you want to iterate on the page, push the folder to a private GitHub repo and connect it to Pages — every commit auto-deploys.

---

## Costs

| Item                          | Cost           |
|-------------------------------|----------------|
| Domain (cardinalcapital.xyz)  | ~$10–15/yr     |
| Cloudflare DNS + Pages        | $0             |
| Google Workspace (1 user)     | $7/mo ($84/yr) |
| **Total annual**              | **~$95–100**   |

---

## Quick sanity-check after setup

- `dig cardinalcapital.xyz MX` → should show `smtp.google.com`
- Send yourself a test from a Gmail account → arrives in @cardinalcapital.xyz inbox
- Send out → recipient sees you as `alex@cardinalcapital.xyz`, not as Gmail
- Visit `https://cardinalcapital.xyz` → page loads with valid HTTPS cert
