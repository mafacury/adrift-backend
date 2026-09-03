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
  /**
   * O texto ORIGINAL, que é a chave de busca no app.
   *
   * Já foi a posição na lista, e isso quebrava: a Jornada e o Mapa montam a
   * lista de mensagens por caminhos diferentes (uma vem da fila, a outra dos
   * pulos do barco), então a mesma mensagem podia cair em índices distintos.
   * Pelo texto, cada tela acha a sua tradução sem depender de ordem.
   */
  original: string;
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

/** Como cada idioma se chama para o modelo. */
const NOME_DO_IDIOMA: Record<string, string> = {
  pt: 'Brazilian Portuguese',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  ja: 'Japanese',
  ar: 'Arabic',
  hi: 'Hindi',
};

/**
 * O destino entra na instrução em vez de estar preso nela.
 *
 * Antes daqui a instrução dizia "traduza para o PORTUGUÊS DO BRASIL" em letra
 * fixa, enquanto o cache já era indexado por idioma. Ou seja: pedir a tradução
 * em japonês gravava PORTUGUÊS na chave do japonês, e a resposta errada ficava
 * guardada para sempre. Não era só não traduzir — era envenenar o dicionário.
 */
function instrucao(lang: string): string {
  const destino = NOME_DO_IDIOMA[lang] ?? NOME_DO_IDIOMA.pt;
  return `Você traduz mensagens de um app onde pessoas de vários países
escrevem umas para as outras, como cartas em garrafas lançadas ao mar.

Traduza cada mensagem para ${destino}. Regras:
- Preserve o tom de quem escreveu: se é informal, fica informal; se é um poema,
  continua parecendo um poema. Não melhore nem corrija o original.
- Mantenha emojis e quebras de linha onde estavam.
- Nomes de pessoas e lugares não se traduzem.
- Se a mensagem JÁ estiver nesse idioma, devolva o texto exatamente igual.
- Em "origem", diga o idioma do original NO IDIOMA DE DESTINO (ex.: em
  português, "japonês"; em inglês, "Japanese"). Se não conseguir identificar,
  diga o equivalente a "desconhecido".
- Nunca acrescente comentários, notas ou explicações — só a tradução.`;
}

/** Traduz um lote pela IA. Devolve o texto e o idioma de origem de cada item. */
async function traduzirLote(
  itens: { i: number; texto: string }[], lang: string,
): Promise<Traducao[]> {
  // O `as any` é por causa do SDK: o pacote está preso na 0.54.0, anterior às
  // saídas estruturadas, então ele não conhece `output_config` — mas manda o
  // corpo como recebe, e a API entende. Vale trocar quando o SDK subir; até
  // então isto não é gambiarra, é a versão da biblioteca ficando atrás da API.
  const res = await client.messages.create({
    // Traduzir com esquema fixo é fidelidade, não deliberação — o trabalho
    // que um modelo pequeno faz igual por um quinto do preço. Era Opus 5.
    model: 'claude-haiku-4-5',
    max_tokens: 16000,
    system: instrucao(lang),
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

  // `b: any` pelo mesmo motivo do `as any` acima: sem os tipos novos do SDK,
  // `res` chega sem forma e o TypeScript recusa o parâmetro sem anotação.
  const bloco = res.content.find((b: any) => b.type === 'text');
  if (!bloco || bloco.type !== 'text') return [];

  const dados = JSON.parse(bloco.text) as {
    traducoes: { i: number; pt: string; origem: string }[];
  };
  return (dados.traducoes ?? []).flatMap(t => {
    const item = itens.find(x => x.i === t.i);
    return item ? [{ original: item.texto, texto: t.pt, origem: t.origem }] : [];
  });
}

/**
 * Traduz as mensagens indicadas, usando o cache do que já foi traduzido antes.
 *
 * `textos` vem na MESMA ordem em que o app mostra as mensagens, e o índice de
 * cada tradução aponta para essa posição — é isso que liga uma à outra sem
 * precisar expor id de mensagem.
 */
export interface MensagemParaTraduzir {
  texto: string;
  /** Idioma em que foi escrita, quando se sabe (migração 029). */
  lang?: string | null;
}

export async function traduzirMensagens(
  mensagens: MensagemParaTraduzir[],
  lang = 'pt',
): Promise<Traducao[]> {
  if (mensagens.length === 0) return [];

  const textos = mensagens.map((m) => m.texto);
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

  const jaPedido = new Set<string>();
  mensagens.forEach((m, i) => {
    const texto = m.texto;
    const achou = cache.get(hashes[i]);
    if (achou) { saida.push({ original: texto, texto: achou.texto, origem: achou.origem }); return; }

    // Já está no idioma de quem lê: não vai para a IA. Este é o maior corte da
    // conta e não custa nada — o idioma foi gravado quando a mensagem nasceu,
    // não é palpite. Sem isto pagava-se para traduzir português→português, que
    // é literalmente o que o prompt manda devolver igual.
    if (m.lang && m.lang === lang) return;

    // a mesma frase pode aparecer duas vezes: traduz uma só
    if (texto.trim() && !jaPedido.has(hashes[i])) { jaPedido.add(hashes[i]); faltando.push({ i, texto }); }
  });

  for (let p = 0; p < faltando.length; p += LOTE) {
    const lote = faltando.slice(p, p + LOTE);
    let novas: Traducao[] = [];
    try {
      novas = await traduzirLote(lote, lang);
    } catch (err) {
      // uma falha de tradução não pode derrubar a leitura do barco: o que
      // traduziu, traduziu; o resto continua no idioma original
      console.error('[traduzir] lote falhou', err);
      continue;
    }

    // grava no dicionário para quem vier depois
    for (const t of novas) {
      await pool.query(
        `INSERT INTO message_translations (content_hash, lang, translated, source_lang)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        [hash(t.original), lang, t.texto, t.origem],
      );
    }
    saida.push(...novas);
  }

  return saida;
}
