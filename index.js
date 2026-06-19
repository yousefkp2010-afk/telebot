require('dotenv').config();
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const OpenAI = require('openai');
const express = require('express');

// ── إعدادات ────────────────────────────────────
const bot = new Telegraf(process.env.BOT_TOKEN);
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // رقم شات المالك (رقمي، مثل 123456789)

// ── عملاء API ───────────────────────────────────
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

let gemini = null;
if (process.env.GEMINI_API_KEY) {
  gemini = new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', // بدون شرطة مائلة في النهاية
  });
}

// ── ذاكرة المحادثة (سياق بسيط) ────────────────
const sessions = new Map();
const SESSION_TTL = 10 * 60 * 1000; // 10 دقائق
const MAX_HISTORY = 6; // آخر 3 تبادلات

function getSession(userId) {
  const now = Date.now();
  let session = sessions.get(userId);
  if (!session || now - session.lastActive > SESSION_TTL) {
    session = { messages: [], lastActive: now };
    sessions.set(userId, session);
  } else {
    session.lastActive = now;
  }
  return session;
}

function addMessageToSession(userId, role, content) {
  const session = getSession(userId);
  session.messages.push({ role, content });
  if (session.messages.length > MAX_HISTORY) {
    session.messages.shift();
  }
}

// ── إحصائيات بسيطة ────────────────────────────
const stats = {
  groq: { success: 0, fail: 0, totalTime: 0 },
  gemini: { success: 0, fail: 0, totalTime: 0 },
  lastReset: Date.now(),
};

function recordStat(model, success, duration) {
  const s = stats[model];
  if (success) {
    s.success++;
    s.totalTime += duration;
  } else {
    s.fail++;
  }
}

// ── دالة الرد المتدفق (Streaming) ─────────────
async function sendStreamedReply(ctx, modelType, client, modelName, messages) {
  const loadingMsg = await ctx.reply('⏳ جارٍ التفكير...');
  let fullText = '';

  try {
    const stream = await client.chat.completions.create({
      model: modelName,
      messages,
      stream: true,
    });

    let updateCounter = 0;
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      fullText += content;
      updateCounter++;
      if (updateCounter % 5 === 0 && fullText.length > 0) {
        await ctx.telegram.editMessageText(
          ctx.chat.id,
          loadingMsg.message_id,
          undefined,
          fullText,
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }
    }

    if (fullText.length > 0) {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        undefined,
        fullText,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    } else {
      await ctx.telegram.editMessageText(
        ctx.chat.id,
        loadingMsg.message_id,
        undefined,
        '❌ لم أحصل على رد.',
      ).catch(() => {});
    }

    return fullText;
  } catch (e) {
    await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
    throw e;
  }
}

// ── أمر /start ──────────────────────────────────
bot.start((ctx) => {
  const welcome = `🌟 **مرحباً بك في البوت الذكي!**\n\n` +
    `🔹 **/gemini سؤالك** ← ذكاء عميق (Google Gemini)\n` +
    `🔹 **/groq سؤالك** ← سرعة فائقة (Groq)\n\n` +
    `📌 *مثال:* /gemini اشرح الثقوب السوداء\n` +
    `📌 *مثال:* /groq اكتب دالة بايثون لترتيب قائمة\n\n` +
    `⚡ جرب كلا النموذجين وقارن!\n` +
    `ℹ️ استخدم /help لمعرفة كافة الأوامر.`;
  ctx.reply(welcome, { parse_mode: 'Markdown' });
});

// ── أمر /help ──────────────────────────────────
bot.help((ctx) => {
  const help = `📘 **دليل الاستخدام**\n\n` +
    `• **/gemini [نص]** – اسأل نموذج Google Gemini (عميق)\n` +
    `• **/groq [نص]** – اسأل نموذج Groq (سريع)\n` +
    `• **/start** – رسالة الترحيب\n` +
    `• **/help** – هذا الدليل\n` +
    `• **/stats** – إحصائيات الاستخدام (للمالك فقط)\n\n` +
    `🔄 **ميزة السياق:** يستطيع البوت تذكر آخر 3 تبادلات لمدة 10 دقائق.\n` +
    `⚠️ **احتياطي:** إذا فشل نموذج، ينتقل تلقائياً إلى الآخر.`;
  ctx.reply(help, { parse_mode: 'Markdown' });
});

// ── أمر /stats (للمالك فقط) ────────────────────
bot.command('stats', (ctx) => {
  const userId = String(ctx.from.id);
  if (ADMIN_CHAT_ID && userId !== ADMIN_CHAT_ID) {
    return ctx.reply('⛔ هذا الأمر مخصص للمالك فقط.');
  }

  const now = Date.now();
  const uptimeMs = now - stats.lastReset;
  const uptimeMins = Math.floor(uptimeMs / 60000);

  const groqAvg = stats.groq.success > 0 ? (stats.groq.totalTime / stats.groq.success).toFixed(0) : 0;
  const geminiAvg = stats.gemini.success > 0 ? (stats.gemini.totalTime / stats.gemini.success).toFixed(0) : 0;

  const report = `📊 **إحصائيات البوت** (آخر ${uptimeMins} دقيقة)\n\n` +
    `⚡ **Groq:** ${stats.groq.success} نجاح | ${stats.groq.fail} فشل | متوسط ${groqAvg}ms\n` +
    `🧠 **Gemini:** ${stats.gemini.success} نجاح | ${stats.gemini.fail} فشل | متوسط ${geminiAvg}ms\n` +
    `🔄 **الذاكرة:** ${sessions.size} مستخدم نشط`;
  ctx.reply(report, { parse_mode: 'Markdown' });
});

// ── استخراج السؤال بعد الأمر ──────────────────
function extractQuestion(text, command) {
  if (text.startsWith(command + ' ')) {
    return text.slice(command.length + 1).trim();
  }
  if (text.startsWith(command)) {
    return text.slice(command.length).trim();
  }
  return '';
}

// ── معالج الرسائل الأساسي ─────────────────────
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const userId = ctx.from.id;

  if (!text.startsWith('/gemini') && !text.startsWith('/groq')) return;

  const isGemini = text.startsWith('/gemini');
  const command = isGemini ? '/gemini' : '/groq';
  const question = extractQuestion(text, command);

  if (!question) {
    return ctx.reply(`❓ اكتب سؤالك بعد ${command}\nمثال: ${command} ما هو الذكاء الاصطناعي؟`);
  }

  const session = getSession(userId);
  const systemMessage = { role: 'system', content: 'أنت مساعد خبير، أجب بإجابات واضحة ومنسقة باستخدام Markdown مع إيموجيز خفيفة.' };
  const messages = [systemMessage, ...session.messages, { role: 'user', content: question }];

  const executeRequest = async (modelType, client, modelName) => {
    const start = Date.now();
    try {
      await ctx.sendChatAction('typing');
      const reply = await sendStreamedReply(ctx, modelType, client, modelName, messages);
      addMessageToSession(userId, 'user', question);
      addMessageToSession(userId, 'assistant', reply);
      const duration = Date.now() - start;
      recordStat(modelType, true, duration);
      return true;
    } catch (error) {
      const duration = Date.now() - start;
      recordStat(modelType, false, duration);
      console.error(`خطأ ${modelType}:`, error.message);
      return false;
    }
  };

  if (isGemini) {
    if (!gemini) {
      ctx.reply('⚠️ نموذج Gemini غير مفعل. جاري استخدام Groq بدلاً منه...');
      const success = await executeRequest('groq', groq, 'llama-3.3-70b-versatile');
      if (!success) ctx.reply('❌ فشل كلا النموذجين. حاول لاحقاً.');
      return;
    }

    const success = await executeRequest('gemini', gemini, 'gemini-2.5-flash'); // تم التحديث
    if (!success) {
      ctx.reply('⚠️ تعذر الاتصال بـ Gemini. جاري تحويل طلبك إلى Groq...');
      const groqSuccess = await executeRequest('groq', groq, 'llama-3.3-70b-versatile');
      if (!groqSuccess) ctx.reply('❌ فشل كلا النموذجين. حاول لاحقاً.');
    }
  } else {
    const success = await executeRequest('groq', groq, 'llama-3.3-70b-versatile');
    if (!success) {
      if (gemini) {
        ctx.reply('⚠️ تعذر الاتصال بـ Groq. جاري تحويل طلبك إلى Gemini...');
        const gemSuccess = await executeRequest('gemini', gemini, 'gemini-2.5-flash'); // تم التحديث
        if (!gemSuccess) ctx.reply('❌ فشل كلا النموذجين. حاول لاحقاً.');
      } else {
        ctx.reply('❌ فشل نموذج Groq ولا يوجد نموذج بديل.');
      }
    }
  }
});

// ── خادم Express (للصحة والحارس) ──────────────
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => res.send('Bot is alive'));

app.get('/test-gemini', async (_, res) => {
  if (!gemini) return res.send('Gemini غير مهيأ: لا يوجد GEMINI_API_KEY');
  try {
    const response = await gemini.chat.completions.create({
      model: 'gemini-2.5-flash', // تم التحديث
      messages: [{ role: 'user', content: 'قل مرحباً بالعربية' }],
    });
    res.send(`✅ نجح Gemini: ${response.choices[0].message.content}`);
  } catch (e) {
    res.send(`❌ فشل Gemini: ${e.message}`);
  }
});

app.listen(PORT, () => console.log(`Express يعمل على ${PORT}`));

// ── تشغيل البوت ────────────────────────────────
bot.launch();
console.log('🤖 البوت يعمل بـ Long Polling...');

// ── الحارس المتبادل ────────────────────────────
const GUARD_URL = process.env.GUARD_URL;
if (GUARD_URL) {
  const ping = () => {
    fetch(GUARD_URL)
      .then(res => console.log(`Pinged guard: ${res.status}`))
      .catch(err => console.error('Guard unreachable:', err.message));
  };
  setInterval(ping, 30000);
  ping();
}

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
