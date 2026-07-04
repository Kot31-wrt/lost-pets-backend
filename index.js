import 'dotenv/config'; // правильный импорт dotenv для поддержки es-модулей
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import axios from 'axios'; 

const Pet = require('./models/Pet');
const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'SUPER_SECRET_KEY_123'; // секретный ключ для подписи токенов

app.use(cors({
    origin: 'https://lost-pets-map.vercel.app'
}));
app.use(express.json({ limit: '10mb' })); 

// подключение к mongodb через переменную среды из файла .env
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('база данных успешно подключена'))
  .catch(err => console.error('ошибка подключения к базе:', err));

// 1. схема пользователя
const userSchema = new mongoose.Schema({
  name: { type: String, required: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  phone: { type: String, default: '' },
  isPhoneVerified: { type: Boolean, default: false },
  whatsapp: { type: String, default: '' },
  telegram: { type: String, default: '' },
  bio: { type: String, default: '' },
  avatar: { type: String, default: '' }
});

const User = mongoose.model('User', userSchema);

// 2. схема временных смс-кодов
const smsCodeSchema = new mongoose.Schema({
  phone: { type: String, required: true },
  code: { type: String, required: true },
  purpose: { type: String, required: true }, // 'verify_phone' или 'reset_password'
  createdAt: { type: Date, default: Date.now, expires: 300 } // удалится само через 5 минут
});

const SmsCode = mongoose.model('SmsCode', smsCodeSchema);

// 3. схема объявления питомца
const petSchema = new mongoose.Schema({
  status: { type: String, required: true }, // потерялся / найден
  name: { type: String, required: true },
  breed: { type: String, required: true },
  description: { type: String, required: true },
  image: { type: String, default: '' },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true } // ссылка на владельца
}, { timestamps: true });

const Pet = mongoose.model('Pet', petSchema);


// ================= МАРШРУТЫ АВТОРИЗАЦИИ =================

// Регистрация нового пользователя
app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    
    const candidate = await User.findOne({ email });
    if (candidate) {
      return res.status(400).json({ success: false, message: 'пользователь с таким email уже существует' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({ name, email, password: hashedPassword });
    await user.save();

    res.status(201).json({ success: true, message: 'пользователь успешно зарегистрирован!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'ошибка при регистрации' });
  }
});

// Вход в аккаунт
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ success: false, message: 'неверный email или password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'неверный email или password' });
    }

    const token = jwt.sign(
      { userId: user._id, name: user.name, email: user.email },
      JWT_SECRET,
      { expiresIn: '1h' }
    );

    res.json({ 
      success: true, 
      token, 
      user: { 
        id: user._id, 
        name: user.name, 
        email: user.email,
        phone: user.phone,
        isPhoneVerified: user.isPhoneVerified,
        whatsapp: user.whatsapp,
        telegram: user.telegram,
        bio: user.bio,
        avatar: user.avatar
      } 
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'ошибка при входе' });
  }
});


// ================= МАРШРУТЫ ПРОФИЛЯ И СМС =================

// 1. Запрос смс-кода для подтверждения телефона в личном кабинете
app.post('/api/users/send-phone-code', async (req, res) => {
  try {
    const { phone, userId } = req.body;

    if (!phone || !userId) {
      return res.status(400).json({ success: false, message: 'Номер телефона и ID пользователя обязательны' });
    }

    // 1. Генерируем случайный 4-значный код
    const code = Math.floor(1000 + Math.random() * 9000).toString();

    // 2. Сохраняем код в базу данных (с указанием назначения verify_phone)
    // Удаляем старые коды для этого номера, чтобы не копить мусор
    await SmsCode.deleteMany({ phone, purpose: 'verify_phone' });
    
    const smsDoc = new SmsCode({
      phone,
      code,
      purpose: 'verify_phone',
      createdAt: new Date() // Убедись, что в схеме настроен TTL (время жизни) кодов
    });
    await smsDoc.save();

    // 3. Форматируем номер телефона (SMS.ru просит чистые цифры без плюсов, например: 79991112233)
    const cleanPhone = phone.replace(/\D/g, '');

    // Твой API-ключ от SMS.ru (замени на свой реальный из личного кабинета)
    const SMS_RU_API_ID = process.env.SMS_RU_API_ID; 
    
    const smsMessage = encodeURIComponent(`Код подтверждения профиля: ${code}`);
    const smsUrl = `https://sms.ru/sms/send?api_id=${SMS_RU_API_ID}&to=${cleanPhone}&msg=${smsMessage}&json=1`;

    // 4. Делаем физический запрос к SMS-шлюзу
    const smsResponse = await fetch(smsUrl);
    const smsData = await smsResponse.json();

    // Проверяем статус ответа от SMS.ru
    if (smsData.status === "OK" && smsData.sms[cleanPhone] && smsData.sms[cleanPhone].status === "OK") {
      console.log(`SMS успешно отправлено на номер ${cleanPhone}. Код: ${code}`);
      return res.json({ success: true, message: 'Код подтверждения успешно отправлен в SMS' });
    } else {
      console.error('Ошибка ответа от SMS.ru:', smsData);
      return res.status(500).json({ 
        success: false, 
        message: 'SMS-шлюз отклонил отправку. Проверьте баланс или корректность номера телефона' 
      });
    }

  } catch (error) {
    console.error('Ошибка при отправке SMS:', error);
    res.status(500).json({ success: false, message: 'Внутренняя ошибка сервера при отправке SMS' });
  }
});

// 2. Обновление профиля (совместимый с фронтендом PUT маршрут)
app.put('/api/users/profile/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const { name, phone, whatsapp, telegram, bio, avatar } = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'пользователь не найден' });
    }

    // Независимая обработка номера телефона
    if (phone !== undefined && phone !== user.phone) {
      user.phone = phone;
      user.isPhoneVerified = false; 
    }

    // Независимое сохранение остальных полей
    if (name !== undefined) user.name = name;
    if (whatsapp !== undefined) user.whatsapp = whatsapp;
    if (telegram !== undefined) user.telegram = telegram;
    if (bio !== undefined) user.bio = bio;
    if (avatar !== undefined) user.avatar = avatar; // Сохраняем строку Base64 напрямую в базу

    await user.save();

    res.json({ 
      success: true, 
      message: 'профиль успешно обновлен', 
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        isPhoneVerified: user.isPhoneVerified,
        whatsapp: user.whatsapp,
        telegram: user.telegram,
        bio: user.bio,
        avatar: user.avatar
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'ошибка при обновлении профиля' });
  }
});

// Маршрут для редактирования питомца
app.put('/api/pets/:id', async (req, res) => {
  try {
    const { id } = req.params;
    // Данные приходят из вашего fetch (body: JSON.stringify(payload))
    const { name, breed, description, status, image, lat, lng } = req.body;

    // Ищем и обновляем
    const updatedPet = await Pet.findByIdAndUpdate(
      id, 
      { name, breed, description, status, image, lat, lng },
      { new: true } // Эта опция возвращает уже обновленный объект
    );

    if (!updatedPet) {
      return res.status(404).json({ success: false, message: 'Питомец не найден' });
    }

    res.json({ success: true, data: updatedPet });
  } catch (error) {
    console.error("Ошибка при обновлении питомца:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// НОВЫЙ МАРШРУТ: ОТДЕЛЬНАЯ ПРОВЕРКА СМС ДЛЯ ПОДТВЕРЖДЕНИЯ НОМЕРА
app.post('/api/users/verify-phone-code', async (req, res) => {
  try {
    const { userId, phone, code } = req.body;

    if (!phone || !code || !userId) {
      return res.status(400).json({ success: false, message: 'Все поля обязательны для верификации' });
    }

    const validCode = await SmsCode.findOne({ phone, code, purpose: 'verify_phone' });
    if (!validCode) {
      return res.status(400).json({ success: false, message: 'Неверный или просроченный код подтверждения' });
    }

    // Если код верный, находим пользователя и подтверждаем ему номер
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'Пользователь не найден' });
    }

    user.phone = phone;
    user.isPhoneVerified = true;
    await user.save();

    // Удаляем использованный код
    await SmsCode.deleteOne({ _id: validCode._id });

    res.json({
      success: true,
      message: 'Номер телефона успешно подтвержден!',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        isPhoneVerified: user.isPhoneVerified,
        whatsapp: user.whatsapp,
        telegram: user.telegram,
        bio: user.bio,
        avatar: user.avatar
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'Ошибка сервера при верификации' });
  }
});

// 4. установка нового пароля по смс-коду
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { phone, code, newPassword } = req.body;

    const validCode = await SmsCode.findOne({ phone, code, purpose: 'reset_password' });
    if (!validCode) {
      return res.status(400).json({ success: false, message: 'неверный или просроченный код сброса' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await User.findOneAndUpdate({ phone }, { password: hashedPassword });
    await SmsCode.deleteOne({ _id: validCode._id });

    res.json({ success: true, message: 'пароль успешно изменен, теперь вы можете войти в аккаунт' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: 'ошибка при сбросе пароля' });
  }
});


// ================= МАРШРУТЫ ОБЪЯВЛЕНИЙ =================

app.get('/api/pets', async (req, res) => {
  try {
    const pets = await Pet.find().sort({ createdAt: -1 });
    res.json(pets);
  } catch (error) {
    res.status(500).json({ success: false, message: 'ошибка загрузки данных' });
  }
});

app.post('/api/pets', async (req, res) => {
  try {
    const newPet = new Pet(req.body);
    await newPet.save();
    res.status(201).json({ success: true, message: 'объявление сохранено!' });
  } catch (error) {
    res.status(400).json({ success: false, message: 'ошибка сохранения' });
  }
});

app.get('/api/pets/user/:userId', async (req, res) => {
  try {
    const userPets = await Pet.find({ userId: req.params.userId }).sort({ createdAt: -1 });
    res.json(userPets);
  } catch (error) {
    res.status(500).json({ success: false, message: 'ошибка получения объявлений' });
  }
});

app.delete('/api/pets/:id', async (req, res) => {
  try {
    await Pet.findByIdAndDelete(req.params.id);
    res.json({ success: true, message: 'удалено!' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'ошибка удаления' });
  }
});

// Получение публичной карточки пользователя со всеми его соцсетями и объявлениями
app.get('/api/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'пользователь не найден' });
    }

    const ads = await Pet.find({ userId: req.params.id }).sort({ createdAt: -1 });

    res.json({ success: true, user, ads });
  } catch (error) {
    console.error('ошибка при получении профиля:', error);
    res.status(500).json({ success: false, message: 'ошибка сервера' });
  }
});

app.listen(PORT, () => {
  console.log(`бэкенд с авторизацией и смс запущен на http://localhost:${PORT}`);
});