# Vora Setup — the human-gated steps

Do these in order. Steps 1–2 are the careful part; nothing Vora does is safe until the write
credential is scoped. Assumes the repo is `NavoreMarket/Navore-Ops` — adjust if your org slug
differs.

---

## 1. Mint two scoped GitHub tokens (the hard wall)

GitHub applies one permission set across all repos a token can see, so read-elsewhere +
write-here needs **two** fine-grained PATs. Make them on the account that owns the Navore repos
(or have an org admin do it): GitHub → Settings → Developer settings → **Fine-grained tokens**.

### A. Write-PAT — `vora-write-Navore-Ops`
- Resource owner: **NavoreMarket**
- Repository access → **Only select repositories** → **`Navore-Ops`** (this one repo, nothing else)
- Permissions:
  - Contents → **Read and write**
  - Pull requests → **Read and write**
  - Metadata → Read (auto)
- Expiry: 90 days (set a calendar reminder to rotate)

This is the **only** token with write power. Because `Navore-Ops` is the only repo it lists,
Vora physically cannot push to a product/site repo.

### B. Read-PAT — `vora-read-navore-product`
- Resource owner: **NavoreMarket**
- Repository access → **Only select repositories** → the product/site repos
  (e.g. `navore-platform` + the site repo)
- Permissions:
  - Contents → **Read only**
  - Metadata → Read (auto)
- Expiry: 90 days

This lets Vora clone/study the real site to replicate it. No write power anywhere.

> Do not paste either token into chat or commit it. They go into environment secrets (step 2).

## 2. Create the Navore Claude Code environment

In the **Navore** Claude Code account (the separate subscription — never your personal one):

1. New environment, e.g. `navore-vora`.
2. **Writable working repo:** `NavoreMarket/Navore-Ops`, using the **Write-PAT** as its
   git credential.
3. **Read-only sources:** add the product/site repos, using the **Read-PAT**.
4. Store both tokens as environment **secrets** (e.g. `VORA_WRITE_PAT`, `VORA_READ_PAT`).
5. Network policy: whatever the Navore product allows; Vora needs GitHub + general web for
   research. No personal-machine access.

## 3. Seed Vora into Navore-Ops

1. Clone `Navore-Ops` (or open it in the new environment).
2. Copy every file from `sandbox-agent-template/seed/` into the **root** of `Navore-Ops`.
3. Commit: `chore: seed Vora workspace`.
4. Open a fresh session in the `navore-vora` environment — it should now boot as Vora and read
   `CLAUDE.md` + `IDENTITY.md` at startup.

## 4. Ask the devs for branch protection (belt & suspenders)

You don't touch the dev repos. Just ask the Navore devs to confirm the product/site repos have:
- Protected default branch (no direct pushes)
- Required pull-request review before merge

Even though Vora has no write token for those repos, this protects against every other path
too. It's a one-line Slack/Teams ask.

## 5. Verify the isolation holds (do this once, deliberately)

In a Vora session:
1. Read a file from a product/site repo → should **work** (Read-PAT).
2. Try to push a trivial change to a product/site repo → should **fail** (no write credential).
3. Push a trivial change to `Navore-Ops` → should **succeed** (Write-PAT).
4. Ask Vora about your personal Metis OS / Jay / Jarry memory → it should have **none**
   (separate account + repo).

If all four behave as expected, the sandbox is sealed and safe to play in.
