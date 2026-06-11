#!/usr/bin/env python3
"""End-to-end interaction verification for the dev-review console (#185).

Drives the REAL interaction chain in a headless browser against a live target:
pick → click element in proxied iframe → comment → pin → rail → persistence →
orphan-on-mutation → send-to-agent (quota-free shell agent via the store seam).

Prereqs: `npm run dev` running (web :3760 + pty :3761), target app reachable
from the server (default http://localhost:8080), python playwright installed.

Usage: python3 scripts/e2e-verify.py [target-url]
Exit 0 = all checks pass.
"""
import json
import sys
import time
import urllib.request

BASE = "http://localhost:3760"
PTY = "http://localhost:3761"
TARGET = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"
RESULTS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"  {'✓' if ok else '✗'} {name}" + (f" — {detail}" if detail else ""))


def rest(method: str, url: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(url, method=method)
    data = None
    if body is not None:
        req.add_header("content-type", "application/json")
        data = json.dumps(body).encode()
    with urllib.request.urlopen(req, data=data, timeout=10) as r:
        return json.loads(r.read())


def main() -> int:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1600, "height": 1000})
        pg.goto(BASE, wait_until="networkidle", timeout=30000)

        # -- preview loads through the same-origin proxy ----------------------
        pg.fill("header form input", TARGET)
        pg.press("header form input", "Enter")
        frame = None
        for _ in range(40):
            f = pg.query_selector("iframe")
            frame = f.content_frame() if f else None
            if frame and frame.url and "__preview" in frame.url:
                try:
                    if frame.query_selector("body *"):
                        break
                except Exception:
                    pass
            time.sleep(0.5)
        check("preview iframe loads via /__preview", bool(frame), frame.url if frame else "no frame")

        # -- pick → click → comment → pin -------------------------------------
        pg.click("button[title='toggle element picker']")
        handle = frame.evaluate_handle(
            "() => [...document.querySelectorAll('body *')].find(e => e.offsetParent && e.getBoundingClientRect().width > 20 && e.getBoundingClientRect().height > 10)"
        )
        el = handle.as_element()
        if el is None:
            raise RuntimeError("no visible element in target page")
        el.scroll_into_view_if_needed()
        el.click(force=True)
        pg.wait_for_selector("input[placeholder*=\"what's wrong\"]", timeout=5000)
        picked_selector = pg.eval_on_selector("code", "el => el.textContent")
        pg.fill("input[placeholder*=\"what's wrong\"]", "e2e: tighten spacing here")
        pg.click("button:has-text('pin')")
        check("pick → comment → pin commit", True, picked_selector or "")

        # -- pin badge rendered inside the iframe ------------------------------
        time.sleep(0.5)
        badge = frame.evaluate(
            "() => [...document.querySelectorAll('div')].some(d => d.textContent === '1' && d.style.borderRadius === '50%')"
        )
        check("numbered pin badge rendered in page", bool(badge))

        # -- selector uniqueness on the real DOM ------------------------------
        if picked_selector:
            count = frame.evaluate(f"document.querySelectorAll({json.dumps(picked_selector)}).length")
            check("selector matches exactly 1 element", count == 1, f"matches={count}")

        # -- annotation visible in the rail -----------------------------------
        rail = pg.locator("text=e2e: tighten spacing here")
        check("annotation listed in rail", rail.count() > 0)

        # -- persistence: session file on disk via API -------------------------
        time.sleep(1.2)  # autosave debounce
        sess = rest("GET", f"{BASE}/api/reviews?url={TARGET}")
        anns = (sess.get("session") or {}).get("annotations", [])
        check("session autosaved to disk", any(a.get("comment", "").startswith("e2e:") for a in anns),
              sess.get("path", ""))

        # -- orphan detection: remove the pinned element ------------------------
        if picked_selector:
            frame.evaluate(f"document.querySelector({json.dumps(picked_selector)})?.remove()")
            time.sleep(1.0)  # observer debounce 300ms + margin
            orphaned = pg.locator("text=e2e: tighten spacing here").count() > 0 and pg.evaluate(
                "window.__reviewStore.getState().annotations.some(a => a.status === 'orphaned')"
            )
            check("orphan detected on DOM mutation (fail-loud)", bool(orphaned))

        # -- agent handoff: quota-free shell agent via store seam ---------------
        ws = rest("GET", f"{PTY}/workspaces")["workspaces"]
        ws_id = ws[0]["id"] if ws else rest("POST", f"{PTY}/workspaces", {"name": "e2e"})["workspace"]["id"]
        agent = rest("POST", f"{PTY}/agents", {"workspaceId": ws_id, "kind": "shell", "name": "e2e-sink"})["agent"]
        pg.evaluate(f"window.__reviewStore.getState().setAgentId({json.dumps(agent['id'])})")
        # the first annotation is now orphaned (send skips it) — add an open one
        pg.evaluate(
            "url => window.__reviewStore.getState().addAnnotation({selector: 'body', comment: 'e2e: handoff item', "
            "rect: {x: 0, y: 0, width: 10, height: 10}, styles: {}, url, severity: 'note'})",
            TARGET,
        )
        pg.click("button[title='send open annotations to agent']", timeout=5000)
        time.sleep(1.5)
        sb = rest("GET", f"{PTY}/agents/{agent['id']}/scrollback?lines=50")
        text = "\n".join(sb.get("lines", [])) if isinstance(sb.get("lines"), list) else json.dumps(sb)
        check("structured prompt landed in agent PTY", "Frontend review of" in text and "selector:" in text)
        rest("DELETE", f"{PTY}/agents/{agent['id']}")

        b.close()

    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{'PASS' if not failed else 'FAIL'}: {len(RESULTS) - len(failed)}/{len(RESULTS)} checks")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
