/**
 * Tradução das mensagens do barco.
 *
 * As mensagens chegam em japonês, italiano, suaíli — é a graça do app e também
 * a barreira: quem recebe quer entender antes de responder. Aqui o texto é
 * traduzido para o português sob demanda, nunca automaticamente: só quando a
 * pessoa pede.
 *
 * Cada frase é traduzida UMA vez e fica guardada pelo hash do texto (ver
 * migração 018). Como a mesma mensagem passa por muitos navegantes, o segundo
 * que pedir a tradução do mesmo barco não gasta nada e recebe na hora.
 */
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';
import { pool } from '../db/pool.js';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

/** Quantas mensagens por chamada — barcos antigos têm dezenas. */
const LOTE = 25;

export interface Traducao {
  /** Posição na lista de mensagens do barco (mesma ordem da fila). */
  i: number;
  texto: string;
  /** Idioma detectado no original, em português ("japonês"). */
  origem: string;
}

function hash(texto: string): string {
  return createHash('sha256').update(texto.trim()).digest('hex');
}

const ESQUEMA = {
  type: 'object',
  properties: {
    traducoes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          i:      { type: 'integer' },
          pt:     { type: 'string' },
          origem: { type: 'string' },
        },
        required: ['i', 'pt', 'origem'],
        additionalProperties: false,
      },
    },
  },
  required: ['traducoes'],
  additionalProperties: false,
} as const;

const INSTRUCAO = `Você traduz mensagens de um app onde pessoas de vários países
escrevem umas para as outras, como cartas em garrafas lançadas ao mar.

Traduza cada mensagem para o PORTUGUÊS DO BRASIL. Regras:
- Preserve o tom de quem escreveu: se é informal, fica informal; se é um poema,
  continua parecendo um poema. Não melhore nem corrija o original.
- Mantenha emojis e quebras de linha onde estavam.
- Nomes de pessoas e lugares não se traduzem.
- Se a mensagem JÁ estiver em português, devolva o texto exatamente igual.
- Em "origem", diga o idioma do original em português (ex.: "japonês",
  "italiano", "português"). Se não conseguir identificar, use "desconhecido".
- Nunca acrescente comentários, notas ou explicações — só a tradução.`;

/** Traduz um lote pela IA. Devolve o texto e o idioma de origem de cada item. */
async function traduzirLote(
  itens: { i: number; texto: string }[],
): Promise<Traducao[]> {
  // O `as any` é por causa do SDK: o pacote está preso na 0.54.0, anterior às
  // saídas estruturadas, então ele não conhece `output_config` — mas manda o
  // corpo como recebe, e a API entende. Vale trocar quando o SDK subir; até
  // então isto não é gambiarra, é a versão da biblioteca ficando atrás da API.
  const res = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 16000,
    system: INSTRUCAO,
    output_config: {
      // traduzir não pede deliberação; esforço baixo já sai fiel
      effort: 'low',
      format: { type: 'json_schema', schema: ESQUEMA },
    },
    messages: [{
      role: 'user',
      content: JSON.stringify(itens.map(({ i, texto }) => ({ i, texto }))),
    }],
  } as any);

  // recusa dos classificadores: devolve o barco no idioma original, sem erro
  if ((res.stop_reason as string) === 'refusal') return [];

  const bloco = res.content.find(b => b.type === 'text');
  if (!bloco || bloco.type !== 'text') return [];

  const dados = JSON.parse(bloco.text) as {
    traducoes: { i: number; pt: string; origem: string }[];
  };
  return (dados.traducoes ?? []).map(t => ({
    i: t.i, texto: t.pt, origem: t.origem,
  }));
}

/**
 * Traduz as mensagens indicadas, usando o cache do que já foi traduzido antes.
 *
 * `textos` vem na MESMA ordem em que o app mostra as mensagens, e o índice de
 * cada tradução aponta para essa posição — é isso que liga uma à outra sem
 * precisar expor id de mensagem.
 */
export async function traduzirMensagens(
  textos: string[],
  lang = 'pt',
): Promise<Traducao[]> {
  if (textos.length === 0) return [];

  const hashes = textos.map(hash);
  const { rows } = await pool.query(
    `SELECT content_hash, translated, source_lang
       FROM message_translations
      WHERE lang = $1 AND content_hash = ANY($2::text[])`,
    [lang, hashes],
  );
  const cache = new Map<string, { texto: string; origem: string }>(
    rows.map(r => [r.content_hash, { texto: r.translated, origem: r.source_lang ?? '' }]),
  );

  const saida: Traducao[] = [];
  const faltando: { i: number; texto: string }[] = [];

  textos.forEach((texto, i) => {
    const achou = cache.get(hashes[i]);
    if (achou) saida.push({ i, texto: achou.texto, origem: achou.origem });
    else if (texto.trim()) faltando.push({ i, texto });
  });

  for (let p = 0; p < faltando.length; p += LOTE) {
    const lote = faltando.slice(p, p + LOTE);
    let novas: Traducao[] = [];
    try {
      novas = await traduzirLote(lote);
    } catch (err) {
      // uma falha de tradução não pode derrubar a leitura do barco: o que
      // traduziu, traduziu; o resto continua no idioma original
      console.error('[traduzir] lote falhou', err);
      continue;
    }

    // grava no dicionário para quem vier depois
    for (const t of novas) {
      const original = textos[t.i];
      if (original === undefined) continue;
      await pool.query(
        `INSERT INTO message_translations (content_hash, lang, translated, source_lang)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [hash(original), lang, t.texto, t.origem],
      );
    }
    saida.push(...novas);
  }

  return saida.sort((a, b) => a.i - b.i);
}
