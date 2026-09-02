import pg from 'pg';
import { config } from '../config/index.js';

export const pool = new pg.Pool({ connectionString: config.databaseUrl });

pool.on('error', (err) => {
  console.error('[db] pool error', err);
});

/**
 * Rodar um bloco DENTRO de uma transação de verdade.
 *
 * `pool.query('BEGIN')` não faz isso, e a diferença é silenciosa. Lendo a fonte
 * do pg-pool: `Pool.query` é `connect → query → client.release()`. O BEGIN abre
 * a transação e DEVOLVE a conexão ao pool ainda dentro dela; o UPDATE seguinte
 * pede outra conexão ao pool e pode receber qualquer uma.
 *
 * Nunca quebrou porque o pool reusa o último liberado (`_idle.pop()`), então
 * num fluxo sequencial a mesma conexão volta — dá certo por acidente. Com duas
 * requisições ao mesmo tempo o acidente acaba: a segunda pega a conexão que
 * está no meio da transação da primeira, escreve dentro dela, e um ROLLBACK da
 * primeira desfaz a escrita da segunda. Nada avisa.
 *
 * Aqui a conexão é segurada do BEGIN ao COMMIT, e o `finally` garante que ela
 * volte ao pool mesmo se algo estourar no meio — sem isso, um erro no caminho
 * deixa a conexão presa em `idle in transaction`, segurando os bloqueios dela
 * até o banco desistir.
 */
export async function emTransacao<T>(
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}
