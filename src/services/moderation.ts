import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config/index.js';

export type ModerationVerdict = 'approved' | 'rejected' | 'uncertain';

// ── Camada 1: Blocklist ──────────────────────────────────────────────────────

const BLOCKLIST_PATTERNS: RegExp[] = [
  // Slurs and hate speech (samples — extend as needed)
  /\b(nigger|faggot|chink|spic|kike|retard)\b/i,
  // Sexual content
  /\b(porn|xxx|nude|naked|sex\s*chat)\b/i,
  // Violence
  /\b(kill\s+yourself|kys|suicide\s+method|how\s+to\s+die)\b/i,
  // Spam signals
  /https?:\/\/[^\s]{4,}/,          // any URL → reject in MVP
  /\b(\+?1?[\s-]?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4})\b/, // phone numbers
  // PT slurs / palavrões agressivos (amostra)
  /\b(viado|buceta|puta\s+que\s+pariu)\b/i,
];

function blocklist(text: string): boolean {
  return BLOCKLIST_PATTERNS.some((re) => re.test(text));
}

// ── Camada 2: IA (claude-haiku-4-5) ─────────────────────────────────────────

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const SYSTEM_PROMPT = `You are a content moderator for Adrift, a global app where people write messages and launch sailboats that carry them from stranger to stranger around the world.
Users launch boats carrying short messages (max 500 chars each) that travel from stranger to stranger around the world.
Your job is to classify new content additions to a boat.

Reply ONLY with a JSON object with this shape:
{ "verdict": "approved" | "rejected" | "uncertain", "reason": "<one short sentence>" }

Reject if the new message contains: hate speech, slurs, graphic violence, sexual content, spam, or external links.
Mark uncertain if it is ambiguous, potentially harmful, or you are not confident.
Approve everything else — creative, emotional, philosophical, or neutral content is fine.
`;

interface ModerationHistory {
  country_code: string;
  content: string;
}

export async function moderateWithAI(
  newContent: string,
  history: ModerationHistory[],
): Promise<{ verdict: ModerationVerdict; reason: string }> {
  const historyText = history
    .map((h, i) => `[${i + 1}] (${h.country_code}): ${h.content}`)
    .join('\n');

  const userMessage = `Boat message history so far:\n${historyText || '(this is the first message)'}\n\nNew message to evaluate:\n${newContent}`;

  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 128,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';

  try {
    const parsed = JSON.parse(raw) as { verdict: ModerationVerdict; reason: string };
    if (!['approved', 'rejected', 'uncertain'].includes(parsed.verdict)) {
      return { verdict: 'uncertain', reason: 'AI returned unexpected verdict' };
    }
    return parsed;
  } catch {
    // Resposta veio mas não era o JSON esperado: isso É um veredito incerto,
    // diferente de a API não ter respondido — esse caso lança e é tratado em
    // moderate(), que decide se o barco segue com meia checagem.
    return { verdict: 'uncertain', reason: 'AI response could not be parsed' };
  }
}

// ── Public function ──────────────────────────────────────────────────────────

export async function moderate(
  newContent: string,
  history: ModerationHistory[],
  isNewUser: boolean,
): Promise<{ verdict: ModerationVerdict; layer: number; detail: string }> {
  // Layer 1
  if (blocklist(newContent)) {
    return { verdict: 'rejected', layer: 1, detail: 'blocklist match' };
  }

  // Layer 2
  //
  // Quando a IA não responde (chave inválida, cota, rede), NÃO propagamos o
  // erro. Propagar significa não gravar veredito nenhum — e desde que o sweep
  // passou a exigir aprovação explícita, "sem veredito" é "barco parado para
  // sempre". Em 19/08/2026 isso deixou 44 barcos encalhados de uma vez.
  //
  // O que fazemos: a camada 1 continua valendo, e ela não é pouca — é a que
  // rejeita link, telefone e a lista de termos. Passando por ela, o barco
  // segue, e o veredito fica gravado dizendo que saiu SEM a segunda camada.
  // Isso é rastreável depois com uma consulta, ao contrário de um erro no log.
  //
  // Não é uma escolha confortável: é escolher entre "conteúdo passa com meia
  // checagem" e "o app inteiro para". Com a camada 1 de pé, a primeira é menos
  // pior — e o registro em `detail` deixa a dívida visível.
  let verdict: ModerationVerdict;
  let reason: string;
  try {
    ({ verdict, reason } = await moderateWithAI(newContent, history));
  } catch (err: any) {
    console.error(
      '[moderation] IA INDISPONIVEL — seguindo so com a blocklist:',
      err?.status ?? '', err?.message ?? err,
    );
    return {
      verdict: 'approved',
      layer: 1,
      detail: `IA indisponivel (${err?.status ?? 'erro'}) — aprovado so pela blocklist`,
    };
  }

  // Stricter threshold for new users: treat "uncertain" as "rejected"
  if (isNewUser && verdict === 'uncertain') {
    return { verdict: 'rejected', layer: 2, detail: `new-user strict: ${reason}` };
  }

  return { verdict, layer: 2, detail: reason };
}

// ── Está de pé? ──────────────────────────────────────────────────────────────

type EstadoIA = 'ok' | 'chave-invalida' | 'sem-credito' | 'nao-configurada' | 'erro' | 'nao-conferido';
let estadoIA: EstadoIA = 'nao-conferido';
let motivoIA = '';

/** Quando a última conferência rodou. */
let conferidoEm = 0;
const REPETIR_MS = 10 * 60_000;

/**
 * O estado da IA — e uma nova conferência quando ela está quebrada.
 *
 * Conferir só no boot tem um efeito ruim justamente na hora que importa: quem
 * acabou de pôr crédito recarrega o /health, continua lendo "sem-credito" (a
 * resposta é a do boot) e conclui que não adiantou. Enquanto NÃO estiver ok,
 * uma nova tentativa a cada 10 min; estando ok, nunca mais — chave boa não
 * precisa ser reconferida, e cada tentativa é uma chamada à API.
 */
export function estadoDaIA(): { estado: EstadoIA; motivo: string } {
  if (estadoIA !== 'ok' && Date.now() - conferidoEm > REPETIR_MS) void conferirIA();
  return { estado: estadoIA, motivo: motivoIA };
}

/**
 * Confere a chave da Anthropic no boot e guarda o resultado para o /health.
 *
 * Existe porque descobrir que a IA está fora exigia caçar a linha
 * "[moderation] IA INDISPONIVEL" no log do Railway — e enquanto ninguém caça,
 * o app fica sem moderação, sem banimento automático (que conta rejeições da
 * moderação) e sem o botão Traduzir, tudo em silêncio. Três coisas caem juntas
 * e nenhuma reclama.
 *
 * Usa `count_tokens`, que não gera resposta nem custa nada: só quer saber se a
 * chave é aceita. 401 é chave inválida; qualquer 2xx é chave boa.
 */
export async function conferirIA(): Promise<void> {
  const chave = config.anthropicApiKey?.trim();
  if (!chave) { estadoIA = 'nao-configurada'; return; }

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
      method: 'POST',
      headers: {
        'x-api-key': chave,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        messages: [{ role: 'user', content: 'ping' }],
      }),
    });
    if (r.ok) {
      estadoIA = 'ok';
      motivoIA = '';
    } else if (r.status === 401) {
      estadoIA = 'chave-invalida';
      motivoIA = 'a API recusou a chave (401)';
    } else {
      // Qualquer coisa que NÃO seja 401 já prova que a chave foi aceita — a
      // autenticação acontece antes da validação do corpo. Vale distinguir:
      // "a chave está boa e a minha pergunta é que estava torta" é uma
      // notícia completamente diferente de "a chave caiu".
      const corpo = await r.text().catch(() => '');

      // Saldo zerado é o caso que enganou por dias: a chave é ACEITA (não dá
      // 401), mas nenhuma chamada de verdade passa. Chamar isso de "ok" seria
      // pior que não ter conferência nenhuma — um painel que jura que está
      // tudo bem enquanto a moderação, o banimento automático e o botão
      // Traduzir estão todos parados.
      if (/credit balance/i.test(corpo)) {
        estadoIA = 'sem-credito';
        motivoIA = 'a chave é válida, mas a conta da Anthropic está sem saldo';
      } else {
        estadoIA = 'erro';
        motivoIA = `HTTP ${r.status}: ${corpo.slice(0, 200)}`;
      }
    }
  } catch (err: any) {
    estadoIA = 'erro';
    motivoIA = err?.message ?? 'falha de rede';
  }
  conferidoEm = Date.now();
  console.log(`[ia] ${estadoIA}${motivoIA ? ' — ' + motivoIA : ''}`);
}
