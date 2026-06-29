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
  const { verdict, reason } = await moderateWithAI(newContent, history);

  // Stricter threshold for new users: treat "uncertain" as "rejected"
  if (isNewUser && verdict === 'uncertain') {
    return { verdict: 'rejected', layer: 2, detail: `new-user strict: ${reason}` };
  }

  return { verdict, layer: 2, detail: reason };
}
