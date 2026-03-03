import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { config as loadDotenv } from 'dotenv';
import yaml from 'js-yaml';
import { EnvSchema, YamlConfigSchema, type Env, type YamlConfig } from './schema.js';
import { logger } from '../utils/logger.js';

// Load .env from project root
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '../../');

loadDotenv({ path: resolve(ROOT, '.env') });

// ---------------------------------------------------------------------------
// Parse & validate environment variables
// ---------------------------------------------------------------------------

const envResult = EnvSchema.safeParse(process.env);
if (!envResult.success) {
  logger.fatal({ errors: envResult.error.flatten().fieldErrors }, 'Invalid environment variables');
  process.exit(1);
}
export const env: Env = envResult.data;

// ---------------------------------------------------------------------------
// Parse & validate config.yaml
// ---------------------------------------------------------------------------

function loadYamlConfig(): YamlConfig {
  const yamlPath = resolve(ROOT, 'config.yaml');
  let raw: unknown;
  try {
    raw = yaml.load(readFileSync(yamlPath, 'utf8'));
  } catch (err) {
    logger.fatal({ err, path: yamlPath }, 'Failed to read config.yaml');
    process.exit(1);
  }

  const result = YamlConfigSchema.safeParse(raw);
  if (!result.success) {
    logger.fatal({ errors: result.error.flatten().fieldErrors }, 'Invalid config.yaml');
    process.exit(1);
  }
  return result.data;
}

export const yamlConfig: YamlConfig = loadYamlConfig();

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** All configured RPC endpoint URLs (only non-empty ones). */
export const rpcEndpoints: string[] = [
  env.RPC_URL_1,
  env.RPC_URL_2,
  env.RPC_URL_3,
  env.RPC_URL_4,
  env.RPC_URL_5,
  env.RPC_URL_6,
  env.RPC_URL_7,
  env.RPC_URL_8,
  env.RPC_URL_9,
  env.RPC_URL_10,
].filter((url): url is string => Boolean(url));

/** Convenience re-export for trading settings. */
export const tradingConfig = yamlConfig.trading;

logger.info(
  {
    rpcCount: rpcEndpoints.length,
    rpcStrategy: yamlConfig.rpc.strategy,
    maxPositionSol: tradingConfig.max_position_sol,
    maxOpenPositions: tradingConfig.max_open_positions,
  },
  'Config loaded',
);
