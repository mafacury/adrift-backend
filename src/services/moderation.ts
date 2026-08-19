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

const SYSTEM_PROMPT = `You are a content moderator for a global message-in-a-bottle app called Adrift.
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
