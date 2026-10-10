/**
 * O portão da base que vem DO BANCO (`baseDeSessaoAceita`) — allowlist da
 * instalação (`OPENWA_ALLOWED_ORIGINS`), não URL aberta. Puro, sem servidor:
 * cada regra tem uma sonda, e cada sonda mata o mutante que a removesse.
 *
 * O que está sob teste é ENTRADA hostil: a string que um dia uma tela grava
 * em `channel_sessions.openwa_base_url`. O portão é fail-closed — `null` em
 * qualquer dúvida, e `null` vira `openwa_base_invalida` na resolução.
 */
import { afterEach, describe, expect, it } from "vitest";

import { baseDeSessaoAceita } from "./client";

const PROD = { testMode: false } as const;
const TESTE = { testMode: true } as const;

afterEach(() => {
  delete process.env.OPENWA_ALLOWED_ORIGINS;
});

describe("baseDeSessaoAceita — a allowlist da instalação é o portão", () => {
  it("SEM entrada na allowlist, NADA passa — nem https com nome bonito", () => {
    delete process.env.OPENWA_ALLOWED_ORIGINS;
    expect(baseDeSessaoAceita("https://openwa.acme.com", PROD)).toBeNull();
    process.env.OPENWA_ALLOWED_ORIGINS = "https://outro-servico.acme.com";
    // Um atacante não precisa de IP: um host DELE em https já roubaria a chave.
    expect(baseDeSessaoAceita("https://coletor.evil.com", PROD)).toBeNull();
    expect(baseDeSessaoAceita("https://openwa.acme.com", PROD)).toBeNull();
  });

  it("COM a origem exata na allowlist, passa — inclusive porta não-padrão", () => {
    process.env.OPENWA_ALLOWED_ORIGINS = "https://openwa.acme.com, https://wa2.acme.com:8443";
    expect(baseDeSessaoAceita("https://openwa.acme.com", PROD)).toBe("https://openwa.acme.com");
    expect(baseDeSessaoAceita("https://openwa.acme.com/api/", PROD)).toBe("https://openwa.acme.com/api");
    expect(baseDeSessaoAceita("https://wa2.acme.com:8443", PROD)).toBe("https://wa2.acme.com:8443");
    // A MESMA origem sem a porta da entrada não é a entrada.
    expect(baseDeSessaoAceita("https://wa2.acme.com", PROD)).toBeNull();
    expect(baseDeSessaoAceita("https://openwa.acme.com:8443", PROD)).toBeNull();
  });

  it("http só quando a PRÓPRIA entrada é http (exceção explícita do operador)", () => {
    process.env.OPENWA_ALLOWED_ORIGINS = "http://openwa-interno:3000";
    expect(baseDeSessaoAceita("http://openwa-interno:3000", PROD)).toBe("http://openwa-interno:3000");
    // https para o mesmo host NÃO é a entrada http — e vice-versa.
    expect(baseDeSessaoAceita("https://openwa-interno:3000", PROD)).toBeNull();
    // http nunca passa por default.
    expect(baseDeSessaoAceita("http://openwa.acme.com", PROD)).toBeNull();
  });

  it("entrada da allowlist com USERINFO lança na carga — contrabando não se normaliza", () => {
    // O ataque: `https://wa.example.com@169.254.169.254` PARSEIA com host
    // 169.254.169.254 — normalizada, a allowlist passaria a AUTORIZAR o
    // metadata da nuvem. Isso não se normaliza: erro feio na carga.
    process.env.OPENWA_ALLOWED_ORIGINS = "https://wa.example.com@169.254.169.254";
    expect(() => baseDeSessaoAceita("https://169.254.169.254", PROD)).toThrow(
      "openwa_allowlist_com_userinfo",
    );
    // E o erro aparece para QUALQUER consulta — a configuração está quebrada,
    // não só aquele destino.
    expect(() => baseDeSessaoAceita("https://wa.example.com", PROD)).toThrow(
      "openwa_allowlist_com_userinfo",
    );
  });

  it("entrada malformada na allowlist é ignorada, não quebra o portão", () => {
    process.env.OPENWA_ALLOWED_ORIGINS = "não é url,, https://openwa.acme.com";
    expect(baseDeSessaoAceita("https://openwa.acme.com", PROD)).toBe("https://openwa.acme.com");
    expect(baseDeSessaoAceita("https://não é url", PROD)).toBeNull();
  });
});

describe("baseDeSessaoAceita — literal de IP: fechado, salvo exceção EXPLÍCITA do operador", () => {
  it("metadata da nuvem, RFC1918, loopback e v6 não passam por default", () => {
    delete process.env.OPENWA_ALLOWED_ORIGINS;
    for (const hostil of [
      "https://169.254.169.254/latest/meta-data",
      "https://169.254.169.254",
      "https://10.0.0.5",
      "https://172.16.0.1",
      "https://192.168.1.1",
      "https://127.0.0.1",
      "https://0.0.0.0",
      "https://[::1]",
      "https://[fd00::1]",
      "https://[fe80::1]",
      "https://[::ffff:169.254.169.254]",
    ]) {
      expect(baseDeSessaoAceita(hostil, PROD), hostil).toBeNull();
    }
  });

  it("IP literal SÓ passa quando a entrada da allowlist é aquele IP exato", () => {
    process.env.OPENWA_ALLOWED_ORIGINS = "https://192.168.10.20:8443";
    expect(baseDeSessaoAceita("https://192.168.10.20:8443", PROD)).toBe("https://192.168.10.20:8443");
    expect(baseDeSessaoAceita("https://192.168.10.20", PROD)).toBeNull();
    expect(baseDeSessaoAceita("https://192.168.10.21:8443", PROD)).toBeNull();
  });
});

describe("baseDeSessaoAceita — userinfo, modo de teste e normalização", () => {
  it("userinfo é recusado SEMPRE — nem a allowlist abre", () => {
    process.env.OPENWA_ALLOWED_ORIGINS = "https://openwa.acme.com";
    expect(baseDeSessaoAceita("https://user:pass@openwa.acme.com", PROD)).toBeNull();
    expect(baseDeSessaoAceita("https://openwa.acme.com@169.254.169.254/", TESTE)).toBeNull();
  });

  it("modo de teste: loopback http passa sem allowlist; fora dele, nem loopback", () => {
    delete process.env.OPENWA_ALLOWED_ORIGINS;
    expect(baseDeSessaoAceita("http://127.0.0.1:3000", TESTE)).toBe("http://127.0.0.1:3000");
    expect(baseDeSessaoAceita("http://localhost:3000", TESTE)).toBe("http://localhost:3000");
    expect(baseDeSessaoAceita("http://[::1]:3000/", TESTE)).toBe("http://[::1]:3000");
    expect(baseDeSessaoAceita("http://127.0.0.1:3000", PROD)).toBeNull();
    // E em teste, http NÃO-loopback continua fechado.
    expect(baseDeSessaoAceita("http://169.254.169.254", TESTE)).toBeNull();
    expect(baseDeSessaoAceita("http://10.0.0.5", TESTE)).toBeNull();
  });

  it("esquema estranho, vazio e query/fragmento", () => {
    process.env.OPENWA_ALLOWED_ORIGINS = "https://openwa.acme.com";
    expect(baseDeSessaoAceita("ftp://openwa.acme.com", PROD)).toBeNull();
    expect(baseDeSessaoAceita("não é url", PROD)).toBeNull();
    expect(baseDeSessaoAceita(undefined, PROD)).toBeNull();
    expect(baseDeSessaoAceita("   ", PROD)).toBeNull();
    // Query e fragmento não sobrevivem à normalização.
    expect(baseDeSessaoAceita("https://openwa.acme.com/api/?token=x#frag", PROD)).toBe(
      "https://openwa.acme.com/api",
    );
  });
});
