import 'dotenv/config';

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}

function int(key: string, fallback: number): number {
  const value = process.env[key];
  return value ? parseInt(value, 10) : fallback;
}

export const config = {
  port: int('PORT', 3000),
  nodeEnv: process.env.NODE_ENV ?? 'development',

  databaseUrl: required('DATABASE_URL'),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',

  anthropicApiKey: required('ANTHROPIC_API_KEY'),
  jwtSecret: required('JWT_SECRET'),

  fcm: {
    projectId: process.env.FCM_PROJECT_ID ?? '',
    clientEmail: process.env.FCM_CLIENT_EMAIL ?? '',
    privateKey: process.env.FCM_PRIVATE_KEY ?? '',
  },

  boat: {
    maxIgnoresPerUser: int('MAX_IGNORES_PER_USER', 2),
    // "aquecimento": segundos que o barco leva navegando até um receptor humano
    // (silhueta no horizonte) antes de atracar. Bots recebem na hora.
    warmupSecMin: int('WARMUP_SEC_MIN', 90),
    warmupSecMax: int('WARMUP_SEC_MAX', 210),
    queueTimeoutMinutes: int('QUEUE_TIMEOUT_MINUTES', 720), // 12h — o receptor tem meio dia para responder
    boatIdleDays: int('BOAT_IDLE_DAYS', 30),
    minReportsToPause: int('MIN_REPORTS_TO_PAUSE', 3),
  },

  moderation: {
    newUserBoatThreshold: int('NEW_USER_BOAT_THRESHOLD', 5),
  },

  /**
   * Defesas contra fábrica de contas e propaganda em massa.
   *
   * A moderação de conteúdo (blocklist + IA) sempre existiu e funciona bem. O
   * que não existia era qualquer defesa de CONTA: criar usuário era grátis e
   * ilimitado, lançar barco não tinha teto, e o histórico de rejeições não
   * servia para nada. Estes números fecham essa porta.
   *
   * Todos são folgados para quem usa o app de verdade. Ninguém lança três
   * barcos em dois minutos por acaso.
   */
  antispam: {
    maxActiveBoatsPerUser: int('MAX_ACTIVE_BOATS_PER_USER', 3),
    launchCooldownSec: int('LAUNCH_COOLDOWN_SEC', 120),

    // rejeições da nossa moderação, em janela de 24h
    autobanWarnAt: int('AUTOBAN_WARN_AT', 3),   // → 'warned': para de receber barcos
    autobanBanAt: int('AUTOBAN_BAN_AT', 5),     // → 'banned': fim, e os barcos saem do mar

    // limite de taxa por IP
    rateLimitMax: int('RATE_LIMIT_MAX', 120),          // requisições por minuto, geral
    rateLimitAuthMax: int('RATE_LIMIT_AUTH_MAX', 10),  // nas rotas que rodam bcrypt

    /**
     * CAPTCHA no cadastro (Cloudflare Turnstile, gratuito).
     *
     * Vazio = desligado, e o servidor avisa no boot. Ligar exige a chave secreta
     * aqui e a chave pública no cliente. Ver services/captcha.ts.
     */
    turnstileSecret: process.env.TURNSTILE_SECRET ?? '',

    /**
     * Verificação de e-mail.
     *
     * Desligada por padrão de propósito: ligar sem `RESEND_API_KEY` configurada
     * manda todo mundo para uma tela de "confirme seu e-mail" cujo link só sai
     * no log do servidor. Ligue depois de o envio real estar de pé.
     */
    requireEmailVerification: process.env.REQUIRE_EMAIL_VERIFICATION === 'true',
  },
} as const;
