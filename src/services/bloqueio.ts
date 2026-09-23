/**
 * O bloqueio entre duas pessoas, em SQL.
 *
 * Mora aqui, e não solto em cada consulta, porque a regra tem uma sutileza que
 * é fácil escrever errado uma vez em cinco: o bloqueio vale para os DOIS
 * LADOS. Quem bloqueou e quem foi bloqueado somem um do outro por igual — nem
 * o texto de um chega ao outro, nem barco de um cai na mão do outro.
 *
 * Se só a coluna `blocker_user_id` fosse consultada, quem bloqueia deixaria de
 * ver a outra pessoa mas continuaria SENDO VISTO por ela. É metade do pedido, e
 * é a metade que não protege.
 *
 * Os dois argumentos são pedaços de SQL do próprio código (um `$1`, um nome de
 * coluna) — nunca texto que veio de fora.
 */
export function semBloqueioEntre(umLado: string, outroLado: string): string {
  return `NOT EXISTS (
            SELECT 1 FROM user_blocks ub
             WHERE (ub.blocker_user_id = ${umLado}  AND ub.blocked_user_id = ${outroLado})
                OR (ub.blocked_user_id = ${umLado}  AND ub.blocker_user_id = ${outroLado})
          )`;
}
