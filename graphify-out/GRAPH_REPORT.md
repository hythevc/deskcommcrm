# Repository knowledge graph

Read this report first, then AGENTS.md and DESIGN.md when present. DESIGN.md is absent in this snapshot; repository design guidance is under docs/design-system/. This graph is navigation evidence, not permission, runtime proof or a security assessment.

## What was extracted

Source commit: `f322ca41bc40c538803b173d7ce0003143df793b`. Source is committed HEAD, excluding generated graph files and the pending documentation/test changes from earlier slices. The later AGENTS.md pointer is the only tracked source change in this deliverable.

The graph contains **44,543 entities and 79,601 edges**, covering **5,552 tracked text source/config/doc files**. Non-text/binary assets, environment templates, ignored local state and secrets are excluded. Source bodies, literal account data and raw document heading text are not copied into the graph. Each file carries its Git blob and content SHA-256. Unsupported source languages have file-level metadata/topic coverage, not claimed symbol extraction.

- **EXTRACTED**: AST declarations/import specifiers; literal local documentation references; section locations; lexical SQL declaration tokens. These labels establish source syntax/reference presence, not runtime dependency or current database state.
- **INFERRED**: keyword topic associations, framework route conventions and all community assignments. Keyword tags ignore negation and context. Routes are filesystem interpretations, not verified endpoints.
- **AMBIGUOUS**: unresolved local references/imports, and community membership that cannot be assigned. Missing documentation targets can be outdated plans, aliases or extraction limitations; they are not automatically defects.

Node labels: {'EXTRACTED': 41338, 'INFERRED': 526, 'AMBIGUOUS': 2679}. Edge labels: {'AMBIGUOUS': 3781, 'EXTRACTED': 63732, 'INFERRED': 12088}. TypeScript/JavaScript files with parse errors: 0. Package imports are lexical specifiers; package export resolution is not performed. SQL entities aggregate qualified names across versions/declarations and do not disambiguate function overloads or prove applied migrations.

## Cross-file communities

Weighted Louvain (NetworkX 3.5, seed 17) groups files, shared SQL declaration names and inferred topic nodes. Symbols inherit their file's assignment. Import/re-export edges weight 3, local documentation references 2, SQL declaration links 1 and keyword topics 0.15. These choices bias clusters toward explicit cross-file links while retaining weak semantic links; community names and membership are **INFERRED**.

There are **217 file-containing groups**, **27 spanning multiple files**, and **187 isolated files**. A cluster is an exploration aid, not an architectural boundary. Tests and documents can join implementation clusters through references and shared inferred topics.

Largest groups (sample paths, not an exhaustive membership list):

- Community 0: 886 files; inferred topics interface. Examples: `app/admin/(protected)/audit/[entryId]/_client.tsx`, `app/admin/(protected)/audit/[entryId]/page.tsx`, `app/admin/(protected)/audit/_client.tsx`.
- Community 1: 865 files; inferred topics authentication, governance. Examples: `.agents/skills/deskcomm-contribuir/scripts/pre-voo.sh`, `.agents/skills/deskcomm-extensao/scripts/validar-pacote.sh`, `.claude/skills/deskcomm-contribuir/scripts/pre-voo.sh`.
- Community 2: 586 files; inferred topics operations. Examples: `.agents/rules/deskcomm-guias.md`, `.agents/skills/deskcomm-contribuir/SKILL.md`, `.agents/skills/deskcomm-contribuir/references/depois-do-pr.md`.
- Community 3: 462 files; inferred topics messaging, privacy, tenancy. Examples: `.github/workflows/e2e.yml`, `app/app/settings/tenant/whatsapp/page.tsx`, `docs/architecture/acervo-de-conhecimento.architecture.json`.
- Community 4: 441 files; inferred topics agents. Examples: `app/actions/settings/updateComportamento.ts`, `app/actions/settings/updateDestinosInternos.ts`, `app/api/v1/ai/cases/[id]/reply/route.ts`.
- Community 5: 403 files; inferred topics none. Examples: `.agents/skills/deskcomm-extensao/references/testar-local.md`, `.claude/skills/deskcomm-extensao/references/testar-local.md`, `.github/workflows/relogio.yml`.
- Community 6: 313 files; inferred topics none. Examples: `app/api/internal/agents/run/route.ts`, `app/api/mcp/route.ts`, `app/api/v1/agenda/agendamentos/_handler.ts`.
- Community 7: 304 files; inferred topics none. Examples: `.specs/features/crm-automacao-fluxos/design.md`, `.specs/features/crm-automacao-fluxos/spec.md`, `.specs/features/crm-automacao-fluxos/tasks.md`.
- Community 8: 249 files; inferred topics none. Examples: `app/api/v1/channel-sessions/[id]/pairing-code/route.test.ts`, `app/api/v1/channels/social/route.test.ts`, `app/api/v1/channels/templates/route.ts`.
- Community 9: 220 files; inferred topics none. Examples: `.agents/skills/deskcomm-metricas/SKILL.md`, `.agents/skills/deskcomm-metricas/references/acesso-e-lgpd.md`, `.agents/skills/deskcomm-metricas/references/consultas.md`.
- Community 10: 172 files; inferred topics none. Examples: `.agents/skills/deskcomm-extensao/SKILL.md`, `.agents/skills/deskcomm-extensao/references/contrato-do-pacote.md`, `.agents/skills/deskcomm-extensao/references/enviar-e-revisao.md`.
- Community 11: 154 files; inferred topics none. Examples: `app/api/v1/ai/agents/assignable/route.ts`, `app/api/v1/ai/jev/route.ts`, `app/api/v1/ai/knowledge/sources/route.ts`.

## How to use it

Open index.html locally for the community/file explorer; it embeds a reduced index and uses no CDN or external requests. The visualization shows inferred communities, not every edge. Search files, filter communities and inspect the source locations/evidence labels in graph.json before acting on a relationship. File references in the explorer are labels, not links to a running app.

Use the graph to find owners of a module/route/table, related docs and tests, and disconnected or ambiguous references. Validate each proposed change against its actual source and executable checks. Inferences are hypotheses. The accepted sandbox storage issue is historical: do not pull images or boot here; boot/account work remains owner-routed elsewhere.

## Reproduce and validate

From repository root, with installed project TypeScript and Python NetworkX 3.5:

```bash
python graphify-out/prepare_snapshot.py SOURCE_COMMIT
node graphify-out/build_graph.cjs
python graphify-out/detect_communities.py
node graphify-out/validate_graph.cjs
```

The snapshot helper writes temporary source bodies only to ignored .prova/graphify/. NetworkX can be installed from the package registry into .prova/graphify/vendor. Supply the recorded source SHA, not the later graph commit, to reproduce this source boundary. Iteration order and clustering seed are fixed; dependency/runtime versions can still affect byte-for-byte community output. Static report/explorer generation is separate from extraction; their scope is documented here.

## Limits and publication

This is a local evidence-first extractor, not a claim that an unavailable Graphify package ran. Its coverage is strongest for TypeScript/JavaScript syntax and literal references. It does not resolve dynamic imports, runtime calls, business semantics, SQL execution, source-language symbols outside its supported parser or all Markdown anchors. Heading labels retain section number/location to avoid copying names or incidental data.

Only graphify-out/ and the one-line AGENTS.md pointer are authorized for this commit/PR. graphify-out/ is normally ignored; this deliverable is explicitly force-added without changing .gitignore. Existing AGENTS.md references to normally absent graph output describe the default workflow; this bootstrap snapshot is the explicit exception. Pending earlier-slice files are preserved and excluded.

Draft PR publication is authorized for this deliverable only. Independent different-family ACCEPT and exact-head CI remain pending; no merge or launch-readiness claim.
