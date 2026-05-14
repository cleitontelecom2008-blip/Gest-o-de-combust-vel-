'use strict';
/**
 * services/billingService.js — CH Geladas PDV
 * ─────────────────────────────────────────────────────────────
 * Gerenciamento de assinaturas e billing via PIX.
 *
 * FLUXO DE PAGAMENTO (client-side seguro):
 *   1. Cliente escolhe plano → billingService.criarCobranca(plano)
 *   2. Gera QR Code PIX estático por empresa (sem backend próprio)
 *   3. Salva pedido pendente no Firestore com status 'aguardando'
 *   4. Admin confirma manualmente → billingService.confirmarPagamento(pedidoId)
 *      OU integração webhook futura via Cloud Functions
 *
 * NOTA DE ARQUITETURA:
 *   Para produção real, o ideal é um backend NestJS que:
 *   - Gera o PIX via API do Mercado Pago / AbacatePay
 *   - Recebe o webhook de confirmação
 *   - Atualiza o plano da empresa automaticamente
 *
 *   Este serviço implementa a versão client-side que já é funcional
 *   para operação manual/inicial.
 *
 * Requer: core.js + saasService + featureFlagsService carregados.
 */

(function () {
  const { Store, Utils, EventBus } = window.CH;

  // ── Tabela de preços (em centavos BRL) ───────────────────────────
  const PRECOS = Object.freeze({
    basico:     { mensal: 4990,  anual: 47900,  label: 'Básico'     },
    premium:    { mensal: 9990,  anual: 95900,  label: 'Premium'    },
    enterprise: { mensal: 29900, anual: 287000, label: 'Enterprise' },
  });

  // ── Chave PIX do recebedor (configura via saas-admin) ────────────
  function _getChavePix() {
    return Store.getConfig()?.billing?.chavePix || '';
  }

  function _getNomeRecebedor() {
    return Store.getConfig()?.billing?.nomeRecebedor || 'CH Geladas';
  }

  function _getCidade() {
    return Store.getConfig()?.billing?.cidade || 'SAO PAULO';
  }

  // ── Gerador de payload PIX (EMV QR Code estático) ────────────────
  // Padrão Banco Central do Brasil — funciona em qualquer app de pagamento
  function _gerarPixPayload({ chavePix, nome, cidade, valor, txid }) {
    const v = (Number(valor) / 100).toFixed(2);

    function tlv(id, value) {
      const hex = id.toString().padStart(2, '0');
      const len  = value.length.toString().padStart(2, '0');
      return hex + len + value;
    }

    const merchant = tlv('00', '01') + tlv('01', '12') + tlv('26',
      tlv('00', 'br.gov.bcb.pix') + tlv('01', chavePix)
    );

    const payload =
      tlv('00', '01') +
      merchant +
      tlv('52', '0000') +
      tlv('53', '986') +
      tlv('54', v) +
      tlv('58', 'BR') +
      tlv('59', nome.slice(0, 25).toUpperCase().normalize('NFD').replace(/[^\w\s]/g,'')) +
      tlv('60', cidade.slice(0, 15).toUpperCase()) +
      tlv('62', tlv('05', (txid || Utils.generateId().slice(0,10)).slice(0,25)));

    // CRC16-CCITT
    const crc = _crc16(payload + '6304');
    return payload + tlv('63', crc.toString(16).toUpperCase().padStart(4, '0'));
  }

  function _crc16(str) {
    let crc = 0xFFFF;
    for (let i = 0; i < str.length; i++) {
      crc ^= str.charCodeAt(i) << 8;
      for (let j = 0; j < 8; j++) {
        crc = (crc & 0x8000) ? (crc << 1) ^ 0x1021 : crc << 1;
      }
    }
    return crc & 0xFFFF;
  }

  // ── Pedido de assinatura ─────────────────────────────────────────
  async function criarCobranca(planoId, ciclo = 'mensal') {
    const empresaId = window.CH?.SaasService?.getEmpresaId?.() || null;
    if (!empresaId) throw new Error('Empresa não identificada. Faça login primeiro.');

    const info  = PRECOS[planoId];
    if (!info)  throw new Error(`Plano desconhecido: ${planoId}`);

    const valor = info[ciclo];
    if (!valor) throw new Error(`Ciclo inválido: ${ciclo}`);

    const chavePix = _getChavePix();
    if (!chavePix) throw new Error('Chave PIX não configurada. Acesse Configurações → Billing.');

    const txid = `CH${empresaId.slice(0,6).toUpperCase()}${Date.now().toString(36).toUpperCase()}`;

    const pixPayload = _gerarPixPayload({
      chavePix,
      nome:   _getNomeRecebedor(),
      cidade: _getCidade(),
      valor,
      txid,
    });

    const pedido = {
      id:        Utils.generateId(),
      empresaId,
      planoId,
      ciclo,
      valor,
      txid,
      pixPayload,
      status:    'aguardando',
      criadoEm:  Utils.nowISO(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
    };

    // Salva pedido no Firestore
    try {
      const FB = window.CH?.FirebaseService;
      if (FB?.isReady()) {
        await FB.salvar(`billing_pedidos`, pedido);
      }
    } catch (e) {
      console.warn('[Billing] Falha ao salvar pedido no Firebase:', e.message);
    }

    // Salva local como pendente
    Store.mutateConfig(cfg => {
      cfg.billing = cfg.billing || {};
      cfg.billing.pedidoPendente = pedido;
    });

    EventBus.emit('billing:cobranca-criada', pedido);
    return pedido;
  }

  /**
   * Confirma pagamento manualmente (admin).
   * Em produção, isso seria feito por um webhook do banco.
   */
  async function confirmarPagamento(pedidoId) {
    Store.mutateConfig(cfg => {
      const p = cfg.billing?.pedidoPendente;
      if (p && p.id === pedidoId) {
        cfg.billing.pedidoPendente = null;
        cfg.billing.ultimoPagamento = { ...p, status: 'pago', pagoEm: Utils.nowISO() };
      }
    });

    const pedido  = Store.getConfig()?.billing?.ultimoPagamento;
    const planoId = pedido?.planoId;

    if (planoId) {
      // Atualiza plano da empresa no Firestore
      try {
        const FB = window.CH?.FirebaseService;
        if (FB?.isReady()) {
          const sess = window.CH?.SaasService?.getSession?.();
          if (sess?.empresaId) {
            // Atualiza o campo plano na empresa
            const batch = FB.getBatch();
            const empRef = FB.docRef('saas_empresas', sess.empresaId);
            batch.set(empRef, {
              plano:        planoId,
              planoAtivoEm: Utils.nowISO(),
              pedidoId,
            }, { merge: true });
            await batch.commit();
          }
        }
      } catch (e) {
        console.warn('[Billing] Falha ao atualizar plano:', e.message);
      }

      // Atualiza featureflags em memória
      window.CH?.FeatureFlags?.setPlano?.(planoId);

      // Define próximo vencimento automaticamente
      const ciclo = pedido?.ciclo || 'mensal';
      const proxVenc = _setProximoVencimento(ciclo);
      console.info('[BillingService] Próximo vencimento definido:', proxVenc);
    }

    EventBus.emit('billing:confirmado', { pedidoId, planoId });
    return true;
  }

  // ── Histórico de assinaturas ─────────────────────────────────────
  function getAssinaturaAtual() {
    const sess = window.CH?.SaasService?.getSession?.();
    const plan = sess?.plano || Store.getConfig()?.plano || 'free';
    const info = PRECOS[plan];
    return {
      plano:    plan,
      label:    info?.label || 'Grátis',
      preco:    info?.mensal || 0,
      ativa:    true,
      pendente: Store.getConfig()?.billing?.pedidoPendente || null,
    };
  }

  function getPrecos() { return PRECOS; }

  // ── Verificação automática de vencimento ────────────────────────
  /**
   * Verifica se o plano pago está vencido (sem pagamento confirmado no ciclo atual).
   * Retorna { vencido: bool, diasRestantes: number, mensagem: string }
   *
   * Lógica:
   *   - plano 'free' nunca vence
   *   - plano pago: lê cfg.billing.proximoVencimento
   *   - se hoje >= vencimento: emite 'billing:vencido' e faz downgrade para 'free'
   *   - se hoje >= vencimento - 3 dias: emite 'billing:aviso-vencimento'
   */
  function verificarVencimento() {
    const cfg = Store.getConfig()?.billing || {};
    const planoAtual = window.CH?.SaasService?.getSession?.()?.plano || Store.getConfig()?.plano || 'free';

    if (planoAtual === 'free') return { vencido: false, diasRestantes: Infinity, mensagem: null };

    const venc = cfg.proximoVencimento; // formato 'YYYY-MM-DD'
    if (!venc) return { vencido: false, diasRestantes: null, mensagem: 'Sem data de vencimento registrada' };

    const hoje      = new Date();
    const dataVenc  = new Date(venc + 'T00:00:00');
    const diffMs    = dataVenc - hoje;
    const diasRestantes = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

    if (diasRestantes <= 0) {
      // Plano vencido — downgrade para free no contexto local
      console.warn('[BillingService] Plano vencido em', venc, '— fazendo downgrade para free');
      Store.mutateConfig(cfg => { cfg.plano = 'free'; });
      if (window.CH?.FeatureFlags?.setPlano) window.CH.FeatureFlags.setPlano('free');
      EventBus.emit('billing:vencido', { plano: planoAtual, vencimento: venc });
      window.showToast?.(
        '⚠️ Assinatura vencida',
        `Plano ${planoAtual} expirou em ${new Date(venc).toLocaleDateString('pt-BR')}. Renove para continuar.`,
        'error'
      );
      return { vencido: true, diasRestantes: 0, mensagem: `Plano vencido em ${new Date(venc).toLocaleDateString('pt-BR')}` };
    }

    if (diasRestantes <= 3) {
      EventBus.emit('billing:aviso-vencimento', { diasRestantes, vencimento: venc });
      window.showToast?.(
        '⚠️ Assinatura expirando',
        `Seu plano vence em ${diasRestantes} dia(s). Renove agora.`,
        'warning'
      );
    }

    return { vencido: false, diasRestantes, mensagem: null };
  }

  /**
   * Define a data do próximo vencimento após confirmação de pagamento.
   * Chamado por confirmarPagamento() automaticamente.
   * @param {string} ciclo — 'mensal' | 'anual'
   */
  function _setProximoVencimento(ciclo = 'mensal') {
    const hoje = new Date();
    const venc = new Date(hoje);
    if (ciclo === 'anual')  venc.setFullYear(venc.getFullYear() + 1);
    else                    venc.setMonth(venc.getMonth() + 1);
    const vencISO = venc.toISOString().slice(0, 10);
    Store.mutateConfig(cfg => {
      cfg.billing = cfg.billing || {};
      cfg.billing.proximoVencimento = vencISO;
      cfg.billing.ultimoPagamento   = hoje.toISOString().slice(0, 10);
    });
    return vencISO;
  }

  // ── Configuração da chave PIX ────────────────────────────────────
  function configurarPix({ chavePix, nomeRecebedor, cidade }) {
    Store.mutateConfig(cfg => {
      cfg.billing = cfg.billing || {};
      if (chavePix)       cfg.billing.chavePix       = chavePix.trim();
      if (nomeRecebedor)  cfg.billing.nomeRecebedor  = nomeRecebedor.trim();
      if (cidade)         cfg.billing.cidade         = cidade.trim();
    });
  }

  // ── Exportar ─────────────────────────────────────────────────────
  window.CH.BillingService = {
    criarCobranca,
    confirmarPagamento,
    getAssinaturaAtual,
    getPrecos,
    configurarPix,
    verificarVencimento,
    gerarPixPayload: _gerarPixPayload, // exposto para testes
  };

  // ── Verificação automática ao carregar ──────────────────────────
  // Executa 5s após init para garantir que Store e UIService estejam prontos
  setTimeout(() => {
    try { verificarVencimento(); } catch(e) {
      console.warn('[BillingService] verificarVencimento falhou:', e.message);
    }
  }, 5000);

  console.info('%c BillingService ✓  (PIX QR Code | assinaturas | vencimento automático)', 'color:#10b981;font-weight:bold');
})();
