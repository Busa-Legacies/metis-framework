# Public Repo Carveout Playbook

How to carve a publishable project out of Metis OS.

---

## Inspiration — what makes good open-source repos in this space

**Local AI / agent frameworks** (open-interpreter, anything-llm, local-ai):
- Single `docker compose up` or `pip install + one command` → running in < 5 min
- Config is all env vars with clear `.env.example`; never hardcoded paths
- README has a GIF/screenshot above the fold
- "Quickstart" section is 3–5 lines, not a wall of prereqs

**Self-hosted dashboards** (homepage, dashy, homarr):
- Docker-first install path; raw Python/Node as secondary
- Heavy use of `config.yaml` with inline comments explaining every field
- Contributors welcome section + clear issue template

**Trading / algo bots** (freqtrade, hummingbot):
- Extensive disclaimer at top of README (not financial advice)
- Paper-trade mode prominently documented before live mode
- Strategy separation: core engine (publishable) vs personal strategies (gitignored)

**Reddit signal** (r/selfhosted, r/LocalLLaMA, r/algotrading):
- Pain point: "I can't figure out how to configure this without reading source code" → detailed `.env.example` is non-negotiable
- Pain point: "project works on the author's machine but breaks on mine" → lockfiles + tested Docker path
- Pain point: "abandoned after 3 commits" → even a small CHANGELOG or release tag signals maintenance

---

## Carveout Architecture

### Config discovery (runs inside AND outside openclaw)

```python
def get_config() -> dict:
    openclaw = Path.home() / ".openclaw/config.json"
    if openclaw.exists():
        return json.loads(openclaw.read_text())          # internal: auto-configured
    local = Path("config.yaml")
    if local.exists():
        return yaml.safe_load(local.read_text())          # external: local file
    return {                                              # external: env var fallback
        "gateway_url": os.environ.get("OPENCLAW_GATEWAY", "http://localhost:18789"),
        "agent_model": os.environ.get("AGENT_MODEL", "qwen3-coder:30b"),
    }
```

The public README shows both paths:
> If OpenClaw is installed, it auto-configures. Otherwise copy `.env.example` → `.env` and set `OPENCLAW_GATEWAY`.

### Internal imports

Use optional dependency pattern — never hard `import openclaw` at module level:

```python
try:
    from openclaw.client import OpenClawClient
    _HAS_OPENCLAW = True
except ImportError:
    _HAS_OPENCLAW = False

def get_client():
    if _HAS_OPENCLAW:
        return OpenClawClient()
    return StandaloneClient()     # bundled fallback
```

### Mono-repo structure (recommended)

Keep Nick's projects as subdirectories inside Metis OS. Don't create separate private repos — that fragments history and doubles maintenance. Public forks are downstream read-only mirrors, not development homes.

```
metis-os/
├── projects/
│   ├── metis-command/         ← develop here (private)
│   ├── polymarket-bot/        ← develop here (private)
│   └── dashboard/             ← stays private
└── scripts/
    └── publish-carveout.sh    ← strips + pushes to public remote
```

Public repos (`anthonyabusa/metis-command`, `anthonyabusa/polymarket-trading-bot`) are tags cut from the private mono-repo. Never commit directly to the public fork.

### Startup / LaunchAgent portability

Don't abstract — document both. README section: "Running as a background service":
- macOS: `cp launchagents/com.example.app.plist ~/Library/LaunchAgents/ && launchctl load ...`
- Linux: `cp systemd/app.service ~/.config/systemd/user/ && systemctl --user enable --now app`
- Manual: `python3 app.py` (always works)

---

## Carveout Checklist

Run this before every public release:

### 1. Secrets audit
- [ ] `grep -r "sk-" . --include="*.py" --include="*.js"` — no API keys in source
- [ ] `grep -r "@gmail\|@example\|anthonyabusa" . --include="*.py"` — no personal emails hardcoded
- [ ] `.env` and `*-tokens.json` in `.gitignore`
- [ ] All sheet IDs / webhook URLs moved to env vars

### 2. Personal data scrub
- [ ] Hardcoded spreadsheet IDs → `SHEET_ID` env var
- [ ] Hardcoded Tailscale IPs → `GATEWAY_HOST` env var
- [ ] `~/.openclaw/` paths → config discovery pattern (see above)
- [ ] No `anthonyabusa` or `metis-os` refs in user-facing strings

### 3. Dependency isolation
- [ ] Standalone `requirements.txt` (no internal packages)
- [ ] `requirements-dev.txt` for dev/test deps
- [ ] Pin major versions, not exact hashes (easier for users to install)
- [ ] Test `pip install -r requirements.txt` in a fresh venv

### 4. README
See template below.

### 5. License
Add `LICENSE` file (MIT recommended — see below).

### 6. Version tag
- [ ] `git tag v1.0.0` in the public repo after publish script runs
- [ ] Add `## [v1.0.0] — YYYY-MM-DD` entry to `CHANGELOG.md` (even one line)

---

## README Template

```markdown
# Project Name

One sentence: what it does and who it's for.

![demo](docs/demo.gif)   <!-- or screenshot -->

## Features
- Bullet 1
- Bullet 2

## Quickstart
\`\`\`bash
git clone https://github.com/anthonyabusa/<project>
cd <project>
cp .env.example .env   # edit with your values
pip install -r requirements.txt
python3 main.py
\`\`\`

## Configuration
| Variable | Default | Description |
|---|---|---|
| `OPENCLAW_GATEWAY` | `http://localhost:18789` | OpenClaw gateway URL (optional) |
| `AGENT_MODEL` | `qwen3-coder:30b` | Ollama model name |

## OpenClaw integration (optional)
If you run [OpenClaw](https://github.com/anthonyabusa/openclaw), this project auto-configures from `~/.openclaw/config.json`. No additional setup needed.

## License
MIT — see [LICENSE](LICENSE).
```

---

## Publish Script Sketch

`scripts/publish-carveout.sh <project> <version>`

Steps:
1. Copy `projects/<project>/` to a temp dir
2. Run secrets audit — abort if any hits
3. Strip internal import lines (`from openclaw...`, `from app.core.config...` where config is internal-only)
4. Replace `~/.openclaw/` path refs with config discovery shim
5. Copy `LICENSE`, `CHANGELOG.md` if not present
6. `git -C <tempdir> init && git remote add origin git@github.com:anthonyabusa/<project>`
7. `git -C <tempdir> add -A && git commit -m "release: v<version>"` 
8. `git -C <tempdir> tag v<version> && git push origin main --tags`

**Risky parts:**
- Step 4 (path replacement) needs a test suite — easy to under-replace and leak an internal path
- Step 6 assumes the public remote exists; script should check and error clearly
- Never run this on uncommitted changes in the private tree — gate on `git diff --quiet`

---

## License Recommendation: MIT

**Why MIT over Apache 2.0:**
- MIT is universally understood, zero friction for users/contributors
- Apache 2.0 adds patent grant language that matters at company scale — overkill for personal portfolio projects
- Most popular personal AI/dashboard repos use MIT; it signals approachability

The one exception: if a project incorporates code from an Apache-licensed upstream (some ML libraries), use Apache 2.0 to stay compatible.
