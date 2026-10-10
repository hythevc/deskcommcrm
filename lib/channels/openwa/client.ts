/**
 * Cliente HTTP mínimo do OpenWA — o transporte do canal não-oficial opt-in.
 *
 * ─── O que este serviço É ──────────────────────────────────────────────────
 *
 * Um processo `@open-wa/wa-automate` (Easy API, v5) rodando FORA deste app —
 * outra máquina, outro contêiner. Nenhuma linha de código do OpenWA é copiada
 * ou embutida aqui: a fronteira é HTTP puro, e o contrato deste arquivo foi
 * lido da documentação pública (openwa.dev, 10/10/2026):
 *
 *   - Envio:    `POST {base}/api/messages/sendText` (rota primária namespaced;
 *               `/api/sendText` é o alias), corpo `{to, content}` — `chatId` e
 *               `text` são ALIASES aceitos, mas o nome canônico é o do método
 *               (`sendText(to, content)`).
 *               (openwa.dev/docs/reference — "Method routes follow the schema
 *               registry metadata… Namespaced routes use the namespace first")
 *   - Auth:     header `X-API-Key` em TODA chamada protegida — nunca na URL
 *               (openwa.dev/docs/getting-started/easy-api — "send that key
 *               with each request in the `X-API-Key` header").
 *   - Retorno:  `MessageId | boolean | string` — string com o id
 *               (`true_<chat>_<hash>`) ou `false` quando o envio é recusado
 *               (openwa.dev/docs/reference/client/send-text-worked-example —
 *               "output: MessageId | boolean | string").
 *   - Saúde:    `GET {base}/health` — rota PÚBLICA, responde
 *               `{connected: boolean, session: {ready: boolean, ...}}`
 *               (mesma página: "Proceed with messaging only when the response
 *               contains `"connected": true` and `"session": { "ready": true }`").
 *
 * ─── De onde vem a credencial ──────────────────────────────────────────────
 *
 * Este arquivo só TRANSPORTA: quem decide a base e a chave de CADA sessão é
 * `./credentials.ts` (sessão da organização em `channel_sessions` primeiro,
 * `OPENWA_API_BASE_URL`/`OPENWA_API_KEY` do ambiente como fallback de
 * instalação de serviço único — o mesmo contrato de `meta/credentials.ts`).
 *
 * ─── O erro diz o status, nunca o corpo ────────────────────────────────────
 *
 * Mesma doutrina do transporte irmão (`lib/waha/client.ts`): o corpo de erro
 * de um serviço de terceiro pode conter qualquer coisa — mensagem de cliente,
 * identificador, segredo — e `lib/logger` proíbe propagá-lo. O status HTTP vai
 * no NOME do erro (`openwa_http_401`), que é o que separa "credencial
 * recusada" (4xx) de "o serviço quebrou" (5xx).
 */

/** Mesmo teto do transporte irmão: 15s, prescrevido na spec 03 (ver lib/waha/client.ts). */
export const TETO_PADRAO_MS = 15_000;

/** O que a rota pública `/health` responde (os campos que lemos). */
export interface OpenwaHealth {
  connected?: boolean;
  session?: { ready?: boolean; state?: string };
}

export class OpenwaClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {}

  /**
   * Envia texto. Devolve o id que o serviço retornou, ou `null` quando a
   * resposta não traz id reconhecível — o adapter grava essa diferença
   * (`externalId` nulo ≠ envio confirmado).
   */
  async sendText(to: string, content: string): Promise<string | null> {
    const res = await this.pedir("/api/messages/sendText", {
      method: "POST",
      body: JSON.stringify({ to, content }),
    });
    const corpo: unknown = await res.json().catch(() => null);
    if (corpo === false) throw new Error("openwa_send_recusado");
    if (typeof corpo === "string" && corpo.length > 0) return corpo;
    // Formas novas que o serviço possa devolver (objeto com id) não derrubam o
    // envio: sem id reconhecível, `null` — o chamador decide como gravar.
    if (corpo && typeof corpo === "object" && typeof (corpo as { id?: unknown }).id === "string") {
      return (corpo as { id: string }).id;
    }
    return null;
  }

  /** A saúde pela rota pública. Lança `openwa_http_<status>` no não-2xx. */
  async health(): Promise<OpenwaHealth> {
    const res = await this.pedir("/health", { method: "GET" });
    const corpo: unknown = await res.json().catch(() => ({}));
    return (corpo ?? {}) as OpenwaHealth;
  }

  private async pedir(caminho: string, init: RequestInit): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${caminho}`, {
        ...init,
        // NUNCA seguir redirect: um 3xx levaria o X-API-Key e o corpo (dado de
        // cliente) para o destino que a RESPOSTA escolhesse. `manual` entrega o
        // 3xx aqui, e ele vira erro nomeado abaixo — nunca um vazamento.
        redirect: "manual",
        headers: {
          "X-API-Key": this.apiKey,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(TETO_PADRAO_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === "TimeoutError") {
        throw new Error(`openwa_timeout: ${caminho} não respondeu em ${TETO_PADRAO_MS}ms`);
      }
      // Qualquer outra falha de rede vira CÓDIGO, nunca o texto cru: a
      // mensagem de DNS/socket carrega pedaço de destino e de infraestrutura
      // (a sonda do checker mostrou o sentinela atravessando), e este erro
      // vai para `metadata`/`error_code` e para o detalhe de saúde na tela.
      throw new Error("openwa_rede_inacessivel");
    }
    if (res.status >= 300 && res.status < 400) {
      // O Location NÃO é lido nem propagado: ele é a seta do vazamento.
      throw new Error(`openwa_redirect_recusado: ${res.status}`);
    }
    if (!res.ok) throw new Error(`openwa_http_${res.status}`);
    return res;
  }
}

/**
 * A base configurada é aceitável? Só URL absoluta `http(s)`, sem query nem
 * fragmento — o mesmo portão do homólogo da Meta (`meta/graph-base.ts`), que
 * separa destino de chamada de fenda de SSRF. Recusa ABERTA no aviso e FECHADA
 * na ação: valor ruim vira "não configurado", nunca chamada para um destino
 * que o operador não escolheu.
 */
export function baseAceita(valor: string | undefined): string | null {
  const trimmed = valor?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/**
 * O portão da base que vem DO BANCO (a URL que a organização gravou) —
 * allowlist da INSTALAÇÃO, não URL aberta.
 *
 * Por que allowlist, e não "qualquer https": essa string é ENTRADA — um dia
 * chega por uma tela, e o que a tela grava é o que um digitador qualquer
 * escreveu. "Qualquer https com nome de host" ainda deixaria a organização
 * apontar a chave DELA para um host que o atacante controla
 * (`https://coletor.evil.com` passa em todo filtro de esquema) e receber
 * `X-API-Key` + corpo de mensagem a cada envio. O que fecha isso não é
 * heurística: é o operador da instalação dizer, no AMBIENTE, quais origens um
 * serviço OpenWA pode ter — `OPENWA_ALLOWED_ORIGINS`, vírgulas, origens
 * completas (`https://wa1.example.com`, `https://wa2.example.com:8443`).
 *
 * Regras (fail-closed — qualquer dúvida é `null`, e `null` vira
 * `openwa_base_invalida` em `credentials.ts`, nunca fallback):
 *
 *   - A ORIGEM (`esquema://host[:porta]`) tem de estar, byte a byte depois de
 *     normalizada, na allowlist. Fora dela: recusa — inclusive https bonito.
 *   - `https:` é o padrão; `http:` só quando a PRÓPRIA entrada da allowlist é
 *     `http:` (exceção explícita do operador, ex.: serviço na mesma rede
 *     interna) — ou em MODO DE TESTE para loopback, que é o que permite o
 *     servidor falso do contrato.
 *   - Literal de IP (v4 ou v6) é recusado A MENOS que a entrada da allowlist
 *     seja aquele IP exato — a exceção é do operador, nunca do digitador.
 *     Assim `169.254.169.254`, RFC1918, ULA v6 e qualquer range novo estão
 *     fechados por default. Resolução DNS não é feita aqui (escolha
 *     declarada): a allowlist é o controle auditável, e quem aponta um NOME
 *     para dentro da rede é o operador, na entrada dele.
 *   - Sem `usuario:senha@` (userinfo esconde o destino real aos olhos),
 *     sempre — nem a allowlist abre isso.
 */
export function baseDeSessaoAceita(
  valor: string | undefined,
  opts: { testMode?: boolean } = {},
): string | null {
  const trimmed = valor?.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const testMode =
    opts.testMode ?? (process.env.VITEST === "true" || process.env.NODE_ENV === "test");
  const host = url.hostname.toLowerCase();
  const loopback =
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1" ||
    (/^\d+\.\d+\.\d+\.\d+$/.test(host) && host.split(".").map(Number)[0] === 127);
  const origem = `${url.protocol}//${url.host}`;

  // Modo de teste: loopback http passa sem allowlist — os servidores falsos
  // do contrato sobem em porta aleatória. Este ramo não existe em produção.
  if (testMode && loopback && url.protocol === "http:") {
    return `${origem}${url.pathname.replace(/\/+$/, "")}`;
  }

  const permitidas = (process.env.OPENWA_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim().toLowerCase())
    .filter(Boolean)
    .map((o) => {
      let u: URL;
      try {
        u = new URL(o);
      } catch {
        return null; // entrada malformada: ignorada, não quebra o portão
      }
      // Userinfo numa ENTRADA é tentativa de contrabando:
      // `https://wa.example.com@169.254.169.254` normalizaria para a ORIGEM DO
      // IP — e a allowlist passaria a autorizar o metadata da nuvem. Isso não
      // se normaliza: se ERRA FEIO na carga da configuração, para o operador
      // ver a entrada adulterada em vez de ela funcionar "com outro sentido".
      if (u.username || u.password) {
        throw new Error("openwa_allowlist_com_userinfo");
      }
      return `${u.protocol}//${u.host}`;
    })
    .filter((o): o is string => o !== null);

  if (!permitidas.includes(origem)) return null;
  // A entrada da allowlist É a exceção: http explícito ou IP explícito só
  // passam porque o operador escreveu ESTA origem. Sem entrada, nem https.
  if (url.protocol === "http:" && !testMode) {
    // http permitido porque a entrada é http — mas literal de IP em http só
    // se a entrada for o IP exato (já garantido pelo `includes` acima).
  }
  return `${origem}${url.pathname.replace(/\/+$/, "")}`;
}
