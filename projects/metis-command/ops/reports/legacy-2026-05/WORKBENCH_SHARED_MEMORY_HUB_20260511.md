# Workbench Shared Memory Hub Foundation
Date: 2026-05-11
Owner: Worker 3

## Scope
Implemented a local-first BridgeMemory-style markdown knowledge hub foundation without touching server or UI files.

## Changed Paths
- `lib/workbench-memory.ts`
- `tests/workbench-memory.test.ts`
- `WORKBENCH_SHARED_MEMORY_HUB_20260511.md`

## Behavior
- Discovers a workspace memory directory with `.workbenchmemory/` preferred and `.bridgememory/` accepted for compatibility.
- Can create markdown notes with simple frontmatter-ish metadata:
  - `id`
  - `title`
  - `tags`
  - `createdAt`
  - `updatedAt`
  - optional safe scalar/list metadata fields
- Lists and reads recursive `.md` notes.
- Searches notes by text and tags with deterministic scoring.
- Extracts `[[wikilinks]]`, including `[[Target#Heading|label]]`.
- Finds backlinks to a target note/title.
- Suggests simple connections from shared tags, direct links, backlinks, and shared terms.

## Verification
- `node --import tsx --test tests/workbench-memory.test.ts` passes 7/7.
- Narrow strict check for owned files passes:
  - `npx tsc --noEmit --target ES2017 --lib esnext,dom --module esnext --moduleResolution bundler --strict --esModuleInterop --skipLibCheck --types node lib/workbench-memory.ts tests/workbench-memory.test.ts`
- Full `npm run typecheck` is currently blocked by unrelated concurrent syntax errors in `lib/mission-packet.ts`.

## Future MCP Hooks
- Add read-only tools first:
  - `discover_memory_dir({ workspace_root })`
  - `list_memory_notes({ workspace_id })`
  - `search_memory_notes({ workspace_id, text, tags })`
  - `get_memory_backlinks({ workspace_id, target })`
  - `suggest_memory_connections({ workspace_id, note })`
- Add write tools after permission/auth behavior is clear:
  - `create_memory_note({ workspace_id, title, body, tags, metadata })`
- Route tools through existing workspace root resolution, then call `ensureMemoryDir(workspace.cwd)` or `discoverMemoryDir(workspace.cwd)`.
- Keep writes local-only and auditable through the existing dispatch/evidence patterns if agents create notes automatically.

## Future UI Hooks
- Add a right-rail Knowledge tab beside Assistant/Notes/MCP.
- Surface search, tags, backlinks, and suggested connections from this helper module.
- Let task detail link memory notes as knowledge attachments without replacing current workspace notes.
- Keep `.workbenchmemory/` as the Workbench-native default while still reading `.bridgememory/` projects.
