"""Canonical repo-root path for standalone Python scripts (Metis OS).

Use:
    from lib.paths import METIS_HOME          # if scripts/ is on sys.path
    # or
    import paths; paths.METIS_HOME

The default SELF-LOCATES from this file's position (scripts/lib/paths.py), so it
stays correct regardless of what the repo directory is named or where it is moved
-- the keystone that makes the Ant-openclaw-framework -> metis-os rename a no-op
for code. Env-overridable: `export METIS_HOME=...` wins. Mirrors
scripts/lib/paths.env (shell)."""
import os

# repo root = <this file>/../..  (scripts/lib/paths.py -> repo root)
_self_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

METIS_HOME = os.environ.get("METIS_HOME") or _self_root
