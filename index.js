import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import dotenv from 'dotenv';
import qrcode from 'qrcode-terminal';
import { Boom } from '@hapi/boom';
import http from 'http';

dotenv.config();

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot Demon🤖 está ativo!');
}).listen(PORT, () => {
  console.log(`🌐 Servidor HTTP ativo na porta ${PORT}`);
});

console.log('\n==========================================');
console.log('🤖 INICIANDO O WHATSAPP BOT: DEMON🤖 COM MENU INTERATIVO...');
console.log('==========================================\n');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const BOT_START_TIME = Math.floor(Date.now() / 1000);

const userStates = new Map();
const conversationHistory = new Map();

const CONFIG = {
  botName: 'Demon🤖',
  antiLink: true,
  welcomeMessage: true,
  prefix: '!'
};

// ==========================================
// MENSAGENS DOS MENUS INTERATIVOS NO PRIVADO
// ==========================================

const MENU_PRINCIPAL = `🤖 *ATENDIMENTO AUTOMÁTICO - DEMON🤖* ⚡

Olá! Seja muito bem-vindo(a).
Como posso ajudar você hoje?

*Escolha uma das opções abaixo digitando o número:*

1️⃣ 🛍️ *Ver Produtos / Serviços*
2️⃣ 💰 *Preços e Formas de Pagamento*
3️⃣ 📍 *Horário de Atendimento e Informações*
4️⃣ 🧠 *Tirar Dúvidas com Inteligência Artificial*
5️⃣ 👤 *Falar com Atendente Humano*

_Digite o número correspondente (ex: 1, 2, 3...)_`;

const SUBMENU_PRODUTOS = `🛍️ *CATÁLOGO DE PRODUTOS & SERVIÇOS* ⚡

Aqui estão as nossas soluções disponíveis:

💻 *1. Chatbot Personalizado com IA* (Atendimento 24h no WhatsApp)
🛡️ *2. Bot de Moderação de Grupos* (Anti-Link, Boas-Vindas e Comandos)
⚙️ *3. Automações e Integrações sob Medida*

---
👉 *Digite 2* para ver formas de pagamento
👉 *Digite 4* para tirar dúvidas com a IA
👉 *Digite 0* para voltar ao Menu Principal`;

const SUBMENU_PAGAMENTOS = `💰 *FORMAS DE PAGAMENTO & VALORES* ⚡

Trabalhamos com condições facilitadas:

💳 *Formas Aceitas:*
• Pix (Aprovação imediata)
• Cartão de Crédito / Débito
• Transferência Bancária

💵 *Planos de Chatbot:*
• Taxa de Instalação/Setup: A partir de R$ 350
• Mensalidade de Manutenção: R$ 100/mês

---
👉 *Digite 5* para fechar um pedido com atendente humano
👉 *Digite 0* para voltar ao Menu Principal`;

const SUBMENU_INFORMACOES = `📍 *INFORMAÇÕES E ATENDIMENTO* ⚡

⏰ *Horário de Funcionamento:*
• Segunda a Sexta: 08h00 às 18h00
• Sábado: 08h00 às 13h00
• *Chatbot Online:* 24 Horas por dia, 7 dias por semana!

---
👉 *Digite 0* para voltar ao Menu Principal`;

const SUBMENU_HUMANO = `👤 *SOLICITAÇÃO DE ATENDIMENTO HUMANO* ⚡

✅ Sua solicitação foi registrada com sucesso!
O atendente responsável já foi notificado e responderá assim que estiver disponível.

_Enquanto isso, você pode deixar sua mensagem ou dúvida aqui embaixo!_

👉 *Digite 0* a qualquer momento para voltar ao Menu Principal.`;

// ==========================================
// HELPER: Extract text from Baileys message
// ==========================================

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
    ''
  );
}

// ==========================================
// FUNÇÃO PARA CHAMAR A API DO GOOGLE GEMINI
// ==========================================

async function getGeminiResponse(userId, userMessage) {
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
        parts: [{ text: `Você é o Demon🤖, um assistente inteligente de IA. Responda em Português de forma direta, clara e amigável. Se o usuário quiser voltar ao menu de opções, lembre-o de digitar "0".` }]
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

async function isBotAdmin(sock, groupJid) {
  try {
    const botNumber = sock.user?.id?.split(':')[0]?.split('@')[0];
    if (!botNumber) return false;

    const metadata = await sock.groupMetadata(groupJid);
    for (const p of metadata.participants) {
      const pNumber = p.id.split(':')[0].split('@')[0];
      if (pNumber === botNumber) {
        return p.admin === 'admin' || p.admin === 'superadmin';
      }
    }
    return false;
  } catch (err) {
    console.error('[isBotAdmin] Error:', err.message);
    return false;
  }
}

async function isUserAdmin(sock, groupJid, userId) {
  try {
    const senderNumber = userId.split(':')[0].split('@')[0];

    const metadata = await sock.groupMetadata(groupJid);
    for (const p of metadata.participants) {
      const pNumber = p.id.split(':')[0].split('@')[0];
      if (pNumber === senderNumber) {
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
    browser: ['DemonBot', 'Safari', '3.0.0'],
  });

  // Save credentials on every update
  sock.ev.on('creds.update', saveCreds);

  // ==========================================
  // CONNECTION UPDATE
  // ==========================================

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📱 Scan the QR code below with WhatsApp:');
      console.log('   Open WhatsApp > Linked Devices > Link a Device\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      let statusCode;
      if (lastDisconnect?.error) {
        statusCode = lastDisconnect.error.output?.statusCode;
      } else if (lastDisconnect?.output) {
        statusCode = lastDisconnect.output?.statusCode;
      }

      if (statusCode && statusCode !== DisconnectReason.loggedOut) {
        console.log(`⚠️ Conexão perdida (código: ${statusCode}). Reconectando...`);
        startBot();
      } else {
        console.log('❌ Desconectado (logout). Delete a pasta "auth_session" e reinicie.');
      }
    }

    if (connection === 'open') {
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
          const welcomeCaption = `👋 *SEJA BEM-VINDO(A) AO GRUPO!* ⚡\n\nOlá @${number}, você acabou de entrar!\n\n🛡️ *Regras:* Proibido links e spam (Anti-Link ativo). Participe e aproveite!`;
          await sock.sendMessage(update.id, { text: welcomeCaption, mentions: [participant] });
        } else if (update.action === 'remove') {
          await sock.sendMessage(update.id, { text: `🚪 @${number} saiu do grupo.`, mentions: [participant] });
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
          if (!botAdmin) continue;

          const textLower = messageBody.toLowerCase();

          // Menu em Grupo
          if (['!menu', '!ajuda', '!help'].includes(textLower)) {
            const groupMenu = `🤖 *MENU DE COMANDOS DE GRUPO - DEMON🤖*\n\n` +
              `👑 *Comandos de Moderação:*\n` +
              `• *!fechar* - Tranca o grupo para apenas admins falarem\n` +
              `• *!abrir* - Destranca o grupo para todos falarem\n` +
              `• *!todos [aviso]* - Marca todos os membros\n` +
              `• *!ban @membro* - Expulsa um membro\n` +
              `• *!antilink on/off* - Liga ou desliga proteção de links\n\n` +
              `⚡ *Inteligência Artificial:*\n` +
              `• *!demon [pergunta]* - Pergunta para a IA no grupo`;
            await sock.sendMessage(remoteJid, { text: groupMenu });
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

        // Comando para voltar ao menu principal a qualquer momento
        if (['0', 'menu', 'voltar', 'inicio', 'início', 'oi', 'olá', 'ola', 'bom dia', 'boa tarde', 'boa noite', 'ajuda'].includes(textLower) && currentState !== 'INITIAL') {
          userStates.set(userKey, 'MAIN_MENU');
          await sock.sendMessage(userKey, { text: MENU_PRINCIPAL });
          console.log(`🤖 Demon🤖 enviou o Menu Principal para [${senderNumber}]\n`);
          continue;
        }

        // Se o usuário estiver no modo de Chat IA Livre (Opção 4)
        if (currentState === 'AI_MODE') {
          const iaReply = await getGeminiResponse(userKey, messageBody);
          const replyWithFooter = `${iaReply}\n\n─────────────────────\n👉 *Digite 0* para voltar ao Menu Principal`;
          await sock.sendMessage(userKey, { text: replyWithFooter });
          console.log(`🤖 Demon🤖 respondeu com IA no privado para [${senderNumber}]\n`);
          continue;
        }

        // ==========================================
        // PROCESSAMENTO DAS ESCOLHAS DO MENU
        // ==========================================

        switch (textLower) {
          case '1':
            userStates.set(userKey, 'VIEW_PRODUCTS');
            await sock.sendMessage(userKey, { text: SUBMENU_PRODUTOS });
            console.log(`🤖 Demon🤖 enviou Catálogo para [${senderNumber}]\n`);
            break;

          case '2':
            userStates.set(userKey, 'VIEW_PAYMENTS');
            await sock.sendMessage(userKey, { text: SUBMENU_PAGAMENTOS });
            console.log(`🤖 Demon🤖 enviou Pagamentos para [${senderNumber}]\n`);
            break;

          case '3':
            userStates.set(userKey, 'VIEW_INFO');
            await sock.sendMessage(userKey, { text: SUBMENU_INFORMACOES });
            console.log(`🤖 Demon🤖 enviou Informações para [${senderNumber}]\n`);
            break;

          case '4':
            userStates.set(userKey, 'AI_MODE');
            const aiWelcome = `🧠 *MODO INTELIGÊNCIA ARTIFICIAL ATIVADO!* ⚡\n\nOlá! Sou o cérebro inteligente do Demon🤖.\nPode me fazer qualquer pergunta sobre nossos serviços, dúvidas gerais ou agendamentos.\n\n_Envie sua dúvida abaixo:_\n*(Digite 0 para voltar ao Menu Principal)*`;
            await sock.sendMessage(userKey, { text: aiWelcome });
            console.log(`🤖 Demon🤖 ativou Modo IA para [${senderNumber}]\n`);
            break;

          case '5':
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
