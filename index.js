require('dotenv').config();
const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const express = require('express');

// إعداد عميل Groq
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

const bot = new Telegraf(process.env.BOT_TOKEN);

// معالج الرسائل
bot.on('text', async (ctx) => {
  const userMessage = ctx.message.text;
  await ctx.sendChatAction('typing');
  try {
    const chatCompletion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',   // نموذج مجاني وسريع ومضمون
      messages: [
        { role: 'system', content: 'أنت مساعد ذكي ومختصر.' },
        { role: 'user', content: userMessage },
      ],
      stream: false,
    });
    const reply = chatCompletion.choices[0]?.message?.content || 'لم أستطع الإجابة.';
    ctx.reply(reply);
  } catch (error) {
    console.error('خطأ Groq:', error.message);
    ctx.reply('عذراً، حدث خطأ. تأكد من المفتاح والإنترنت.');
  }
});

// إعداد Express + Webhook
const app = express();
const PORT = process.env.PORT || 3000;

async function setupWebhook() {
  const webhookDomain = process.env.RENDER_EXTERNAL_URL;
  if (!webhookDomain) {
    // للتشغيل المحلي
    console.log('تشغيل محلي بـ long polling...');
    await bot.launch();
    return;
  }
  // للنشر على Render
  await bot.createWebhook({ domain: webhookDomain });
  app.use(bot.webhookCallback('/telegram-webhook'));
  console.log(`Webhook مضبوط على: ${webhookDomain}/telegram-webhook`);
}

app.get('/', (req, res) => res.send('Bot is running'));

app.listen(PORT, async () => {
  console.log(`Express يستمع على المنفذ ${PORT}`);
  await setupWebhook();
});
