const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(cors());

// Вставь сюда токен, который тебе дал @BotFather
const TOKEN = process.env.TELEGRAM_TOKEN || 'ТВОЙ_ТОКЕН_БОТА_ОТ_BOTFATHER';
// Вставь сюда ссылку на свой сайт с GitHub Pages
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://ТВОЙ-АККАУНТ.github.io/ТВОЙ-РЕПОЗИТОРИЙ/';

// Инициализируем бота (polling — режим постоянного опроса)
const bot = new TelegramBot(TOKEN, { polling: true });

// Когда пользователь пишет /start боту
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Родитель';

  bot.sendMessage(chatId, `Привет, ${userName}! 🍼 Добро пожаловать в трекер кормлений и ухода за малышкой. Нажми на кнопку ниже, чтобы открыть приложение:`, {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🍼 Открыть трекер',
            web_app: { url: WEB_APP_URL }
          }
        ]
      ]
    }
  });
});

// Хранилище базы данных в памяти сервера
const databases = {}; 

app.get('/api/get/:familyId', (req, res) => {
  const { familyId } = req.params;
  res.json(databases[familyId] || null);
});

app.post('/api/save/:familyId', (req, res) => {
  const { familyId } = req.params;
  databases[familyId] = req.body;
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Бот и сервер успешно запущены на порту ${PORT}`);
});
