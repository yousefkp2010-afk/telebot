require('dotenv').config();
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const express = require('express');

// ── عميل Groq ──
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ── بوت تيليغرام ──
const bot = new Telegraf(process.env.BOT_TOKEN);

// الرد فقط على الرسائل التي تبدأ بـ "/ai"
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();

  // تجاهل أي رسالة لا تبدأ بـ "/ai"
  if (!text.startsWith('/ai')) return;

  // استخراج السؤال بعد "/ai" مع تجاهل الفراغات الزائدة
  const question = text.slice(3).trim();
  if (!question) {
    return ctx.reply('اكتب سؤالك بعد /ai مثال: /ai ما هو الذكاء الاصطناعي؟');
  }

  await ctx.sendChatAction('typing');

  try {
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: 'أنت مساعد ذكي ومختصر.' },
        { role: 'user', content: question },
      ],
      stream: false,
    });

    const reply = completion.choices[0]?.message?.content || 'لم أستطع الإجابة.';
    ctx.reply(reply);
  } catch (error) {
    console.error('خطأ Groq:', error.message);
    ctx.reply('عذراً، حدث خطأ داخلي. حاول مرة أخرى لاحقاً.');
  }
});

// ── خادم Express لاستقبال pings (يمنع النوم) ──
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Bot is alive'));

app.listen(PORT, () => {
  console.log(`Express يستمع على المنفذ ${PORT}`);
});

// ── تشغيل البوت (Long Polling) ──
bot.launch();
console.log('البوت يعمل بـ Long Polling...');

// ── إرسال ping إلى الحارس كل 30 ثانية (إن وُجد) ──
const GUARD_URL = process.env.GUARD_URL;
if (GUARD_URL) {
  const ping = () => {
    fetch(GUARD_URL)
      .then((res) => console.log(`Pinged guard: ${res.status}`))
      .catch((err) => console.error('Guard ping failed:', err.message));
  };
  setInterval(ping, 30000);
  ping(); // ابدأ فوراً
}

// ── إيقاف آمن عند إغلاق الخدمة ──
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
