import { pool } from '../db/pool.js';

/**
 * O rastro: quem fez o quê, e o que o servidor respondeu.
 *
 * Isto não substitui o log do Fastify — ele continua escrevendo tudo na saída
 * padrão, e o Railway continua guardando. O que ele não faz é responder à
 * pergunta que a gente realmente tem: "o fulano diz que perdeu um barco ontem
 * à noite; o que ele fez?". Log de saída padrão não tem conta, não tem busca, e
 * some junto com o plano de retenção.
 *
 * ── O que entra ────────────────────────────────────────────────────────────
 *
 * Não é tudo, e a escolha é o ponto. Registrar toda requisição faria da tabela
 * a maior do banco em poucas semanas, e 95% dela seria GET que deu certo — o
 * app conversa muito com o servidor. O que serve para investigar é:
 *
 *   1. tudo que MUDA alguma coisa (qualquer método que não seja GET)
 *   2. tudo que FALHOU (status ≥ 400, inclusive GET)
 *
 * Uma leitura que deu certo não explica nada que a gente não possa reconstruir
 * a partir do estado. Uma escrita, sim: é ela que criou o estado.
 *
 * ── O que não entra, e por quê ─────────────────────────────────────────────
 *
 * Corpo nenhum, nem da requisição nem da resposta. Duas razões, e as duas são
 * duras:
 *
 *   • o corpo da requisição carrega o texto das mensagens. Os Termos dizem que
 *     o que estranhos escrevem uns aos outros não sai do Adrift. Uma tabela de
 *     log que a gente lê no painel é exatamente "sair".
 *   • o corpo carrega a SENHA. `DELETE /users/me` manda a senha no corpo em vez
 *     da barra de endereço justamente para não deixá-la no log — está escrito
 *     em services/api.ts. Guardar corpo aqui desfaria aquela decisão em
 *     silêncio, que é a pior forma de desfazer.
 *
 * Do erro guardamos só o CÓDIGO (`limite_de_barcos`, `conta_suspensa`), nunca a
 * frase. O código é vocabulário nosso, fechado. A frase é texto que já foi
 * traduzido, interpolado e, em alguns casos, montado com dado da pessoa.
 */

/** Aos 30 dias a linha vai embora. Ver `podarRastro`. */
const DIAS = 30;

/** Rotas que não valem uma linha: barulho de monitoramento. */
const IGNORAR = new Set(['/health', '/favicon.ico']);

export function vaiRegistrar(method: string, path: string, status: number): boolean {
  if (IGNORAR.has(path)) return false;
  return method !== 'GET' || status >= 400;
}

/**
 * Grava uma linha. Sem `await` de propósito, e com `.catch` obrigatório:
 * observar não pode atrasar nem derrubar o que está sendo observado. Se o
 * banco recusar a escrita do log, a requisição da pessoa já foi respondida e
 * não é assunto dela.
 */
export function registrar(l: {
  userId?: string | null;
  reqId?: string | null;
  method: string;
  path: string;
  status: number;
  ms: number;
  erro?: string | null;
}): void {
  void pool.query(
    `INSERT INTO request_log (user_id, req_id, method, path, status, ms, erro)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      l.userId ?? null,
      l.reqId ?? null,
      l.method,
      // A rota, não o endereço. `/boats/abc-123` vira ruído: cada barco cria
      // um valor único e some a chance de contar "quantas vezes esta rota
      // falhou". O identificador continua legível na coluna, só não vira
      // chave — quem investiga uma conta lê a linha inteira de qualquer jeito.
      l.path.slice(0, 200),
      l.status,
      Math.round(l.ms),
      l.erro ? l.erro.slice(0, 80) : null,
    ],
  ).catch(() => {});
}

/**
 * Lê o código do erro do corpo da resposta, quando ela falhou.
 *
 * Aceita só o campo `error`, que nas rotas novas é código fechado. Rota antiga
 * manda frase pronta ali ("Email já cadastrado."); por isso o corte em 80
 * caracteres e por isso nunca lemos `message`, que é sempre frase.
 */
export function codigoDoErro(payload: unknown): string | null {
  if (typeof payload !== 'string' || payload.length > 4000) return null;
  try {
    const o = JSON.parse(payload);
    return typeof o?.error === 'string' ? o.error : null;
  } catch {
    return null;
  }
}

/**
 * A poda.
 *
 * Uma tabela de log sem poda não é um sistema de log: é uma bomba-relógio que
 * ninguém vê até a conta do banco chegar ou o disco encher. Trinta dias é mais
 * do que a distância entre "aconteceu comigo" e "fui contar para alguém".
 */
export async function podarRastro(): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM request_log WHERE at < NOW() - INTERVAL '${DIAS} days'`,
  );
  return rowCount ?? 0;
}

/**
 * Nota: apagar o rastro de quem excluiu a conta NÃO mora aqui.
 *
 * Mora dentro da transação de `excluirConta` (services/exclusao.ts), junto com
 * os outros passos. Se morasse aqui, como função à parte, seria uma escrita
 * fora da transação: a exclusão poderia ser desfeita por um ROLLBACK e o
 * rastro já teria ido embora — ou o contrário, a conta apagada e o rastro
 * ainda de pé. Um passo da exclusão pertence à exclusão.
 */
