const express = require('express');
const cors = require('cors');
const app = express();

app.use(express.json());
app.use(cors());

// Здесь сервер временно держит базу данных в памяти
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
  console.log(`Сервер запущен!`);
});
