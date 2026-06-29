import { Queue } from 'bullmq';
import { config } from './index.js';

const connection = { url: config.redisUrl };

export const moderationQueue = new Queue('moderation-queue', { connection });
export const routingQueue    = new Queue('routing-queue',    { connection });
