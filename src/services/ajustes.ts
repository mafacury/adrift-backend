import { pool } from '../db/pool.js';

/**
 * Os botões do ritmo — lidos do banco, giráveis pelo painel, sem deploy.
 *
 * Antes daqui o ritmo do app morava em três lugares: constante em routing.ts
 * (velocidade, cota diária, fila), variável de ambiente (prazo de resposta) e
 * uma tabela `system_settings` com quatro chaves que ninguém lia. Ajustar a
 * experiência exigia deploy justamente na hora em que não dá para esperar —
 * com gente testando e o retorno chegando.
 *
 * O cache existe porque estes valores entram em consulta de roteamento, que
 * roda a cada minuto para cada barco. Ele é limpo na hora em que o painel
 * salva (mesma instância), e ainda assim expira sozinho — se um dia o Adrift
 * rodar em duas instâncias, a outra pega o valor novo em no máximo um minuto
 * em vez de nunca.
 */

const VALIDADE_MS = 60_000;

let cache: Record<string, string> | null = null;
let carregadoEm = 0;

/** Chamado pelo painel ao salvar: o valor novo vale já na próxima consulta. */
export function limparCacheDeAjustes(): void {
  cache = null;
}

async function tabela(): Promise<Record<string, string>> {
  if (cache && Date.now() - carregadoEm < VALIDADE_MS) return cache;
  try {
    const { rows } = await pool.query(
      `SELECT key, value FROM system_settings WHERE kind <> 'text'`,
    );
    const lido: Record<string, string> = Object.fromEntries(
      rows.map((r) => [r.key as string, r.value as string]),
    );
    cache = lido;
    carregadoEm = Date.now();
    return lido;
  } catch (err) {
    console.error('[ajustes] nao consegui ler system_settings:', err);
    // Banco fora do ar não pode parar o roteamento: sem tabela, cada chamada
    // cai no padrão que veio junto do pedido.
    return cache ?? {};
  }
}

/**
 * Um número do painel, com o padrão de quem chamou.
 *
 * O padrão não é enfeite: é ele que vale quando a chave ainda não existe (base
 * antiga), quando alguém apaga a linha, e quando o valor gravado não é número.
 * Assim nenhum ajuste torto derruba o fluxo — no pior caso o app volta ao que
 * era antes de existir painel.
 */
export async function ajuste(chave: string, padrao: number): Promise<number> {
  const t = await tabela();
  const n = Number(t[chave]);
  return Number.isFinite(n) && n > 0 ? n : padrao;
}

/** Todos de uma vez, para quem precisa de vários na mesma consulta. */
export async function ajustesDoFluxo(): Promise<{
  travessiaBaseMin: number;
  travessiaKmPorMin: number;
  travessiaTetoMin: number;
  barcosPorDia: number;
  filaMaxima: number;
  prazoRespostaHoras: number;
}> {
  const t = await tabela();
  const n = (chave: string, padrao: number) => {
    const v = Number(t[chave]);
    return Number.isFinite(v) && v > 0 ? v : padrao;
  };
  return {
    travessiaBaseMin:   n('travessia_base_min', 20),
    travessiaKmPorMin:  n('travessia_km_por_min', 30),
    travessiaTetoMin:   n('travessia_teto_min', 720),
    barcosPorDia:       n('barcos_por_dia', 8),
    filaMaxima:         n('fila_maxima', 2),
    prazoRespostaHoras: n('prazo_resposta_horas', 12),
  };
}
