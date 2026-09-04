import { buildAgentJobFromIngestao, buildAgentJobFromMetaResult } from '../job.js';
import {
  agendarFollowupsAposTurno,
  cancelarFollowup,
  tentarRetomarPorMenuFollowup,
} from './runtime.js';

export { startFollowupCron, stopFollowupCron } from './cron.js';
export {
  agendarFollowup,
  agendarFollowupDinamico,
  agendarFollowupsAposTurno,
  cancelarFollowup,
  processarFollowupsPendentes,
  readFollowup,
} from './runtime.js';

/** Cliente falou: cancela pendentes. Se o agente não ativou, tenta atalho do menu de follow-up. */
export async function aposInboundCliente({
  resultado,
  fromMe,
  organized,
  conexao,
  canal,
}) {
  if (fromMe || !resultado?.conversaId) return null;
  await cancelarFollowup(resultado.conversaId, 'cliente_respondeu').catch(() => {});

  if (resultado.segueFluxoIA || resultado.parouPorPausado || resultado.creditoEsgotado) {
    return null;
  }

  const retomada = await tentarRetomarPorMenuFollowup({
    resultado,
    organized: organized || resultado,
    conexao,
    canal,
  }).catch(() => null);

  if (!retomada?.agente) return null;

  if (canal === 'meta') {
    return buildAgentJobFromMetaResult({
      ...resultado,
      agente: retomada.agente,
      agenteId: retomada.agente.id,
      conexao: conexao || resultado.conexao,
    });
  }

  return buildAgentJobFromIngestao({
    canal,
    resultado: retomada.resultado,
    organized,
    conexao,
  });
}

export { agendarFollowupsAposTurno as onAgentTurnComplete };
