import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = 'SUPER_SECRET_KEY_123'; // Секретный ключ для подписи токенов

app.use(cors());
app.use(express.json({ limit: '10mb' })); 

// 🔗 ПОДКЛЮЧЕНИЕ К MONGODB
const MONGO_URI = 'mongodb+srv://W1NT3R:KotandW1NT3R@cluster0.flimn3e.mongodb.net/lost_pets?retryWrites=true&w=majority&appName=Cluster0';

mongoose.connect(MONGO_URI)
  .then(() => console.log('🍃 Успешное подключение к MongoDB Atlas!'))
  .catch(err => console.error('❌ Ошибка подключения к БД:', err));

// 📐 1. СХЕМА ПОЛЬЗОВАТЕЛЯ
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  avatar: { type: String, default: '' }, // Ссылка на фото профиля (base64 или URL)
  phone: { type: String, default: '' },
  whatsapp: { type: String, default: '' },
  telegram: { type: String, default: '' },
  bio: { type: String, default: '' } // Пару слов о себе
}, { timestamps: true });

const User = mongoose.model('User', userSchema);

// 📐 2. СХЕМА ОБЪЯВЛЕНИЯ ПИТОМЦА
const petSchema = new mongoose.Schema({
  status: { type: String, required: true }, // потерялся / найден
  name: { type: String, required: true },
  breed: { type: String, required: true },
  description: { type: String, required: true },
  image: { type: String, default: '' },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true } // Ссылка на владельца!
}, { timestamps: true });

const Pet = mongoose.model('Pet', petSchema);


// 🛰️ МАРШРУТЫ АВТОРИЗАЦИИ

// Регистрация нового пользователя
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    // Проверяем, есть ли уже такой email в базе
    const candidate = await User.findOne({ email });
    if (candidate) {
      return res.status(400).json({ success: false, message: 'Пользователь с таким Email уже существует' });
    }

    // Хешируем (шифруем) пароль
    const hashedPassword = await bcrypt.hash(password, 10);

    // Сохраняем в MongoDB
    const user = new User({ name, email, password: hashedPassword });
    await user.save();

    res.status(201).json({ success: true, message: 'Пользователь успешно зарегистрирован!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка при регистрации' });
  }
});

// Вход в аккаунт
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Ищем пользователя по email
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ success: false, message: 'Неверный email или password' });
    }

    // Проверяем пароль
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Неверный email или password' });
    }

    // Создаем JWT токен (действует 1 час)
    const token = jwt.sign(
      { userId: user._id, name: user.name, email: user.email },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({ success: true, token, user: { id: user._id, name: user.name, email: user.email } });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка при входе' });
  }
});


// 🛰️ МАРШРУТЫ ОБЪЯВЛЕНИЙ

app.get('/api/pets', async (req, res) => {
  try {
    const pets = await Pet.find().sort({ createdAt: -1 });
    res.json(pets);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка загрузки данных' });
  }
});

app.post('/api/pets', async (req, res) => {
  try {
    const newPet = new Pet(req.body);
    await newPet.save();
    res.status(201).json({ success: true, message: 'Объявление сохранено!' });
  } catch (error) {
    res.status(400).json({ success: false, message: 'Ошибка сохранения' });
  }
});

app.get('/api/pets/user/:userId', async (req, res) => {
  try {
    const userPets = await Pet.find({ userId: req.params.userId }).sort({ createdAt: -1 });
    res.json(userPets);
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка получения объявлений' });
  }
});

app.delete('/api/pets/:id', async (req, res) => {
  try {
    await Pet.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'Удалено!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Ошибка удаления' });
  }
});

// Роут для получения публичного профиля любого пользователя и его объявлений
app.get('/api/users/:id', async (req, res) => {
  try {
    // Находим пользователя по ID, исключая пароль из выдачи (.select('-password'))
    const user = await mongoose.model('User').findById(req.params.id).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    }

    // Находим все объявления, которые создал этот пользователь
    const ads = await mongoose.model('Pet').find({ userId: req.params.id }).sort({ createdAt: -1 });

    res.json({ success: true, user, ads });
  } catch (error) {
    console.error('Ошибка при получении профиля:', error);
    res.status(500).json({ success: false, message: 'Ошибка сервера' });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Бэкенд с авторизацией запущен на http://localhost:${PORT}`);
});