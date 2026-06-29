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
    queueTimeoutMinutes: int('QUEUE_TIMEOUT_MINUTES', 10),
    boatIdleDays: int('BOAT_IDLE_DAYS', 30),
    minReportsToPause: int('MIN_REPORTS_TO_PAUSE', 3),
  },

  moderation: {
    newUserBoatThreshold: int('NEW_USER_BOAT_THRESHOLD', 5),
  },
} as const;
