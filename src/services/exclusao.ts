import { randomUUID } from 'node:crypto';
import { emTransacao } from '../db/pool.js';

/**
 * Excluir a conta de quem pede.
 *
 * O Termo promete duas coisas que puxam para lados opostos: apagar o cadastro
 * E manter nos barcos as mensagens já entregues a estranhos. Um `DELETE FROM
 * users` faria o contrário do prometido — `boat_messages.user_id` é NOT NULL
 * com ON DELETE CASCADE, então levaria junto toda mensagem que a pessoa
 * escreveu, inclusive as que hoje estão em barcos de outras pessoas.
 *
 * Então a exclusão é por ANONIMIZAÇÃO. O que some de verdade:
 *
 *   e-mail          vira lápide (precisa continuar único, daí o uuid)
 *   senha           some — ninguém entra mais, nem quem souber a antiga
 *   país, idioma    somem: são o perfil, não a história dos barcos
 *   aparelho        o token de push some, e as inscrições de navegador também
 *   convite         o código e o vínculo com quem trouxe a pessoa somem
 *   pedidos abertos recuperação de senha e verificação de e-mail somem
 *   rastro          o log de requisições dela é apagado
 *
 * O que fica: a LINHA, sem nada dentro, só como âncora da chave estrangeira; e
 * as mensagens nos barcos por onde passaram, sem ligação utilizável com
 * ninguém.
 *
 * Os barcos criados pela pessoa são arquivados — param de navegar, como o
 * Termo diz. Não são apagados: eles carregam o que estranhos escreveram.
 */
export async function excluirConta(userId: string): Promise<void> {
  const lapide = `apagado+${randomUUID()}@adrift.invalid`;

  // Transação de verdade: uma conexão só, segurada do BEGIN ao COMMIT. Com
  // `pool.query('BEGIN')` cada consulta pediria uma conexão nova ao pool e o
  // agrupamento seria ilusão — ver `emTransacao` em db/pool.ts. Aqui isso
  // importa mais do que na média: uma exclusão que aplica metade dos passos
  // deixa a pessoa num estado que nenhum dos dois lados descreve, sem e-mail
  // para entrar e com barcos ainda navegando.
  await emTransacao(async (c) => {
    // 1. o cadastro deixa de ser uma pessoa
    await c.query(
      `UPDATE users
          SET email = $2,
              password_hash = NULL,
              country_code = NULL,
              lang = NULL,
              fcm_token = NULL,
              ref_code = NULL,
              referred_by = NULL,
              oauth_provider = NULL,
              oauth_id = NULL,
              receiving_paused = TRUE,
              deleted_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL`,
      [userId, lapide],
    );

    // 2. o que só serve para alcançar a pessoa
    await c.query(`DELETE FROM push_subscriptions  WHERE user_id = $1`, [userId]);
    await c.query(`DELETE FROM password_resets     WHERE user_id = $1`, [userId]);
    await c.query(`DELETE FROM email_verifications WHERE user_id = $1`, [userId]);

    // 3. os barcos param de navegar, mas continuam existindo: eles carregam o
    //    que estranhos escreveram, e isso não é da pessoa para apagar
    await c.query(
      `UPDATE boats
          SET status = 'archived',
              archive_reason = COALESCE(archive_reason, 'conta_excluida')
        WHERE creator_user_id = $1 AND status <> 'archived'`,
      [userId],
    );

    // 4. o rastro de troubleshooting some junto. Sem isto, a exclusão deixaria
    //    para trás a lista datada do que a pessoa fez, ligada ao id dela —
    //    exatamente o que ela pediu para não existir mais. O ON DELETE SET
    //    NULL da coluna não cobre este caso: a linha de `users` não é apagada,
    //    é anonimizada, então o gatilho nunca dispara.
    await c.query(`DELETE FROM request_log WHERE user_id = $1`, [userId]);

    // 5. e nada mais chega para ela
    await c.query(
      `UPDATE receiver_queue SET status = 'skipped'
        WHERE user_id = $1 AND status = 'pending'`,
      [userId],
    );
  });

  console.log(`[exclusao] conta ${userId} anonimizada`);
}
