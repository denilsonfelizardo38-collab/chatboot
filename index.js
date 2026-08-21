import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  generateWAMessageFromContent,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import dotenv from 'dotenv';
import QRCode from 'qrcode';
import { Boom } from '@hapi/boom';
import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const PORT = process.env.PORT || 3000;
let currentQRImage = null;
let connectionState = 'a iniciar...';
const recentLogs = [];
const _origLog = console.log.bind(console);
const _origErr = console.error.bind(console);
console.log = (...a) => { const l = a.map(String).join(' '); recentLogs.push(l); if (recentLogs.length > 40) recentLogs.shift(); _origLog(...a); };
console.error = (...a) => { const l = '[ERRO] ' + a.map(String).join(' '); recentLogs.push(l); if (recentLogs.length > 40) recentLogs.shift(); _origErr(...a); };

const server = http.createServer((req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  const pathOnly = (req.url || '/').split('?')[0];
  if ((pathOnly === '/qr' || pathOnly === '/qr.png') && currentQRImage) {
    if (pathOnly === '/qr') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><meta http-equiv="refresh" content="15"><style>body{font-family:sans-serif;text-align:center;background:#111;color:#eee}img{max-width:400px;width:100%;background:#fff;padding:10px;border-radius:8px}</style></head><body><h1>📱 Escaneia o QR Code</h1><img src="/qr.png?v=' + Date.now() + '"><p>Esta pagina atualiza o QR automaticamente a cada 15 segundos.</p></body></html>');
    } else {
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(currentQRImage);
    }
  } else if (pathOnly === '/qr' || pathOnly === '/qr.png') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html><head><meta http-equiv="refresh" content="5"></head><body style="font-family:sans-serif;text-align:center;background:#111;color:#eee"><h1>QR Code ainda nao gerado. Aguarda...</h1><p>Esta pagina recarrega automaticamente a cada 5 segundos.</p></body></html>');
  } else if (req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`ESTADO: ${connectionState}\nQR pendente: ${currentQRImage ? 'sim' : 'nao'}\n\nULTIMOS EVENTOS:\n${recentLogs.slice(-20).join('\n') || '(nenhum ainda)'}`);
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`${CFG.botName} está ativo!`);
  }
}).listen(PORT, () => {
  console.log(`🌐 Servidor HTTP ativo na porta ${PORT}`);
});

console.log('\n==========================================');
console.log(`🤖 INICIANDO O WHATSAPP BOT: ${CFG.botName} COM MENU INTERATIVO...`);
console.log('==========================================\n');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BOT_START_TIME = Math.floor(Date.now() / 1000);

const userStates = new Map();
const conversationHistory = new Map();

// ==========================================
// FUNIL DE VENDAS: leads + follow-up de 10 min
// ==========================================

const leads = new Map();          // userId -> { step, produto, numero, nome, localizacao }
const followUpTimers = new Map(); // userId -> timeout handle
const FOLLOW_UP_MS = 10 * 60 * 1000;

function clearFollowUp(userId) {
  const t = followUpTimers.get(userId);
  if (t) clearTimeout(t);
  followUpTimers.delete(userId);
}

function armFollowUp(sock, userId) {
  clearFollowUp(userId);
  const t = setTimeout(async () => {
    try {
      const lead = leads.get(userId);
      if (!lead) return;
      const msg = (CFG.followUpMessage || 'Olá! Ainda está por aí? 👋 Ainda tem interesse no *{{PRODUTO}}*?')
        .replace(/{{NOME}}/g, lead.nome ? `, ${lead.nome}` : '')
        .replace(/{{PRODUTO}}/g, lead.produto?.nome || 'produto');
      await sock.sendMessage(userId, { text: msg });
      console.log(`[Follow-up] enviado para [${userId}] sobre ${lead.produto?.nome || '?'}`);
    } catch {}
    armFollowUp(sock, userId);
  }, FOLLOW_UP_MS);
  followUpTimers.set(userId, t);
}

const CONFIG = {
  botName: CFG.botName,
  antiLink: CFG.antiLink,
  welcomeMessage: CFG.welcomeMessage,
  prefix: CFG.prefix
};

// ==========================================
// MENSAGENS DOS MENUS INTERATIVOS NO PRIVADO
// ==========================================

const MENU_PRINCIPAL = CFG.menuPrincipal;

const SUBMENU_PRODUTOS = CFG.submenuProdutos;

const SUBMENU_PAGAMENTOS = CFG.submenuPagamentos;

const SUBMENU_INFORMACOES = CFG.submenuInformacoes;

const SUBMENU_HUMANO = CFG.submenuHumano;

// ==========================================
// HELPER: Extract text from Baileys message
// ==========================================

function parseInteractiveResponse(msg) {
  try {
    const json = JSON.parse(msg?.nativeFlowResponseMessage?.paramsJson || '{}');
    return json.id || '';
  } catch {
    return '';
  }
}

function getMessageContent(msg) {
  const m = msg.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    parseInteractiveResponse(m.interactiveResponseMessage) ||
    ''
  );
}

// ==========================================
// HELPER: Menus interativos (botões/lista)
// ==========================================

const ROWS = {
  main: [
    { title: '🛍️ Produtos / Serviços', rowId: 'menu_produtos' },
    { title: '💰 Preços e Pagamento', rowId: 'menu_pagamentos' },
    { title: '📍 Horário e Informações', rowId: 'menu_info' },
    { title: '🧠 Falar com a IA', rowId: 'modo_ia' },
    { title: '👤 Atendente Humano', rowId: 'menu_humano' }
  ],
  products: [
    { title: '💰 Formas de Pagamento', rowId: 'menu_pagamentos' },
    { title: '🧠 Tirar dúvidas com IA', rowId: 'modo_ia' },
    { title: '🏠 Menu Principal', rowId: 'menu_principal' }
  ],
  payments: [
    { title: '👤 Falar com Atendente', rowId: 'menu_humano' },
    { title: '🏠 Menu Principal', rowId: 'menu_principal' }
  ],
  info: [
    { title: '🏠 Menu Principal', rowId: 'menu_principal' }
  ],
  human: [
    { title: '🏠 Menu Principal', rowId: 'menu_principal' }
  ],
  aiExit: [
    { title: '🏠 Menu Principal', rowId: 'menu_principal' }
  ]
};

function listPayload(bodyText, rows, opts = {}) {
  return {
    viewOnceMessage: {
      message: {
        messageContextInfo: {
          deviceSentryMetadata: {},
          messageSecret: crypto.randomBytes(32)
        },
        interactiveMessage: {
          header: { title: CFG.botName, hasMediaAttachment: false },
          body: { text: bodyText },
          footer: { text: '👇 Toque no botão para escolher' },
          nativeFlowMessage: {
            buttons: [
              {
                name: 'single_select',
                buttonParamsJson: JSON.stringify({
                  has_multiple_buttons: true,
                  sections: [
                    {
                      title: opts.sectionTitle || 'Opções',
                      rows: rows.map((r) => ({
                        id: r.rowId,
                        title: r.title,
                        description: r.description || ''
                      }))
                    }
                  ]
                })
              }
            ],
            messageParamsJson: ''
          }
        }
      }
    }
  };
}

async function sendList(sock, jid, bodyText, rows, opts = {}) {
  const targets = [];
  if (String(jid).endsWith('@lid')) {
    targets.push(jid);
    try {
      const pn = await sock.signalRepository?.lidMapping?.getPNForLID(jid);
      if (pn) {
        const bare = pn.split('@')[0].split(':')[0];
        targets.push(`${bare}@s.whatsapp.net`);
        targets.push(pn);
      }
    } catch {}
  } else {
    targets.push(jid);
  }

  for (const target of targets) {
    try {
      if (typeof sock.assertSessions === 'function') {
        await sock.assertSessions([target], true);
      }
      const msg = generateWAMessageFromContent(target, listPayload(bodyText, rows, opts), {
        userJid: sock.user?.id
      });
      await sock.relayMessage(target, msg.message, { messageId: msg.key.id });
      console.log(`[sendList] menu interativo enviado com sucesso para ${target}`);
      return;
    } catch (err) {
      console.error(`[sendList] falhou para ${target}: ${err.message}`);
    }
  }

  console.error('[sendList] todos os alvos falharam - a enviar texto simples');
  try {
    await sock.sendMessage(jid, { text: bodyText });
  } catch (err) {
    console.error('[sendList] fallback texto falhou:', err.message);
  }
}

// ==========================================
// FUNIL DE VENDAS: catálogo e prompt de vendedor
// ==========================================

function getProdutos() {
  return Array.isArray(CFG.produtos) ? CFG.produtos : [];
}

function productListText() {
  const prods = getProdutos();
  if (!prods.length) return null;
  let t = '🛍️ *NOSSOS PRODUTOS*\n\n';
  prods.forEach((p, i) => {
    t += `*${i + 1}. ${p.nome}*${p.preco ? `\n💰 ${p.preco}` : ''}\n${p.descricao || ''}\n\n`;
  });
  t += '_Digite o *número* do produto para ver tudo sobre ele_\n_Digite 0 para voltar ao Menu Principal_';
  return t;
}

function findProduto(textLower) {
  const prods = getProdutos();
  const idx = parseInt(textLower, 10) - 1;
  if (!Number.isNaN(idx) && prods[idx]) return prods[idx];
  return prods.find(p => p.nome && String(p.nome).toLowerCase().includes(textLower)) || null;
}

function buildSalesPrompt(lead) {
  const p = lead.produto || {};
  return (CFG.salesSystemPrompt ||
    'Você é um vendedor persuasivo pelo WhatsApp. Produto: {{PRODUTO_NOME}}. Responda curto, em português, sempre empurrando para a compra.')
    .replace(/{{PRODUTO_NOME}}/g, p.nome || 'produto')
    .replace(/{{PRODUTO_PRECO}}/g, p.preco || 'a consultar')
    .replace(/{{PRODUTO_DESCRICAO}}/g, p.descricao || '')
    .replace(/{{ESPECIFICACOES}}/g, Array.isArray(p.especificacoes) ? p.especificacoes.join('; ') : '')
    .replace(/{{NOME_CLIENTE}}/g, lead.nome || 'cliente')
    .replace(/{{LOCALIZACAO}}/g, lead.localizacao || '')
    .replace(/{{NUMERO_CLIENTE}}/g, lead.numero || '');
}

// ==========================================
// FUNÇÃO PARA CHAMAR A API DO GOOGLE GEMINI
// ==========================================

async function getGeminiResponse(userId, userMessage, systemInstructionText) {
  try {
    if (!GEMINI_API_KEY) {
      return "⚠️ Chave do Gemini não configurada no arquivo .env.";
    }

    let history = conversationHistory.get(userId) || [];
    history.push({ role: 'user', parts: [{ text: userMessage }] });

    if (history.length > 10) history = history.slice(-10);
    conversationHistory.set(userId, history);

    const payload = {
        systemInstruction: {
          parts: [{ text: systemInstructionText || CFG.aiSystemPrompt }]
      },
      contents: history,
      generationConfig: { temperature: 0.7, maxOutputTokens: 500 }
    };

    const modelCandidates = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];

    for (const model of modelCandidates) {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          }
        );

        const data = await response.json();
        if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
          const botReply = data.candidates[0].content.parts[0].text.trim();
          history.push({ role: 'model', parts: [{ text: botReply }] });
          conversationHistory.set(userId, history);
          return botReply;
        }
      } catch (err) {
        console.warn(`Erro no modelo ${model}:`, err.message);
      }
    }

    return 'Desculpe, tive uma instabilidade momentânea na conexão com a IA. Pode repetir?';
  } catch (error) {
    console.error('Erro ao chamar o Gemini:', error);
    return 'Desculpe, tive um pequeno problema técnico. Já estou verificando!';
  }
}

// ==========================================
// ADMIN CHECK FUNCTIONS
// ==========================================

function jidNumber(jid) {
  return String(jid || '').split(':')[0].split('@')[0];
}

async function isBotAdmin(sock, groupJid) {
  try {
    const botNumbers = new Set();
    if (sock.user?.id) botNumbers.add(jidNumber(sock.user.id));
    if (sock.user?.lid) botNumbers.add(jidNumber(sock.user.lid));

    const metadata = await sock.groupMetadata(groupJid);
    for (const p of metadata.participants) {
      const pNumbers = [p.id, p.jid].filter(Boolean).map(jidNumber);
      if (pNumbers.some((n) => botNumbers.has(n))) {
        return p.admin === 'admin' || p.admin === 'superadmin';
      }
    }
    console.log(`[isBotAdmin] Bot não encontrado nos participantes de ${groupJid}`);
    return false;
  } catch (err) {
    console.error('[isBotAdmin] Error:', err.message);
    return false;
  }
}

async function isUserAdmin(sock, groupJid, userId) {
  try {
    const senderNumber = jidNumber(userId);

    const metadata = await sock.groupMetadata(groupJid);
    for (const p of metadata.participants) {
      const pNumbers = [p.id, p.jid].filter(Boolean).map(jidNumber);
      if (pNumbers.includes(senderNumber)) {
        return p.admin === 'admin' || p.admin === 'superadmin';
      }
    }
    return false;
  } catch (err) {
    console.error('[isUserAdmin] Error:', err.message);
    return false;
  }
}

// ==========================================
// MAIN BOT FUNCTION
// ==========================================

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_session');

  let version;
  try {
    const fetched = await fetchLatestBaileysVersion();
    version = fetched.version;
  } catch {
    version = [2, 2413, 1];
  }

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    printQRInTerminal: false,
    browser: [CFG.browserName, 'Safari', '3.0.0'],
  });

  // Save credentials on every update
  sock.ev.on('creds.update', saveCreds);

  // ==========================================
  // CONNECTION UPDATE
  // ==========================================

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionState = 'à espera do escaneamento do QR';
      console.log('\n📱 QR Code gerado!');
      console.log('🔗 Abre https://chatboott-fqqa.onrender.com/qr no navegador para escanear\n');
      QRCode.toBuffer(qr, { width: 400, margin: 2 }).then((buf) => {
        currentQRImage = buf;
      }).catch((err) => {
        console.error('Erro ao gerar QR imagem:', err);
      });
    }

    if (connection === 'close') {
      const statusCode =
        lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.status ??
        lastDisconnect?.output?.statusCode;

      currentQRImage = null;

      if (statusCode === DisconnectReason.loggedOut) {
        connectionState = 'deslogado — apaga auth_session e reinicia';
        console.log('❌ Desconectado (logout real). Delete a pasta "auth_session" e reinicie.');
      } else {
        connectionState = 'desconectado — a reconectar...';
        console.log(`⚠️ Conexão perdida (código: ${statusCode ?? 'desconhecido'}). Reconectando em 3s...`);
        setTimeout(startBot, 3000);
      }
    }

    if (connection === 'open') {
      connectionState = 'CONECTADO ✓';
      console.log('\n=============================================');
      console.log('✅ BOT DEMON🤖 CONECTADO COM SUCESSO!');
      console.log('📋 Menus Interativos no Privado: ATIVADOS');
      console.log('🛡️ Moderação de Grupos + Anti-Link: ATIVADOS');
      console.log('=============================================\n');
    }
  });

  // ==========================================
  // GROUP PARTICIPANTS UPDATE (Welcome / Leave)
  // ==========================================

  sock.ev.on('group-participants.update', async (update) => {
    try {
      if (!CONFIG.welcomeMessage) return;

      const botAdmin = await isBotAdmin(sock, update.id);
      if (!botAdmin) return;

      for (const participant of update.participants) {
        const number = participant.split(':')[0].split('@')[0];

        if (update.action === 'add') {
          const welcomeCaption = CFG.welcomeGroup.replace(/@NUMERO/g, `@${number}`);
          await sock.sendMessage(update.id, { text: welcomeCaption, mentions: [participant] });
        } else if (update.action === 'remove') {
          const leaveCaption = CFG.leaveGroup.replace(/@NUMERO/g, `@${number}`);
          await sock.sendMessage(update.id, { text: leaveCaption, mentions: [participant] });
        }
      }
    } catch (err) {
      console.error('[group-participants.update] Error:', err.message);
    }
  });

  // ==========================================
  // MESSAGES UPSERT (Main Message Handler)
  // ==========================================

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        const dbgJid = msg.key.remoteJid || '?';
        console.log(`[DEBUG] msg recebida | jid=${dbgJid} | fromMe=${msg.key.fromMe} | type=${type} | temTexto=${!!getMessageContent(msg).trim()}`);

        if (msg.key.fromMe) continue;

        const remoteJid = msg.key.remoteJid;

        if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) continue;

        if (!msg.message) continue;

        if (msg.messageTimestamp && msg.messageTimestamp < BOT_START_TIME - 30) continue;

        const messageBody = getMessageContent(msg).trim();
        if (!messageBody) continue;

        const isGroup = remoteJid.endsWith('@g.us');
        const senderId = isGroup ? (msg.key.participant || remoteJid) : remoteJid;
        const senderNumber = senderId.split(':')[0].split('@')[0];

        console.log(`📩 [${isGroup ? 'Grupo' : 'Privado'}] [${senderNumber}]: "${messageBody}"`);

        // ==========================================
        // SEÇÃO A: MENSAGENS EM GRUPOS
        // ==========================================

        if (isGroup) {
          const botAdmin = await isBotAdmin(sock, remoteJid);
          if (!botAdmin) {
            console.log(`[Grupo] Mensagem ignorada (bot não detectado como admin): ${remoteJid}`);
            continue;
          }

          const textLower = messageBody.toLowerCase();

          // Menu em Grupo
          if (['!menu', '!ajuda', '!help'].includes(textLower)) {
            await sock.sendMessage(remoteJid, { text: CFG.groupMenu });
            continue;
          }

          // Anti-Link
          const linkRegex = /(https?:\/\/[^\s]+|chat\.whatsapp\.com\/[^\s]+|wa\.me\/[^\s]+)/gi;
          if (CONFIG.antiLink && linkRegex.test(messageBody)) {
            try {
              await sock.sendMessage(remoteJid, { delete: msg.key });
            } catch (e) {}
            try {
              await sock.groupParticipantsUpdate(remoteJid, [senderId], 'remove');
              await sock.sendMessage(remoteJid, {
                text: `🛡️ *ANTI-LINK DEMON🤖!*\n\n@${senderNumber} foi expulso do grupo por enviar links não autorizados.`,
                mentions: [senderId]
              });
            } catch (e) {}
            continue;
          }

          // !antilink
          if (textLower.startsWith('!antilink')) {
            const userAdmin = await isUserAdmin(sock, remoteJid, senderId);
            if (!userAdmin) {
              await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem usar este comando.' });
              continue;
            }
            const action = textLower.split(/ +/)[1];
            if (action === 'on' || action === '1') {
              CONFIG.antiLink = true;
              await sock.sendMessage(remoteJid, { text: '🛡️ *ANTI-LINK ATIVADO!*' });
            } else if (action === 'off' || action === '0') {
              CONFIG.antiLink = false;
              await sock.sendMessage(remoteJid, { text: '⚠️ *ANTI-LINK DESATIVADO!*' });
            } else {
              await sock.sendMessage(remoteJid, { text: `🛡️ Anti-Link está: *${CONFIG.antiLink ? 'ATIVADO' : 'DESATIVADO'}*.` });
            }
            continue;
          }

          // !fechar
          if (textLower === '!fechar') {
            const userAdmin = await isUserAdmin(sock, remoteJid, senderId);
            if (!userAdmin) {
              await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem usar este comando.' });
              continue;
            }
            try {
              await sock.groupSettingUpdate(remoteJid, 'announcement');
              await sock.sendMessage(remoteJid, { text: '🔒 *GRUPO FECHADO!* Apenas admins podem falar.' });
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ Falha ao fechar grupo: ${e.message || 'Erro desconhecido'}` });
            }
            continue;
          }

          // !abrir
          if (textLower === '!abrir') {
            const userAdmin = await isUserAdmin(sock, remoteJid, senderId);
            if (!userAdmin) {
              await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem usar este comando.' });
              continue;
            }
            try {
              await sock.groupSettingUpdate(remoteJid, 'not_announcement');
              await sock.sendMessage(remoteJid, { text: '🔓 *GRUPO ABERTO!* Todos podem falar.' });
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ Falha ao abrir grupo: ${e.message || 'Erro desconhecido'}` });
            }
            continue;
          }

          // !todos
          if (textLower.startsWith('!todos')) {
            const userAdmin = await isUserAdmin(sock, remoteJid, senderId);
            if (!userAdmin) {
              await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem usar este comando.' });
              continue;
            }
            const parts = messageBody.split(/ +/);
            parts.shift();
            const announcement = parts.join(' ') || 'Atenção a todos os membros!';
            try {
              const groupMeta = await sock.groupMetadata(remoteJid);
              const participants = groupMeta.participants.map(p => p.id);
              let text = `📢 *AVISO GERAL:*\n${announcement}\n\n`;
              for (const p of participants) text += `@${p.split(':')[0].split('@')[0]} `;
              await sock.sendMessage(remoteJid, { text, mentions: participants });
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: '❌ Erro ao obter lista de membros.' });
            }
            continue;
          }

          // !ban
          if (textLower.startsWith('!ban')) {
            const userAdmin = await isUserAdmin(sock, remoteJid, senderId);
            if (!userAdmin) {
              await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem usar este comando.' });
              continue;
            }

            let targetId = null;
            const contextInfo = msg.message.extendedTextMessage?.contextInfo;

            if (contextInfo?.participant) {
              targetId = contextInfo.participant;
            } else if (contextInfo?.mentionedJid?.length > 0) {
              targetId = contextInfo.mentionedJid[0];
            }

            if (!targetId) {
              await sock.sendMessage(remoteJid, { text: '⚠️ Marque o membro com `@` ou responda à mensagem dele com `!ban`.' });
              continue;
            }

            try {
              await sock.groupParticipantsUpdate(remoteJid, [targetId], 'remove');
              await sock.sendMessage(remoteJid, { text: '⚡ Membro expulso com sucesso!' });
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: '❌ Falha ao expulsar membro. Verifique se o bot é Admin.' });
            }
            continue;
          }

          // !add
          if (textLower.startsWith('!add')) {
            const userAdmin = await isUserAdmin(sock, remoteJid, senderId);
            if (!userAdmin) {
              await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem usar este comando.' });
              continue;
            }
            const numbers = messageBody.slice(4).trim().split(/[\s,;]+/).map(n => n.replace(/[^\d]/g, '')).filter(n => n.length >= 8);
            if (numbers.length === 0) {
              await sock.sendMessage(remoteJid, { text: '⚠️ Usa assim: *!add 258841234567*\n(Pode adicionar vários separados por espaço)' });
              continue;
            }
            const jids = numbers.map(n => `${n}@s.whatsapp.net`);
            try {
              const results = await sock.groupParticipantsUpdate(remoteJid, jids, 'add');
              const added = [], invited = [], failed = [];
              for (const r of results) {
                const num = String(r.jid || '').split('@')[0].split(':')[0];
                const st = String(r.status);
                if (st === '200') added.push(num);
                else if (st === '403') invited.push(num);
                else failed.push(`${num} (erro ${st})`);
              }
              let reply = '';
              if (added.length) reply += `✅ Adicionado(s): @${added.join('\n@')}\n`;
              if (invited.length) {
                reply += `📨 Convite enviado no privado para: @${invited.join('\n@')}\n_(a privacidade deles não permite adição direta)_\n`;
                try {
                  const code = await sock.groupInviteCode(remoteJid);
                  for (const num of invited) {
                    await sock.sendMessage(`${num}@s.whatsapp.net`, { text: `👋 Olá! Foste convidado(a) para entrar no grupo.\n\nEntra aqui: https://chat.whatsapp.com/${code}` });
                  }
                } catch {}
              }
              if (failed.length) reply += `❌ Falhou: ${failed.join(', ')}`;
              await sock.sendMessage(remoteJid, { text: reply.trim() || 'Sem resultados.', mentions: [...added, ...invited].map(n => `${n}@s.whatsapp.net`) });
            } catch (e) {
              await sock.sendMessage(remoteJid, { text: `❌ Falha ao adicionar. Verifica se o bot é admin no grupo.` });
            }
            continue;
          }

          // !demon / !ia
          if (textLower.startsWith('!demon') || textLower.startsWith('!ia')) {
            const userAdmin = await isUserAdmin(sock, remoteJid, senderId);
            if (!userAdmin) {
              await sock.sendMessage(remoteJid, { text: '❌ Apenas administradores podem usar este comando.' });
              continue;
            }
            const parts = messageBody.split(/ +/);
            parts.shift();
            const query = parts.join(' ');
            if (!query) {
              await sock.sendMessage(remoteJid, { text: '🤖 Faça uma pergunta após o comando.' });
              continue;
            }
            const iaReply = await getGeminiResponse(remoteJid, query);
            await sock.sendMessage(remoteJid, { text: `🤖 *Demon🤖:*\n\n${iaReply}` });
            continue;
          }

          continue;
        }

        // ==========================================
        // SEÇÃO B: CONVERSAS PRIVADAS (MENU INTERATIVO COM OPÇÕES)
        // ==========================================

        const userKey = senderId;
        const currentState = userStates.get(userKey) || 'INITIAL';
        const textLower = messageBody.toLowerCase().trim();

        // Mapeia números digitados para os IDs dos botões (compatibilidade)
        const typedMap = {
          '0': 'menu_principal',
          '1': 'menu_produtos',
          '2': 'menu_pagamentos',
          '3': 'menu_info',
          '4': 'modo_ia',
          '5': 'menu_humano'
        };
        let selection = typedMap[textLower] || textLower;

        // Saudações e volta ao menu principal a qualquer momento
        if (['menu_principal', 'menu', 'voltar', 'inicio', 'início', 'oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'ajuda'].includes(selection)) {
          leads.delete(userKey);
          clearFollowUp(userKey);
          userStates.set(userKey, 'MAIN_MENU');
          await sock.sendMessage(userKey, { text: MENU_PRINCIPAL });
          console.log(`🤖 Demon🤖 enviou o Menu Principal para [${senderNumber}]\n`);
          continue;
        }

        // ==========================================
        // FUNIL DE VENDAS
        // ==========================================

        // Escolha de produto dentro da lista
        if (currentState === 'PRODUCT_LIST' && !leads.has(userKey)) {
          const prod = findProduto(textLower);
          if (prod) {
            leads.set(userKey, { step: 'ASK_NUMERO', produto: prod });
            armFollowUp(sock, userKey);
            let cap = `🔥 *${prod.nome}*${prod.preco ? `\n💰 *Preço:* ${prod.preco}` : ''}\n\n${prod.descricao || ''}`;
            if (Array.isArray(prod.especificacoes) && prod.especificacoes.length) {
              cap += `\n\n📋 *Especificações:*\n${prod.especificacoes.map(e => `• ${e}`).join('\n')}`;
            }
            cap += `\n\n${CFG.pitchPosVenda || ''}`;
            try {
              if (prod.imagem) {
                await sock.sendMessage(userKey, { image: { url: prod.imagem }, caption: cap });
              } else {
                await sock.sendMessage(userKey, { text: cap });
              }
            } catch (err) {
              console.error('[vendas] falha ao enviar imagem do produto:', err.message);
              await sock.sendMessage(userKey, { text: cap });
            }
            await sock.sendMessage(userKey, { text: CFG.askNumero || 'Digite o seu número de telefone:' });
            console.log(`🛒 [${senderNumber}] escolheu o produto "${prod.nome}"`);
            continue;
          }
          await sock.sendMessage(userKey, { text: '⚠️ Não encontrei esse produto. Digite o *número* dele na lista, ou 0 para voltar.' });
          continue;
        }

        // Passos do lead: número → nome → zona → vendedor IA
        const lead = leads.get(userKey);
        if (lead) {
          clearFollowUp(userKey);

          if (lead.step === 'ASK_NUMERO') {
            const num = textLower.replace(/[^\d]/g, '');
            if (num.length < 7) {
              armFollowUp(sock, userKey);
              await sock.sendMessage(userKey, { text: '⚠️ Esse número parece curto. Exemplo válido: *84xxxxxxx*' });
              continue;
            }
            lead.numero = num;
            lead.step = 'ASK_NOME';
            armFollowUp(sock, userKey);
            await sock.sendMessage(userKey, { text: CFG.askNome || 'Como te chamas?' });
            console.log(`🛒 [${senderNumber}] deu o contacto ${num}`);
            continue;
          }

          if (lead.step === 'ASK_NOME') {
            lead.nome = messageBody.trim().slice(0, 60);
            lead.step = 'ASK_LOCAL';
            armFollowUp(sock, userKey);
            await sock.sendMessage(userKey, { text: (CFG.askLocal || 'Qual é a tua zona?').replace(/{{NOME}}/g, lead.nome) });
            console.log(`🛒 [${senderNumber}] chama-se ${lead.nome}`);
            continue;
          }

          if (lead.step === 'ASK_LOCAL') {
            lead.localizacao = messageBody.trim().slice(0, 120);
            lead.step = 'SELLING';
            armFollowUp(sock, userKey);
            const confirmMsg = (CFG.leadConfirm || '✅ Pedido registado!')
              .replace(/{{PRODUTO}}/g, lead.produto?.nome || '')
              .replace(/{{NUMERO}}/g, lead.numero || '')
              .replace(/{{LOCALIZACAO}}/g, lead.localizacao || '')
              .replace(/{{NOME}}/g, lead.nome || '');
            await sock.sendMessage(userKey, { text: confirmMsg });
            const firstPitch = await getGeminiResponse(userKey,
              `Acabei de registar o meu pedido do ${lead.produto?.nome}. Faz agora a tua apresentação de venda.`,
              buildSalesPrompt(lead));
            await sock.sendMessage(userKey, { text: firstPitch });
            console.log(`🛒 Lead completo de [${senderNumber}] — vendedor IA assumiu`);
            continue;
          }

          if (lead.step === 'SELLING') {
            const salesReply = await getGeminiResponse(userKey, messageBody, buildSalesPrompt(lead));
            await sock.sendMessage(userKey, { text: salesReply });
            armFollowUp(sock, userKey);
            console.log(`🤝 Vendedor IA respondeu a [${senderNumber}]`);
            continue;
          }
        }

        // Se o usuário estiver no modo de Chat IA Livre
        if (currentState === 'AI_MODE') {
          const iaReply = await getGeminiResponse(userKey, messageBody);
          const replyWithFooter = `${iaReply}\n\n─────────────────────\n👉 *Digite 0* para voltar ao Menu Principal`;
          await sock.sendMessage(userKey, { text: replyWithFooter });
          console.log(`🤖 Demon🤖 respondeu com IA no privado para [${senderNumber}]\n`);
          continue;
        }

        // ==========================================
        // PROCESSAMENTO DAS ESCOLHAS DO MENU (BOTÕES)
        // ==========================================

        switch (selection) {
          case 'menu_produtos':
            userStates.set(userKey, 'PRODUCT_LIST');
            await sock.sendMessage(userKey, { text: productListText() || SUBMENU_PRODUTOS });
            console.log(`🤖 Demon🤖 enviou Catálogo para [${senderNumber}]\n`);
            break;

          case 'menu_pagamentos':
            userStates.set(userKey, 'VIEW_PAYMENTS');
            await sock.sendMessage(userKey, { text: SUBMENU_PAGAMENTOS });
            console.log(`🤖 Demon🤖 enviou Pagamentos para [${senderNumber}]\n`);
            break;

          case 'menu_info':
            userStates.set(userKey, 'VIEW_INFO');
            await sock.sendMessage(userKey, { text: SUBMENU_INFORMACOES });
            console.log(`🤖 Demon🤖 enviou Informações para [${senderNumber}]\n`);
            break;

          case 'modo_ia':
            userStates.set(userKey, 'AI_MODE');
            await sock.sendMessage(userKey, { text: CFG.aiWelcome });
            console.log(`🤖 Demon🤖 ativou Modo IA para [${senderNumber}]\n`);
            break;

          case 'menu_humano':
            userStates.set(userKey, 'TALK_HUMAN');
            await sock.sendMessage(userKey, { text: SUBMENU_HUMANO });
            console.log(`🤖 Demon🤖 registrou Atendimento Humano para [${senderNumber}]\n`);
            break;

          default:
            userStates.set(userKey, 'MAIN_MENU');
            await sock.sendMessage(userKey, { text: MENU_PRINCIPAL });
            console.log(`🤖 Demon🤖 enviou Menu Inicial para [${senderNumber}]\n`);
            break;
        }

      } catch (err) {
        console.error('Erro ao processar mensagem:', err);
      }
    }
  });
}

// ==========================================
// INICIAR O BOT
// ==========================================

console.log('Iniciando o cliente do WhatsApp...');
startBot().catch(err => {
  console.error('Erro ao iniciar o bot:', err);
});
