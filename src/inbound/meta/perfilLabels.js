export const TIER_LABELS = {
  TIER_50: '50 conversas / 24h',
  TIER_250: '250 conversas / 24h',
  TIER_2K: '2.000 conversas / 24h',
  TIER_10K: '10.000 conversas / 24h',
  TIER_100K: '100.000 conversas / 24h',
  TIER_UNLIMITED: 'Ilimitado',
  UNTIERED: 'Sem limite definido',
};

export const PHONE_STATUS_LABELS = {
  CONNECTED: 'Conectado',
  DISCONNECTED: 'Desconectado',
  PENDING: 'Pendente',
  DELETED: 'Excluido',
  MIGRATED: 'Migrado',
  BANNED: 'Banido',
  RESTRICTED: 'Restrito',
  RATE_LIMITED: 'Limitado',
  UNVERIFIED: 'Nao verificado',
};

export const BIZ_VERIFICATION_LABELS = {
  verified: 'Verificado',
  not_verified: 'Nao verificado',
  pending: 'Pendente',
  failed: 'Falhou',
  rejected: 'Rejeitado',
};

export const ACCOUNT_REVIEW_LABELS = {
  APPROVED: 'Aprovado',
  PENDING: 'Pendente',
  REJECTED: 'Rejeitado',
};

export const NAME_STATUS_LABELS = {
  APPROVED: 'Aprovado',
  AVAILABLE_WITHOUT_REVIEW: 'Disponivel sem revisao',
  DECLINED: 'Recusado',
  EXPIRED: 'Expirado',
  PENDING_REVIEW: 'Em revisao',
  NONE: 'Sem certificado',
};

export const META_VERTICALS = [
  'OTHER', 'AUTO', 'BEAUTY', 'APPAREL', 'EDU', 'ENTERTAIN', 'EVENT_PLAN', 'FINANCE',
  'GROCERY', 'GOVT', 'HOTEL', 'HEALTH', 'NONPROFIT', 'PROF_SERVICES', 'RETAIL',
  'TRAVEL', 'RESTAURANT', 'ALCOHOL', 'ONLINE_GAMBLING', 'PHYSICAL_GAMBLING',
  'OTC_DRUGS', 'MATRIMONY_SERVICE',
];

export function parseMetaPagamento(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return [value];
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function formatPhone(telefone) {
  if (!telefone) return null;
  const d = String(telefone).replace(/\D/g, '');
  if (d.length >= 12 && d.startsWith('55')) {
    return `+${d.slice(0, 2)} ${d.slice(2, 4)} ${d.slice(4)}`;
  }
  return `+${d}`;
}

export function getLinhaCredito(metaPagamento, primaryFundingId, wabaStatus) {
  const wabaSt = String(wabaStatus || '').toUpperCase();
  if (wabaSt === 'PENDING_VALID_PAYMENT_METHOD') {
    return { status: 'pending_valid_payment_method', label: 'Forma de pagamento pendente' };
  }
  if (primaryFundingId) {
    return { status: 'active', label: 'Configurada' };
  }
  const arr = Array.isArray(metaPagamento) ? metaPagamento : [];
  const billing = arr.find((c) => c?.configuration_name === 'billing_meta_api');
  if (billing?.pending_valid_payment_method) {
    return { status: 'pending_valid_payment_method', label: 'Forma de pagamento pendente' };
  }
  if (billing?.has_payment_method || billing?.primary_funding_id) {
    return { status: 'active', label: 'Configurada' };
  }
  for (let i = arr.length - 1; i >= 0; i--) {
    const cfg = arr[i];
    if (!cfg || cfg.configuration_name === 'billing_meta_api') continue;
    const st = String(cfg?.status || cfg?.credit_line_status || '').toLowerCase();
    if (st && !st.includes('need') && !st.includes('pending') && !st.includes('update')) {
      return { status: st, label: 'Configurada' };
    }
  }
  return { status: 'needs_update', label: 'Atualizacao necessaria' };
}

export function buildPerfilResponse({ row, acao, cache }) {
  const limite = row.metaMessagingLimit || row.metaPhoneQualityLimit || null;
  const metaPagamento = parseMetaPagamento(row.metaPagamento);
  const billing = metaPagamento.find((c) => c?.configuration_name === 'billing_meta_api') || null;
  const linhaCredito = getLinhaCredito(
    metaPagamento,
    row.metaPrimaryFundingId || null,
    row.metaWabaStatus || billing?.waba_status || null,
  );
  const perfil = row.metaPerfil || {};

  return {
    ok: true,
    acao,
    conexaoId: row.id,
    cache,
    dados: {
      nomeExibir: row.metaVerifiedName || row.NomeConexao || null,
      nomeStatus: row.metaNameStatus || null,
      nomeStatusLabel: NAME_STATUS_LABELS[row.metaNameStatus] || row.metaNameStatus || 'Sem informacao',
      novoNomeExibir: row.metaNewDisplayName || null,
      novoNomeStatus: row.metaNewNameStatus || null,
      novoNomeStatusLabel: NAME_STATUS_LABELS[row.metaNewNameStatus] || row.metaNewNameStatus || null,
      telefone: row.Telefone || null,
      telefoneFormatado: formatPhone(row.Telefone),
      fotoPerfil: row.FotoPerfil || perfil.profile_picture_url || null,
      wabaId: row.waba_id || null,
      phoneNumberId: row.phone_number_id || null,
      businessId: row.business_id || null,
      limiteMensagens: limite,
      limiteMensagensLabel: TIER_LABELS[limite] || limite || 'Sem informacao',
      statusNumero: row.metaPhoneStatus || null,
      statusNumeroLabel: PHONE_STATUS_LABELS[row.metaPhoneStatus] || row.metaPhoneStatus || 'Sem informacao',
      qualidade: row.metaQualityRating || null,
      verificacaoEmpresarial: row.metaBusinessVerificationStatus || null,
      verificacaoEmpresarialLabel:
        BIZ_VERIFICATION_LABELS[row.metaBusinessVerificationStatus] ||
        row.metaBusinessVerificationStatus ||
        'Sem informacao',
      statusConta: row.metaAccountReviewStatus || null,
      statusContaLabel:
        ACCOUNT_REVIEW_LABELS[row.metaAccountReviewStatus] || row.metaAccountReviewStatus || 'Sem informacao',
      linhaCredito: linhaCredito.status,
      linhaCreditoLabel: linhaCredito.label,
      statusWaba: row.metaWabaStatus || billing?.waba_status || null,
      statusWabaLabel:
        (row.metaWabaStatus || billing?.waba_status) === 'PENDING_VALID_PAYMENT_METHOD'
          ? 'Forma de pagamento pendente'
          : row.metaWabaStatus || billing?.waba_status || 'Sem informacao',
      moeda: row.metaWabaCurrency || billing?.currency || null,
      fusoHorarioId: row.metaWabaTimezoneId || billing?.timezone_id || null,
      formaPagamentoPendente:
        (row.metaWabaStatus || billing?.waba_status) === 'PENDING_VALID_PAYMENT_METHOD' ||
        billing?.pending_valid_payment_method === true,
      numerosWaba: billing?.phone_numbers || [],
      metaPagamento,
      metaPagamentoUpdatedAt: row.metaPagamentoUpdatedAt || null,
      metaPrimaryFundingId: row.metaPrimaryFundingId || null,
      atualizadoEm: row.metaDadosUpdatedAt || row.metaPerfilUpdatedAt || null,
    },
    perfil,
  };
}
