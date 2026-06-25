import { getEvolutionConfig } from '../config.js';
import { logger } from '../logger.js';
import { validateSupabaseConnection } from '../supabase.js';
import { createDisparadorEvolution } from '../evolution/disparador.js';

async function main() {
  const config = getEvolutionConfig();
  await validateSupabaseConnection();

  const disparador = createDisparadorEvolution(config);

  logger.info('Worker Evolution iniciado', {
    intervalMs: config.intervalMs,
    baseUrl: config.evolutionBaseUrl,
  });

  const loop = async () => {
    try {
      await disparador.runTick(new Date());
    } catch (err) {
      logger.error('Erro no tick Evolution', {
        message: err instanceof Error ? err.message : String(err),
      });
    }
  };

  await loop();
  setInterval(loop, config.intervalMs);
}

main().catch((err) => {
  logger.error('Falha fatal ao iniciar Evolution', {
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
