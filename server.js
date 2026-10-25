const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(express.json());
app.use(cors());

const TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://dimitriychr.github.io/baby-tracker/';
const FIREBASE_URL = process.env.FIREBASE_URL; // Опционально для вечного бэкапа

const bot = new TelegramBot(TOKEN, { polling: true });

const databases = {};
const chatToFamily = {};
const subscribedChats = new Set();

function pad2(n) {
  return String(n).padStart(2, '0');
}

// Формат времени ЧЧ:ММ (как в index.html)
function getNowTime() {
  const msk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  return pad2(msk.getHours()) + ':' + pad2(msk.getMinutes());
}

// Формат даты ДД.ММ.ГГГГ (строго как formatDateKey в index.html)
function getTodayStr() {
  const msk = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Moscow' }));
  return pad2(msk.getDate()) + '.' + pad2(msk.getMonth() + 1) + '.' + msk.getFullYear();
}

// === ОБЛАЧНЫЙ БЭКАП ===
async function loadFromCloud() {
  if (!FIREBASE_URL) return;
  try {
    const res = await fetch(`${FIREBASE_URL}/backup.json`);
    const data = await res.json();
    if (data) {
      if (data.databases) Object.assign(databases, data.databases);
      if (data.chatToFamily) Object.assign(chatToFamily, data.chatToFamily);
      if (data.subscribedChats) data.subscribedChats.forEach(id => subscribedChats.add(id));
      console.log('☁️ Данные восстановлены из облака!');
    }
  } catch (err) {
    console.error('Ошибка загрузки из облака:', err.message);
  }
}

async function saveToCloud() {
  if (!FIREBASE_URL) return;
  try {
    await fetch(`${FIREBASE_URL}/backup.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        databases,
        chatToFamily,
        subscribedChats: Array.from(subscribedChats)
      })
    });
  } catch (err) {
    console.error('Ошибка сохранения в облако:', err.message);
  }
}

// Умное слияние списков (строго по формату index.html: id, ts, editedAt)
function mergeLists(serverArr = [], clientArr = [], deletedIds = []) {
  const delSet = new Set(deletedIds.map(String));
  const map = new Map();

  [...serverArr, ...clientArr].forEach(item => {
    if (item && item.id && !delSet.has(String(item.id))) {
      const key = String(item.id);
      const existing = map.get(key);
      if (!existing || (item.editedAt || 0) >= (existing.editedAt || 0)) {
        map.set(key, item);
      }
    }
  });

  return Array.from(map.values())
    .sort((a, b) => (b.ts || b.id || 0) - (a.ts || a.id || 0))
    .slice(0, 150);
}

// Ищем базу семьи (синхронно с логикой index.html: fam_ + user.id)
function getFamilyDb(chatId) {
  subscribedChats.add(chatId);
  let familyId = chatToFamily[chatId];

  if (!familyId) {
    const defaultUserFam = 'fam_' + chatId;
    const existingFamilies = Object.keys(databases);

    if (databases[defaultUserFam]) {
      familyId = defaultUserFam;
    } else if (existingFamilies.length > 0) {
      // Если в базе уже есть активная комната семьи, подключаемся к ней
      familyId = existingFamilies[0];
    } else {
      // Иначе создаем стандартную комнату fam_<chatId>, которую ждет index.html
      familyId = defaultUserFam;
    }
    chatToFamily[chatId] = familyId;
  }

  if (!databases[familyId]) {
    databases[familyId] = { familyId };
  }

  const db = databases[familyId];
  if (!Array.isArray(db.feeds)) db.feeds = [];
  if (!Array.isArray(db.diapers)) db.diapers = [];
  if (!Array.isArray(db.sleeps)) db.sleeps = [];
  if (!Array.isArray(db.deletedIds)) db.deletedIds = [];
  if (typeof db.notificationsEnabled === 'undefined') db.notificationsEnabled = true;

  return { db, familyId };
}

// Нижняя клавиатура
const quickKeyboard = {
  reply_markup: {
    keyboard: [
      [{ text: '🍼 Открыть трекер', web_app: { url: WEB_APP_URL } }],
      [{ text: '🍼 Поел' }, { text: '😴 Сон (Старт/Стоп)' }],
      [{ text: '💧 Пописал' }, { text: '💩 Покакал' }, { text: '📊 Сводка' }],
      [{ text: '↩️ Отменить кормление' }, { text: '🔔 Уведомления Вкл/Выкл' }]
    ],
    resize_keyboard: true,
    is_persistent: true
  }
};

// Команда /start (можно также написать /start КОД_КОМНАТЫ, если используете общий код с женой)
bot.onText(/\/start(?:\s+(.+))?/, (msg, match) => {
  const chatId = msg.chat.id;
  const userName = msg.from.first_name || 'Родитель';
  const passedFamilyId = match[1] ? match[1].trim() : null;

  subscribedChats.add(chatId);

  if (passedFamilyId) {
    chatToFamily[chatId] = passedFamilyId;
    if (!databases[passedFamilyId]) databases[passedFamilyId] = { familyId: passedFamilyId };
  }

  const { familyId } = getFamilyDb(chatId);
  saveToCloud();

  bot.sendMessage(
    chatId,
    `Привет, ${userName}! 🍼\n\nКомната синхронизации: \`${familyId}\`\n_(Если у вас с женой в приложении вписан другой код комнаты, просто отправь мне команду: \`/start ВАШ_КОД\`)_`,
    { parse_mode: 'Markdown', ...quickKeyboard }
  );
});

// Обработка нажатий на кнопки
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userName = msg.from.first_name || 'Родитель';

  if (!text || text.startsWith('/')) return;

  const { db, familyId } = getFamilyDb(chatId);
  const time = getNowTime();
  const nowMs = Date.now();
  const todayStr = getTodayStr();

  // 1. КНОПКА: ПОЕЛ (пишем прямо в массив feeds, как ждет index.html!)
  if (text === '🍼 Поел') {
    const lastMl = db.feeds.length > 0 ? (Number(db.feeds[0].ml) || 90) : 90;

    const newFeed = {
      id: nowMs,
      ts: nowMs,
      editedAt: nowMs,
      date: todayStr,
      time: time,
      ml: lastMl,
      type: 'Смесь',
      by: userName,
      tags: []
    };

    db.feeds.unshift(newFeed);
    db.updatedAt = nowMs;
    db.lastFeedingTime = nowMs;
    db.feedingAlertSent = false;
    saveToCloud();

    bot.sendMessage(
      chatId,
      `✅ *Кормление записано в приложение!*\n🕒 Время: *${time}*\n🍼 Объём: *${lastMl} мл* (Смесь)\n👤 Кто: ${userName}\n\n🔔 _Через 3 часа напомню про следующее кормление и капли от коликов!_`,
      { parse_mode: 'Markdown', ...quickKeyboard }
    );
  }

  // 2. КНОПКА: ОТМЕНИТЬ ПОСЛЕДНЕЕ КОРМЛЕНИЕ
  else if (text === '↩️ Отменить кормление') {
    if (db.feeds.length === 0) {
      bot.sendMessage(chatId, '🤷‍♂️ В списке пока нет записей кормлений для удаления.', quickKeyboard);
      return;
    }

    const removed = db.feeds.shift();
    db.deletedIds.push(String(removed.id));
    db.updatedAt = nowMs;
    db.lastFeedingTime = db.feeds[0] ? (db.feeds[0].ts || db.feeds[0].id) : null;
    db.feedingAlertSent = false;
    saveToCloud();

    bot.sendMessage(
      chatId,
      `🗑 *Удалено последнее кормление:* за *${removed.time}* (${removed.ml} мл).\n` +
      (db.feeds[0] ? `Крайнее кормление теперь в *${db.feeds[0].time}*.` : `Список кормлений пуст.`),
      { parse_mode: 'Markdown', ...quickKeyboard }
    );
  }

  // 3. КНОПКИ: ПОДГУЗНИКИ (названия строго под счетчики в index.html: '💧 Попис' и '💩 Покак')
  else if (text === '💧 Пописал' || text === '💩 Покакал') {
    const diaperType = text === '💩 Покакал' ? '💩 Покак' : '💧 Попис';

    db.diapers.unshift({
      id: nowMs,
      ts: nowMs,
      editedAt: nowMs,
      date: todayStr,
      time: time,
      type: diaperType,
      by: userName
    });
    db.updatedAt = nowMs;
    saveToCloud();

    bot.sendMessage(
      chatId,
      `✅ *Подгузник отмечен в дневнике:* ${diaperType} в *${time}*`,
      { parse_mode: 'Markdown', ...quickKeyboard }
    );
  }

  // 4. КНОПКА: СОН (СТАРТ / СТОП)
  else if (text === '😴 Сон (Старт/Стоп)') {
    if (!db.activeSleepStart) {
      db.activeSleepStart = nowMs;
      db.activeSleepTimeStr = time;
      saveToCloud();

      bot.sendMessage(
        chatId,
        `🌙 *Малышка уснула в ${time}*\nТаймер сна запущен. Когда проснется — нажми кнопку еще раз!`,
        { parse_mode: 'Markdown', ...quickKeyboard }
      );
    } else {
      const durationMinutes = Math.max(1, Math.round((nowMs - db.activeSleepStart) / 60000));
      const hours = Math.floor(durationMinutes / 60);
      const mins = durationMinutes % 60;
      const durationStr = hours > 0 ? `${hours} ч ${mins} мин` : `${mins} мин`;
      const startedAt = db.activeSleepTimeStr;

      db.sleeps.unshift({
        id: nowMs,
        startTime: startedAt,
        endTime: time,
        date: todayStr,
        durationMinutes: durationMinutes,
        durationText: durationStr,
        ts: nowMs
      });

      db.activeSleepStart = null;
      db.activeSleepTimeStr = null;
      saveToCloud();

      bot.sendMessage(
        chatId,
        `☀️ *Малышка проснулась в ${time}!*\n🛌 Проспала: *${durationStr}* (с ${startedAt} до ${time})`,
        { parse_mode: 'Markdown', ...quickKeyboard }
      );
    }
  }

  // 5. КНОПКА: СВОДКА
  else if (text === '📊 Сводка') {
    const todayFeeds = db.feeds.filter(f => f.date === todayStr);
    const totalMl = todayFeeds.reduce((s, f) => s + (Number(f.ml) || 0), 0);
    const todayDiapers = db.diapers.filter(d => d.date === todayStr);

    const lastFeed = db.feeds[0] ? `${db.feeds[0].time} (${db.feeds[0].ml} мл)` : 'нет записей';
    const lastDiaper = db.diapers[0] ? `${db.diapers[0].time} (${db.diapers[0].type})` : 'нет записей';
    const sleepStatus = db.activeSleepStart
      ? `😴 Сейчас спит (уснула в ${db.activeSleepTimeStr})`
      : (db.sleeps[0] ? `Проснулась в ${db.sleeps[0].endTime} (спала ${db.sleeps[0].durationText})` : 'нет записей');

    const summaryText =
      `📊 *Сводка за сегодня (${todayStr}):*\n` +
      `🔗 Комната: \`${familyId}\`\n\n` +
      `🍼 *Съедено за сегодня:* ${totalMl} мл (${todayFeeds.length} кормл.)\n` +
      `🕒 *Последнее кормление:* ${lastFeed}\n` +
      `🧷 *Подгузники за сегодня:* ${todayDiapers.length} шт. (посл: ${lastDiaper})\n` +
      `🛌 *Сон:* ${sleepStatus}\n` +
      `🔔 *Уведомления:* ${db.notificationsEnabled ? 'Включены ✅' : 'Выключены 🔕'}`;

    bot.sendMessage(chatId, summaryText, { parse_mode: 'Markdown', ...quickKeyboard });
  }

  // 6. КНОПКА: ВКЛ/ВЫКЛ УВЕДОМЛЕНИЙ
  else if (text === '🔔 Уведомления Вкл/Выкл') {
    db.notificationsEnabled = !db.notificationsEnabled;
    saveToCloud();

    const statusText = db.notificationsEnabled
      ? '🔔 *Уведомления включены!* Ровно через 3 часа после еды напомню о следующем кормлении и каплях от коликов.'
      : '🔕 *Уведомления выключены.* Не буду беспокоить пушами, пока не включишь обратно.';

    bot.sendMessage(chatId, statusText, { parse_mode: 'Markdown', ...quickKeyboard });
  }
});

// === ФОНОВЫЙ ТАЙМЕР КОНТРОЛЯ КОРМЛЕНИЯ (ровно 3 часа = 180 минут) ===
setInterval(() => {
  const nowMs = Date.now();

  subscribedChats.forEach((chatId) => {
    const { db } = getFamilyDb(chatId);
    if (!db.notificationsEnabled) return;

    const lastFeedMs = db.lastFeedingTime || (db.feeds[0] && (db.feeds[0].ts || db.feeds[0].id));
    if (lastFeedMs && !db.feedingAlertSent && !db.activeSleepStart) {
      const minutesPassed = Math.floor((nowMs - lastFeedMs) / 60000);
      if (minutesPassed >= 180 && minutesPassed < 360) {
        db.feedingAlertSent = true;
        saveToCloud();

        const hours = Math.floor(minutesPassed / 60);
        const mins = minutesPassed % 60;
        const timePassedStr = mins > 0 ? `${hours} ч ${mins} мин` : `${hours} ч`;

        bot.sendMessage(
          chatId,
          `🍼 *Пора готовить смесь!* С последнего кормления прошло *${timePassedStr}*.\n\n💧 **Не забудь добавить капли от коликов в смесь!**\n\n_(Когда покормишь, нажми кнопку «🍼 Поел» внизу)_`,
          { parse_mode: 'Markdown', ...quickKeyboard }
        );
      }
    }
  });
}, 60 * 1000);

// === API ДЛЯ ПИНГА И MINI APP ===

app.get('/ping', (req, res) => {
  res.send('Alive!');
});

app.get('/api/get/:familyId', (req, res) => {
  const { familyId } = req.params;
  res.json(databases[familyId] || null);
});

app.post('/api/save/:familyId', (req, res) => {
  const { familyId } = req.params;
  const currentDb = databases[familyId] || {};
  const incoming = req.body || {};

  const deletedIds = Array.from(new Set([
    ...(currentDb.deletedIds || []),
    ...(incoming.deletedIds || [])
  ])).slice(-200);

  const mergedFeeds = mergeLists(currentDb.feeds, incoming.feeds, deletedIds);
  const mergedDiapers = mergeLists(currentDb.diapers, incoming.diapers, deletedIds);

  const newestFeedMs = mergedFeeds[0] ? (mergedFeeds[0].ts || mergedFeeds[0].id) : null;
  const isNewFeedAdded = newestFeedMs && newestFeedMs !== currentDb.lastFeedingTime;

  databases[familyId] = {
    ...currentDb,
    ...incoming,
    familyId,
    updatedAt: Math.max(currentDb.updatedAt || 0, incoming.updatedAt || 0, Date.now()),
    deletedIds,
    feeds: mergedFeeds,
    diapers: mergedDiapers,
    lastFeedingTime: newestFeedMs,
    feedingAlertSent: isNewFeedAdded ? false : currentDb.feedingAlertSent
  };

  saveToCloud();
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  await loadFromCloud();
  console.log(`Бот и сервер успешно запущены на порту ${PORT}`);
});
