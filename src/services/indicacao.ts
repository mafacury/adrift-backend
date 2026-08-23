import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { grantGift } from './gifts.js';
import { avisar, type Aviso } from './notify.js';
import { tr, idiomaDoUsuario } from './i18n.js';

/**
 * Indicação — o único laço de crescimento que o app tem.
 *
 * A tela "Sobre o Adrift" já prometia presente "ao indicar alguém que lança o
 * primeiro barco", e não havia nada por trás da frase. Aqui a promessa passa a
 * valer.
 *
 * O prêmio sai no PRIMEIRO BARCO do indicado, não no cadastro dele. Cadastro é
 * barato de fabricar — bastaria uma fila de e-mails descartáveis para o baú
 * encher sozinho. Lançar um barco custa: exige confirmar o e-mail, passar pelo
 * captcha, escolher país e escrever alguma coisa. É o primeiro ato que prova
 * que do outro lado tem gente.
 */

/**
 * O que quem indica recebe.
 *
 * Três presentes, um de cada nível até o raro. A escolha não é aleatória: o
 * raro "viaja com o barco até o fim da jornada" (ver TIERS), então quem trouxe
 * alguém ganha algo que deixa rastro longe — que é exatamente o que a pessoa
 * acabou de fazer pelo app.
 */
const PREMIO: { gift: string; qtd: number }[] = [
  { gift: 'garrafa', qtd: 2 },   // incomum — segue com o barco até o próximo porto
  { gift: 'buzio',   qtd: 2 },   // incomum
  { gift: 'sino',    qtd: 1 },   // raro — viaja até o fim da jornada
];

/** Código curto, sem 0/O/1/I para não virar telefone sem fio. */
function gerarCodigo(): string {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  return Array.from(bytes, (b) => alfabeto[b % alfabeto.length]).join('');
}

/**
 * O código de convite de alguém, criando na primeira vez que é pedido.
 *
 * O laço de repetição existe pelo improvável: dois códigos iguais sorteados no
 * mesmo instante. O índice único é quem decide, e aqui só se tenta de novo.
 */
export async function codigoDeConvite(userId: string): Promise<string> {
  const { rows } = await pool.query(
    'SELECT ref_code FROM users WHERE id = $1', [userId],
  );
  if (rows[0]?.ref_code) return rows[0].ref_code as string;

  for (let tentativa = 0; tentativa < 5; tentativa++) {
    const codigo = gerarCodigo();
    const { rows: gravou } = await pool.query(
      `UPDATE users SET ref_code = $2
        WHERE id = $1 AND ref_code IS NULL
          AND NOT EXISTS (SELECT 1 FROM users WHERE ref_code = $2)
        RETURNING ref_code`,
      [userId, codigo],
    );
    if (gravou[0]?.ref_code) return gravou[0].ref_code as string;

    // outra requisição criou o código no meio do caminho: usa o que ficou
    const { rows: agora } = await pool.query(
      'SELECT ref_code FROM users WHERE id = $1', [userId],
    );
    if (agora[0]?.ref_code) return agora[0].ref_code as string;
  }
  throw new Error('nao consegui gerar um codigo de convite');
}

/** Quem é o dono de um código. Nulo quando o código não existe. */
export async function donoDoCodigo(codigo: string): Promise<string | null> {
  if (!codigo || codigo.length > 32) return null;
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE ref_code = $1', [codigo.trim().toUpperCase()],
  );
  return rows[0]?.id ?? null;
}

/** Quantas pessoas alguém trouxe, e por quantas já foi premiado. */
export async function placarDeConvites(userId: string): Promise<{
  indicados: number; premiados: number;
}> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int                                             AS indicados,
            COUNT(referral_rewarded_at)::int                          AS premiados
       FROM users WHERE referred_by = $1`,
    [userId],
  );
  return {
    indicados: rows[0]?.indicados ?? 0,
    premiados: rows[0]?.premiados ?? 0,
  };
}

/** O aviso que quem indicou recebe. Sai por push e por e-mail. */
function avisoIndicacao(lang: string): Aviso {
  return {
    titulo: tr(lang, '🎁 Alguém que você trouxe lançou o primeiro barco'),
    corpo: tr(lang, 'O seu convite virou uma jornada. Há presentes novos no seu baú — leve-os a bordo do próximo barco que passar.'),
    url: '/bau',
    rotuloBotao: tr(lang, 'Abrir o baú'),
    tag: 'indicacao-premiada',
    // Vale o e-mail: é raro, é boa notícia, e é a única coisa no app que
    // depende de a pessoa ter falado do Adrift para alguém.
    porEmail: true,
  };
}

/**
 * Premia quem indicou, quando o indicado lança o primeiro barco.
 *
 * Chamada depois de criar o barco. Nunca lança: prêmio que falha não pode
 * impedir ninguém de lançar barco.
 *
 * A trava é o UPDATE condicional — quem marcar `referral_rewarded_at` primeiro
 * é quem premia. Dois barcos lançados no mesmo instante não viram dois
 * prêmios.
 */
export async function premiarIndicacao(indicadoId: string): Promise<void> {
  try {
    const { rows } = await pool.query(
      `UPDATE users SET referral_rewarded_at = NOW()
        WHERE id = $1
          AND referred_by IS NOT NULL
          AND referral_rewarded_at IS NULL
          -- primeiro barco: este é o único que existe
          AND (SELECT COUNT(*) FROM boats WHERE creator_user_id = $1) = 1
        RETURNING referred_by`,
      [indicadoId],
    );
    const padrinho: string | undefined = rows[0]?.referred_by;
    if (!padrinho) return;

    // A chave precisa ser distinta por presente: `gift_grants` é único por
    // (user_id, source_key), então três chamadas com a mesma chave entregariam
    // só a primeira — e em silêncio, que é o pior jeito de perder um prêmio.
    for (const p of PREMIO) {
      await grantGift(padrinho, p.gift, p.qtd, `indicacao:${indicadoId}:${p.gift}`);
    }

    await avisar(padrinho, avisoIndicacao(await idiomaDoUsuario(padrinho)));
    console.log(`[indicacao] ${padrinho} premiado por ${indicadoId}`);
  } catch (err) {
    console.error('[indicacao] falhou ao premiar por', indicadoId, err);
  }
}
