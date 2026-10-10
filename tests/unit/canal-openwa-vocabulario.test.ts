import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { getAdapter } from "@/lib/channels";
import { CHANNEL_PROVIDER_OPENWA, capabilitiesOf, transportaMensagem } from "@/lib/channels/capabilities";
import { channelBrand } from "@/lib/channels/presentation";
import { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "@/lib/channels/session-ref";
import { fonteDeTemplates } from "@/lib/channels/templates-fonte";

/**
 * O canal OpenWA (serviço self-hosted HTTP, não-oficial e opt-in) — vocabulário
 * e costuras do seam, no mesmo desenho do gate do canal Datafy
 * (`canal-datafy-vocabulario.test.ts`): perfil, sessionRef, adapter e o par
 * migration × baseline andam juntos, ou nada anda.
 */
const OPENWA = "openwa" as const;
const MIGRATION = "supabase/migrations/20261010120000_0443_canal_openwa.sql";

describe("canal openwa — vocabulário e seam", () => {
  it("declara o perfil de AUTO-restrição, como o canal por QR", () => {
    const caps = capabilitiesOf(CHANNEL_PROVIDER_OPENWA);
    expect(caps.freeformOutsideWindow).toBe(true);
    expect(caps.requiresTemplates).toBe(false);
    expect(caps.banRisk).toBe(true);
    expect(caps.costPerMessage).toBe(false);
    // Sem WABA: não há definição aprovada para gerir nem listar.
    expect(caps.canManageTemplates).toBe(false);
    expect(fonteDeTemplates(OPENWA)).toBeNull();
  });

  it("é canal de MENSAGEM e aparece como WhatsApp, nunca como a marca do fornecedor", () => {
    expect(transportaMensagem(OPENWA)).toBe(true);
    expect(channelBrand({ provider: OPENWA })).toBe("whatsapp");
  });

  it("o sessionRef vem da coluna própria do provider, e ela entra no select", () => {
    expect(resolveSessionRef({ provider: OPENWA, openwa_session_name: "sales" })).toBe("sales");
    expect(CHANNEL_SESSION_REF_COLUMNS).toContain("openwa_session_name");
  });

  it("o adapter existe e os códigos de falha carregam o nome", () => {
    const adapter = getAdapter(OPENWA);
    expect(adapter.provider).toBe(OPENWA);
    expect(adapter.codes.notConfigured).toBe("openwa_nao_configurado");
    expect(adapter.codes.sendFailed).toContain(OPENWA);
  });

  it("migration e baseline conhecem o provider, o ramo do CHECK e o arquivo do webhook", () => {
    const baseline = readFileSync("supabase/baseline.sql", "utf8");
    expect(baseline).toMatch(/channel_sessions_provider_check[\s\S]{0,600}'openwa'::text/);
    expect(baseline).toMatch(/provider = 'openwa'\s+and openwa_session_name\s+is not null/);
    expect(baseline).toMatch(/webhook_events_log_provider_check check \(provider in \([^)]*'openwa'/);
    // A coluna ANTES do CHECK que a referencia — senão o install quebra.
    expect(baseline.indexOf("add column if not exists openwa_session_name")).toBeLessThan(
      baseline.indexOf("(provider = 'openwa'"),
    );

    const mig = readFileSync(MIGRATION, "utf8");
    expect(mig).toContain("add column if not exists openwa_session_name");
    expect(mig).toMatch(/provider = 'openwa' and openwa_session_name is not null/);
    expect(mig).toContain("'openwa'");

    const manifest = readFileSync("supabase/migrations/MANIFEST.md", "utf8");
    expect(manifest).toContain("`0443_canal_openwa`");
  });
});
