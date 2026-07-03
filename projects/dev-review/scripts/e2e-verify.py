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
import urllib.error
import urllib.request

import os

BASE = os.environ.get("DR_BASE", "http://localhost:3760")
PTY = os.environ.get("DR_PTY", "http://localhost:3761")
TARGET = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080"
RESULTS: list[tuple[str, bool, str]] = []


def _sidecar_token() -> str:
    """#259: direct sidecar calls need the trust-gate token (env or token file)."""
    tok = os.environ.get("DR_TOKEN") or os.environ.get("DEV_REVIEW_SIDECAR_TOKEN")
    if tok:
        return tok.strip()
    token_file = os.path.join(
        os.environ.get("AW_DATA_DIR") or os.path.expanduser("~/.openclaw/dev-review"),
        "sidecar-token",
    )
    with open(token_file) as f:
        return f.read().strip()


TOKEN = _sidecar_token()


def check(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print(f"  {'✓' if ok else '✗'} {name}" + (f" — {detail}" if detail else ""))


def rest(method: str, url: str, body: dict | None = None, token: str | None = TOKEN) -> dict:
    req = urllib.request.Request(url, method=method)
    if token and url.startswith(PTY):
        req.add_header("x-dev-review-token", token)
    data = None
    if body is not None:
        req.add_header("content-type", "application/json")
        data = json.dumps(body).encode()
    with urllib.request.urlopen(req, data=data, timeout=10) as r:
        return json.loads(r.read())


def rest_status(method: str, url: str, token: str | None = None) -> int:
    """Status-code probe that does NOT raise on 4xx (for the auth checks)."""
    req = urllib.request.Request(url, method=method)
    if token:
        req.add_header("x-dev-review-token", token)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code


def ws_upgrade_status(path: str, protocols: str | None = None) -> str:
    """Raw WS handshake probe; returns the HTTP status line ('' if just dropped)."""
    import base64
    import socket

    host, port = PTY.replace("http://", "").split(":")
    key = base64.b64encode(os.urandom(16)).decode()
    lines = [
        f"GET {path} HTTP/1.1",
        f"Host: {host}:{port}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
    ]
    if protocols:
        lines.append(f"Sec-WebSocket-Protocol: {protocols}")
    with socket.create_connection((host, int(port)), timeout=5) as s:
        s.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        try:
            resp = s.recv(1024).decode(errors="replace")
        except (TimeoutError, OSError):
            resp = ""
    return resp.split("\r\n")[0] if resp else ""


def main() -> int:
    from playwright.sync_api import sync_playwright

    # ---- #259 trust gate: default-deny sidecar ----
    print("[trust gate]")
    check("unauthenticated sidecar request refused (401)", rest_status("GET", f"{PTY}/agents") == 401)
    check("wrong token refused (401)", rest_status("GET", f"{PTY}/agents", token="not-the-token") == 401)
    check("/health is NOT allowlisted", rest_status("GET", f"{PTY}/health") == 401)
    check("valid token accepted", rest_status("GET", f"{PTY}/agents", token=TOKEN) == 200)
    check(
        "console serves token same-origin",
        rest("GET", f"{BASE}/api/sidecar-token").get("token") == TOKEN,
    )
    check(
        "unauthenticated WS upgrade refused (401)",
        ws_upgrade_status("/ws/any") .startswith("HTTP/1.1 401"),
    )

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

        # Clean slate: hydration restores any previous e2e run's autosaved pins —
        # clear them so status assertions see only this run's annotations.
        time.sleep(1.0)  # let hydrate settle before clearing
        pg.evaluate("() => { const s = window.__reviewStore.getState(); s.annotations.forEach(a => s.removeAnnotation(a.id)) }")

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

        # -- pin-time crop (#256): fire-and-forget capture lands on the annotation --
        crop_path = None
        for _ in range(25):  # first capture pays the headless-Chrome launch
            time.sleep(1.0)
            crop_path = pg.evaluate(
                "sel => window.__reviewStore.getState().annotations.find(a => a.selector === sel)?.cropPath",
                picked_selector,
            )
            if crop_path:
                break
        import os as _os
        check("pin-time crop captured to disk", bool(crop_path) and _os.path.getsize(crop_path) > 0,
              crop_path or "no cropPath")

        # -- headless verify endpoint (#258 follow-up) --------------------------
        hv = rest("POST", f"{PTY}/preview/verify",
                  {"url": TARGET, "checks": [{"id": "hit", "selector": picked_selector}, {"id": "miss", "selector": "#no-such-element"}]})
        hv_map = {r["id"]: r["matches"] for r in hv.get("results", [])}
        check("headless verify: hit=1 miss=0", hv_map.get("hit") == 1 and hv_map.get("miss") == 0, json.dumps(hv_map))

        # -- round-trip verify (#258): mutation marks pin changed, control stays open --
        if picked_selector:
            # Control pin needs a TRUE style baseline (an empty styles map always
            # diffs as changed — real pins capture styles at pick time).
            control_styles = frame.evaluate(
                "() => { const cs = getComputedStyle(document.body); "
                "const keys = ['color','background-color','font-size','font-family','padding','margin','display','position']; "
                "const o = {}; for (const k of keys) o[k] = cs.getPropertyValue(k); return o }"
            )
            control_id = pg.evaluate(
                "({url, styles}) => window.__reviewStore.getState().addAnnotation({selector: 'body', comment: 'e2e: untouched control', "
                "rect: {x: 0, y: 0, width: 10, height: 10}, styles, url, severity: 'note'}).id",
                {"url": TARGET, "styles": control_styles},
            )
            # Crop the control via the REST endpoint directly (the store seam skips
            # the UI capture hook) — keeps an ACTIONABLE pin carrying a crop so the
            # handoff prompt can be asserted to cite one.
            crop_res = rest("POST", f"{PTY}/preview/crop",
                            {"url": TARGET, "selector": "body", "annotationId": control_id})
            pg.evaluate(
                "({id, path, slug}) => window.__reviewStore.getState().updateAnnotation(id, {cropPath: path, cropSlug: slug})",
                {"id": control_id, "path": crop_res["path"], "slug": crop_res["slug"]},
            )
            frame.evaluate(f"document.querySelector({json.dumps(picked_selector)}).style.color = 'rgb(255, 0, 88)'")
            pg.click("button[title='re-run selectors and check for changes']")
            time.sleep(0.5)
            st = pg.evaluate(
                "sel => { const anns = window.__reviewStore.getState().annotations; return {"
                "picked: anns.find(a => a.selector === sel)?.status, "
                "control: anns.find(a => a.comment === 'e2e: untouched control')?.status, "
                "lv: window.__reviewStore.getState().lastVerify } }",
                picked_selector,
            )
            check("round-trip verify: mutated pin marked changed", st.get("picked") == "changed", str(st.get("picked")))
            check("round-trip verify: untouched pin stays open", st.get("control") == "open", str(st.get("control")))
            lv = st.get("lv") or {}
            check("verify pass recorded with counts", lv.get("counts", {}).get("changed", 0) >= 1,
                  json.dumps(lv.get("counts", {})))

        # -- orphan detection: remove the pinned element ------------------------
        if picked_selector:
            frame.evaluate(f"document.querySelector({json.dumps(picked_selector)})?.remove()")
            time.sleep(1.0)  # observer debounce 300ms + margin
            orphaned = pg.locator("text=e2e: tighten spacing here").count() > 0 and pg.evaluate(
                "window.__reviewStore.getState().annotations.some(a => a.status === 'orphaned')"
            )
            check("orphan detected on DOM mutation (fail-loud)", bool(orphaned))
            retained = pg.evaluate(
                "sel => window.__reviewStore.getState().annotations.find(a => a.selector === sel)?.cropPath",
                picked_selector,
            )
            check("orphaned pin retains its crop", bool(retained) and _os.path.exists(retained), retained or "lost")

        # -- orphan re-pick (#257): re-anchor preserves the comment --------------
        if picked_selector:
            pre_mtime = _os.path.getmtime(retained) if retained and _os.path.exists(retained) else 0
            pg.click("button[title='re-pick: re-attach this comment to a new element']")
            cta = frame.query_selector("#cta") or frame.query_selector("button") or frame.query_selector("p")
            if cta is None:
                raise RuntimeError("no replacement element in target page")
            cta.click(force=True)
            time.sleep(0.5)
            rp = pg.evaluate(
                "() => { const a = window.__reviewStore.getState().annotations.find(x => x.comment === 'e2e: tighten spacing here'); "
                "return a ? { status: a.status, selector: a.selector } : null }"
            )
            check("re-pick: orphaned pin re-anchored, comment preserved",
                  bool(rp) and rp["status"] == "open" and rp["selector"] != picked_selector, json.dumps(rp))
            refreshed = False
            for _ in range(15):
                if retained and _os.path.exists(retained) and _os.path.getmtime(retained) > pre_mtime:
                    refreshed = True
                    break
                time.sleep(1.0)
            check("re-pick: crop refreshed for the new element", refreshed)

        # -- agent handoff: quota-free shell agent via store seam ---------------
        ws = rest("GET", f"{PTY}/workspaces")["workspaces"]
        ws_id = ws[0]["id"] if ws else rest("POST", f"{PTY}/workspaces", {"name": "e2e"})["workspace"]["id"]
        agent = rest("POST", f"{PTY}/agents", {"workspaceId": ws_id, "kind": "shell", "name": "e2e-sink"})["agent"]
        check(
            "token-bearing WS subprotocol upgrade accepted (101)",
            ws_upgrade_status(f"/ws/{agent['id']}", protocols=f"drt, drt.{TOKEN}").startswith("HTTP/1.1 101"),
        )
        pg.evaluate(f"window.__reviewStore.getState().setAgentId({json.dumps(agent['id'])})")
        # the first annotation is now orphaned (send skips it) — add an open one
        pg.evaluate(
            "url => window.__reviewStore.getState().addAnnotation({selector: 'body', comment: 'e2e: handoff item', "
            "rect: {x: 0, y: 0, width: 10, height: 10}, styles: {}, url, severity: 'note'})",
            TARGET,
        )
        pg.click("button[title='send open annotations to agent']", timeout=5000)
        time.sleep(1.5)
        # The verify-note diff lines make the prompt long; PTY echo wraps it across
        # many terminal lines — 50 trimmed the header off the tail.
        sb = rest("GET", f"{PTY}/agents/{agent['id']}/scrollback?lines=400")
        text = "\n".join(sb.get("lines", [])) if isinstance(sb.get("lines"), list) else json.dumps(sb)
        check("structured prompt landed in agent PTY", "Frontend review of" in text and "selector:" in text)
        check("prompt carries the crop reference", "crop:" in text)

        # -- auto verify loop (#258): run-complete detection triggers reload+verify --
        # Arm the watcher, push fresh output through the shell PTY (bytes grow →
        # 'active'), then let it go quiet: watcher completes (~10s quiet + 3s poll)
        # → preview reloads → verify pass with trigger='auto'.
        pg.evaluate("() => window.__reviewStore.getState().setAwaitingAgent(true)")
        time.sleep(3.5)  # let the watcher arm with a byte baseline first
        rest("POST", f"{PTY}/agents/{agent['id']}/input", {"text": "scribe round-trip-ping\n"})
        fired = False
        for _ in range(30):  # up to ~30s for quiet-detection + reload + verify
            time.sleep(1.0)
            st = pg.evaluate(
                "() => ({ awaiting: window.__reviewStore.getState().awaitingAgent, "
                "lv: window.__reviewStore.getState().lastVerify })"
            )
            if not st["awaiting"] and (st.get("lv") or {}).get("trigger") == "auto":
                fired = True
                break
        check("auto verify fired on agent-run-complete (trigger=auto)", fired)

        rest("DELETE", f"{PTY}/agents/{agent['id']}")

        b.close()

    failed = [r for r in RESULTS if not r[1]]
    print(f"\n{'PASS' if not failed else 'FAIL'}: {len(RESULTS) - len(failed)}/{len(RESULTS)} checks")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
