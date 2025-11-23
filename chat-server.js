const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// MongoDB connection
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
    console.error('⚠️  WARNING: MONGODB_URI environment variable is not set!');
    console.error('⚠️  Server will run without persistent storage.');
}
const DB_NAME = 'wave-chat';
let db = null;
let mongoClient = null;

// Путь к файлу для сохранения данных (только для локальной разработки)
const DATA_FILE = path.join(__dirname, 'chat-data.json');

// In-memory storage (for production, use a database like MongoDB or PostgreSQL)
const users = new Map(); // socketId -> { id, nickname, socketId, avatarHue, joinedAt, isAdmin, ip }
const userSessions = new Map(); // userId -> Set of socketIds (для отслеживания всех сессий пользователя)
const registeredUsers = new Map(); // Permanent storage: userId -> { id, nickname, avatarHue, isAdmin, ip, sessionToken }
const sessionTokens = new Map(); // sessionToken -> userId (для быстрого поиска)
const messages = []; // Array of messages
const bannedUsers = new Set(); // Set of banned userIds
const bannedNicknames = new Set(); // Set of permanently banned nicknames (lowercase)
const bannedIPs = new Set(); // Set of permanently banned IP addresses
const bannedFingerprints = new Set(); // Set of permanently banned browser fingerprints
const userFingerprints = new Map(); // userId -> fingerprint mapping
const userLastMessages = new Map(); // userId -> последнее сообщение для проверки дубликатов
let adminId = null; // First user with nickname 'mefisto' becomes admin
const MESSAGE_RETENTION_TIME = 24 * 60 * 60 * 1000; // 24 hours

// Функция для получения IP адреса клиента
function getClientIP(socket) {
    // Проверяем заголовки для случаев когда используется прокси/CDN
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    
    const realIP = socket.handshake.headers['x-real-ip'];
    if (realIP) {
        return realIP;
    }
    
    // Fallback на прямой IP
    return socket.handshake.address;
}

// Генерация secure session token
function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Генерация Device Code (формат: AA1B)
function generateDeviceCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Проверка что device code уникальный
function generateUniqueDeviceCode() {
    let code;
    let attempts = 0;
    do {
        code = generateDeviceCode();
        attempts++;
        if (attempts > 100) {
            // Если за 100 попыток не нашли уникальный - используем более длинный код
            code = generateDeviceCode() + generateDeviceCode().substring(0, 2);
            break;
        }
    } while (Array.from(registeredUsers.values()).some(user => user.deviceCode === code));
    return code;
}

// Проверка session token
function validateSessionToken(sessionToken) {
    if (!sessionToken || typeof sessionToken !== 'string') {
        return null;
    }
    
    const userId = sessionTokens.get(sessionToken);
    if (!userId || !registeredUsers.has(userId)) {
        return null;
    }
    
    const user = registeredUsers.get(userId);
    
    // Проверяем что токен совпадает
    if (user.sessionToken !== sessionToken) {
        return null;
    }
    
    return user;
}

// Проверка Device Code
function validateDeviceCode(deviceCode) {
    if (!deviceCode || typeof deviceCode !== 'string') {
        return null;
    }
    
    // Ищем пользователя по device code
    for (const [userId, user] of registeredUsers) {
        if (user.deviceCode === deviceCode) {
            return user;
        }
    }
    
    return null;
}

// Подключение к MongoDB
async function connectDB() {
    try {
        mongoClient = new MongoClient(MONGODB_URI);
        await mongoClient.connect();
        db = mongoClient.db(DB_NAME);
        
        // Проверяем подключение
        await db.command({ ping: 1 });
        console.log('✅ Connected to MongoDB Atlas successfully!');
        console.log(`📦 Database: ${DB_NAME}`);
        return true;
    } catch (error) {
        console.error('❌ MongoDB connection error:', error.message);
        console.log('⚠️  Server will continue without persistent storage');
        return false;
    }
}

// Функции для сохранения и загрузки данных
async function saveData() {
    try {
        const data = {
            registeredUsers: Array.from(registeredUsers.entries()),
            sessionTokens: Array.from(sessionTokens.entries()),
            messages: messages.slice(-1000), // Сохраняем последние 1000 сообщений
            bannedUsers: Array.from(bannedUsers),
            bannedNicknames: Array.from(bannedNicknames),
            bannedIPs: Array.from(bannedIPs),
            bannedFingerprints: Array.from(bannedFingerprints),
            userFingerprints: Array.from(userFingerprints.entries()),
            adminId: adminId,
            timestamp: Date.now()
        };
        
        // Сохраняем в MongoDB
        if (db) {
            await db.collection('chatData').updateOne(
                { _id: 'main' },
                { $set: data },
                { upsert: true }
            );
            console.log('💾 Data saved to MongoDB Atlas');
        } else {
            console.warn('⚠️  MongoDB not connected - data will not persist');
        }
    } catch (error) {
        console.error('Error saving data:', error);
    }
}

// Сохранение кеша Wave API данных
async function saveWaveCache(cacheData) {
    try {
        if (db) {
            await db.collection('waveCache').updateOne(
                { _id: 'current' },
                { 
                    $set: {
                        ...cacheData,
                        lastUpdated: Date.now()
                    }
                },
                { upsert: true }
            );
            console.log('💾 Wave cache saved to MongoDB');
        }
    } catch (error) {
        console.error('Error saving Wave cache:', error);
    }
}

// Загрузка кеша Wave API данных
async function loadWaveCache() {
    try {
        if (db) {
            const cache = await db.collection('waveCache').findOne({ _id: 'current' });
            if (cache) {
                console.log('📥 Wave cache loaded from MongoDB');
                return cache;
            }
        }
        return null;
    } catch (error) {
        console.error('Error loading Wave cache:', error);
        return null;
    }
}

async function loadData() {
    try {
        let data = null;
        
        // Загружаем из MongoDB
        if (db) {
            const result = await db.collection('chatData').findOne({ _id: 'main' });
            if (result) {
                data = result;
                console.log('📥 Data loaded from MongoDB Atlas');
            } else {
                console.log('📭 No existing data in MongoDB - starting fresh');
            }
        } else {
            console.warn('⚠️  MongoDB not connected - no data to load');
        }
        
        if (data) {
            // Восстанавливаем зарегистрированных пользователей
            if (data.registeredUsers) {
                data.registeredUsers.forEach(([userId, user]) => {
                    registeredUsers.set(userId, user);
                });
            }
            
            // Восстанавливаем session tokens
            if (data.sessionTokens) {
                data.sessionTokens.forEach(([token, userId]) => {
                    sessionTokens.set(token, userId);
                });
            }
            
            // Восстанавливаем сообщения (только за последние 24 часа)
            if (data.messages) {
                const now = Date.now();
                const cutoff = now - MESSAGE_RETENTION_TIME;
                data.messages.forEach(msg => {
                    if (msg.timestamp > cutoff) {
                        messages.push(msg);
                    }
                });
            }
            
            // Восстанавливаем баны
            if (data.bannedUsers) {
                data.bannedUsers.forEach(userId => bannedUsers.add(userId));
            }
            if (data.bannedNicknames) {
                data.bannedNicknames.forEach(nickname => bannedNicknames.add(nickname));
            }
            if (data.bannedIPs) {
                data.bannedIPs.forEach(ip => bannedIPs.add(ip));
            }
            if (data.bannedFingerprints) {
                data.bannedFingerprints.forEach(fp => bannedFingerprints.add(fp));
            }
            if (data.userFingerprints) {
                data.userFingerprints.forEach(([userId, fp]) => {
                    userFingerprints.set(userId, fp);
                });
            }
            
            // Восстанавливаем админа
            if (data.adminId) {
                adminId = data.adminId;
            }
            
            console.log(`📊 Stats: ${registeredUsers.size} users, ${messages.length} messages, ${bannedIPs.size} banned IPs`);
        }
    } catch (error) {
        console.error('Error loading data:', error);
    }
}

// Инициализация при старте
async function initializeServer() {
    await connectDB();
    await loadData();
}

initializeServer();

// Автосохранение каждые 5 минут
setInterval(() => {
    saveData();
}, 5 * 60 * 1000);

// Логирование статистики каждые 60 секунд
setInterval(() => {
    console.log(`📊 Stats: ${allConnections.size} total connections | ${users.size} registered users | ${messages.length} messages`);
}, 60 * 1000);

// Clean old messages periodically
setInterval(() => {
    const now = Date.now();
    const cutoff = now - MESSAGE_RETENTION_TIME;
    
    let removedCount = 0;
    while (messages.length > 0 && messages[0].timestamp < cutoff) {
        messages.shift();
        removedCount++;
    }
    
    if (removedCount > 0) {
        console.log(`Cleaned ${removedCount} old messages`);
        saveData(); // Сохраняем после очистки
    }
}, 60000); // Check every minute

// Generate random hue for avatar
function generateAvatarHue() {
    return Math.floor(Math.random() * 360);
}

// Check if nickname is available
function isNicknameAvailable(nickname, excludeUserId = null) {
    const lowerNickname = nickname.toLowerCase();
    
    // Проверяем забаненные никнеймы
    if (bannedNicknames.has(lowerNickname)) {
        return false;
    }
    
    // Проверяем зарегистрированных пользователей (постоянное хранилище)
    for (const [userId, user] of registeredUsers) {
        if (userId !== excludeUserId && user.nickname.toLowerCase() === lowerNickname) {
            return false;
        }
    }
    
    return true;
}

// Отслеживание всех подключений к сайту
const allConnections = new Set(); // Все активные socket соединения

io.on('connection', (socket) => {
    const clientIP = getClientIP(socket);
    
    // Добавляем в список всех подключенных
    allConnections.add(socket.id);
    
    console.log(`🔗 New connection: ${socket.id} | IP: ${clientIP} | Transport: ${socket.conn.transport.name} | Total online: ${allConnections.size}`);
    
    // Проверяем не забанен ли IP
    if (bannedIPs.has(clientIP)) {
        console.log('🚫 Banned IP attempted to connect:', clientIP);
        socket.emit('banned');
        socket.disconnect(true);
        allConnections.delete(socket.id); // Сразу удаляем забаненного
        return;
    }
    
    // Store client fingerprint when provided
    socket.on('setFingerprint', (fingerprint) => {
        if (fingerprint && typeof fingerprint === 'string') {
            socket.clientFingerprint = fingerprint;
            console.log('Fingerprint set for socket:', socket.id, 'FP:', fingerprint.substring(0, 16) + '...');
            
            // Check if fingerprint is banned
            if (bannedFingerprints.has(fingerprint)) {
                console.log('🚫 Banned fingerprint attempted to connect:', fingerprint.substring(0, 16) + '...');
                socket.emit('banned');
                socket.disconnect(true);
                allConnections.delete(socket.id);
            }
        }
    });
    
    // Send current online count (всех на сайте)
    io.emit('onlineCount', allConnections.size);
    
    // Проверяем session token из cookie или ждем rejoin event
    const cookies = socket.handshake.headers.cookie;
    let sessionToken = null;
    
    if (cookies) {
        const match = cookies.match(/chatSession=([^;]+)/);
        if (match) {
            sessionToken = match[1];
        }
    }
    
    if (sessionToken) {
        const user = validateSessionToken(sessionToken);
        if (user) {
            // Проверяем не забанен ли пользователь
            if (bannedUsers.has(user.id)) {
                socket.emit('banned');
                socket.disconnect(true);
                allConnections.delete(socket.id);
                return;
            }
            
            // Если IP изменился - обновляем
            if (user.ip !== clientIP) {
                console.log(`IP changed for user ${user.nickname}: ${user.ip} -> ${clientIP}`);
                user.ip = clientIP;
                
                // Генерируем новый session token при смене IP
                const newSessionToken = generateSessionToken();
                
                // Удаляем старый токен
                sessionTokens.delete(user.sessionToken);
                
                // Обновляем данные пользователя
                user.sessionToken = newSessionToken;
                sessionToken = newSessionToken;
                
                // Сохраняем новый токен
                sessionTokens.set(newSessionToken, user.id);
                registeredUsers.set(user.id, user);
                
                console.log(`New session token generated for ${user.nickname} due to IP change`);
                saveData();
            }
            
            // Отправляем данные пользователя для автовхода
            socket.emit('sessionValid', {
                userId: user.id,
                nickname: user.nickname,
                avatarHue: user.avatarHue,
                isAdmin: user.isAdmin,
                sessionToken: sessionToken // Отправляем (возможно обновленный) токен
            });
            
            console.log(`Session validated for ${user.nickname} from ${clientIP}`);
        } else {
            // Невалидный токен
            socket.emit('invalidSession');
            console.log(`Invalid session token from ${clientIP}`);
        }
    }
    
    socket.on('setNickname', (nickname) => {
        // Повторная проверка IP при попытке установить никнейм
        if (bannedIPs.has(clientIP)) {
            socket.emit('banned');
            socket.disconnect(true);
            return;
        }
        
        // Проверка fingerprint при установке никнейма
        if (socket.clientFingerprint && bannedFingerprints.has(socket.clientFingerprint)) {
            console.log('🚫 Banned fingerprint tried to set nickname:', socket.clientFingerprint.substring(0, 16) + '...');
            socket.emit('banned');
            socket.disconnect(true);
            return;
        }
        
        // Проверяем, может это Device Code для входа на другом устройстве
        if (nickname && /^[A-Z0-9]{4,6}$/.test(nickname.toUpperCase())) {
            const deviceCodeUser = validateDeviceCode(nickname.toUpperCase());
            if (deviceCodeUser) {
                // Пользователь входит через Device Code
                console.log(`🔑 User logging in with Device Code: ${nickname.toUpperCase()}`);
                
                // Проверяем не забанен ли
                if (bannedUsers.has(deviceCodeUser.id)) {
                    socket.emit('banned');
                    return;
                }
                
                // ВАЖНО: Удаляем Device Code после успешного использования
                const usedCode = deviceCodeUser.deviceCode;
                deviceCodeUser.deviceCode = null;
                registeredUsers.set(deviceCodeUser.id, deviceCodeUser);
                saveData();
                console.log(`🗑️ Device Code ${usedCode} deleted after use for security`);
                
                // Уведомляем ВСЕ активные сессии этого пользователя об удалении кода
                if (userSessions.has(deviceCodeUser.id)) {
                    userSessions.get(deviceCodeUser.id).forEach(sessionSocketId => {
                        const sessionSocket = io.sockets.sockets.get(sessionSocketId);
                        if (sessionSocket) {
                            sessionSocket.emit('deviceCodeDeleted', {
                                reason: 'Used for login on another device'
                            });
                        }
                    });
                }
                
                // Генерируем новый session token для этого устройства
                const newSessionToken = generateSessionToken();
                sessionTokens.set(newSessionToken, deviceCodeUser.id);
                
                // Создаем активного пользователя для этого сокета
                const activeUser = {
                    id: deviceCodeUser.id,
                    nickname: deviceCodeUser.nickname,
                    socketId: socket.id,
                    avatarHue: deviceCodeUser.avatarHue,
                    joinedAt: Date.now(),
                    isAdmin: deviceCodeUser.isAdmin,
                    ip: clientIP
                };
                
                users.set(socket.id, activeUser);
                socket.userId = deviceCodeUser.id;
                
                // Отслеживаем сессии
                if (!userSessions.has(deviceCodeUser.id)) {
                    userSessions.set(deviceCodeUser.id, new Set());
                }
                userSessions.get(deviceCodeUser.id).add(socket.id);
                
                // Отправляем данные пользователя (БЕЗ deviceCode, так как он удален)
                socket.emit('nicknameAccepted', {
                    user: {
                        id: deviceCodeUser.id,
                        nickname: deviceCodeUser.nickname,
                        avatarHue: deviceCodeUser.avatarHue,
                        isAdmin: deviceCodeUser.isAdmin
                    },
                    deviceCode: null, // Код удален для безопасности
                    sessionToken: newSessionToken,
                    isAdmin: deviceCodeUser.isAdmin,
                    isDeviceLogin: true
                });
                
                // Отправляем историю сообщений
                const recentMessages = messages.filter(msg => 
                    msg.timestamp > Date.now() - MESSAGE_RETENTION_TIME
                );
                socket.emit('messageHistory', recentMessages);
                
                // Уведомляем о входе
                io.emit('userJoined', {
                    nickname: deviceCodeUser.nickname,
                    onlineCount: allConnections.size
                });
                
                console.log(`✅ Device login successful: ${deviceCodeUser.nickname} from ${clientIP}`);
                return;
            }
        }
        
        // Обычная регистрация нового пользователя
        // Validate nickname
        const englishOnly = /^[a-zA-Z0-9_]+$/;
        
        if (!nickname || nickname.trim().length < 3 || nickname.length > 20) {
            socket.emit('error', { message: 'Nickname must be 3-20 characters' });
            return;
        }
        
        if (!englishOnly.test(nickname)) {
            socket.emit('error', { message: 'Nickname must contain only English letters, numbers, and underscores' });
            return;
        }
        
        if (!isNicknameAvailable(nickname)) {
            socket.emit('error', { message: 'Nickname already taken' });
            return;
        }
        
        // Create user
        const userId = uuidv4();
        const sessionToken = generateSessionToken();
        // НЕ генерируем Device Code автоматически - только по запросу
        const isAdmin = !adminId && nickname.toLowerCase() === 'mefisto';
        
        if (isAdmin) {
            adminId = userId;
            console.log('Admin user created:', nickname);
        }
        
        const user = {
            id: userId,
            nickname: nickname,
            socketId: socket.id,
            avatarHue: generateAvatarHue(),
            joinedAt: Date.now(),
            isAdmin: isAdmin,
            ip: clientIP
        };
        
        users.set(socket.id, user);
        socket.userId = userId;
        
        // Сохраняем fingerprint пользователя
        if (socket.clientFingerprint) {
            userFingerprints.set(userId, socket.clientFingerprint);
            console.log('Saved fingerprint for user:', nickname, 'FP:', socket.clientFingerprint.substring(0, 16) + '...');
        }
        
        // Сохраняем в постоянное хранилище БЕЗ device code (будет null)
        registeredUsers.set(userId, {
            id: user.id,
            nickname: user.nickname,
            avatarHue: user.avatarHue,
            isAdmin: user.isAdmin,
            ip: clientIP,
            sessionToken: sessionToken,
            deviceCode: null // Код генерируется только по запросу
        });
        
        // Сохраняем session token для быстрого поиска
        sessionTokens.set(sessionToken, userId);
        
        console.log('Created session for user:', user.nickname, 'Token:', sessionToken.substring(0, 16) + '...');
        
        // Сохраняем данные
        saveData();
        
        // Send acceptance and user data БЕЗ device code
        socket.emit('nicknameAccepted', {
            user: {
                id: user.id,
                nickname: user.nickname,
                avatarHue: user.avatarHue,
                isAdmin: user.isAdmin
            },
            deviceCode: null, // Пользователь должен сгенерировать код вручную
            sessionToken: sessionToken,
            isAdmin: isAdmin
        });
        
        // Send message history (last 24 hours)
        const recentMessages = messages.filter(msg => 
            msg.timestamp > Date.now() - MESSAGE_RETENTION_TIME
        );
        socket.emit('messageHistory', recentMessages);
        
        // Broadcast user joined
        io.emit('userJoined', {
            nickname: user.nickname,
            onlineCount: allConnections.size
        });
        
        console.log(`User joined: ${nickname} (${userId}), total online: ${users.size}`);
    });
    
    socket.on('rejoin', (userData) => {
        console.log('🔄 Rejoin attempt:', { userData, clientIP, socketId: socket.id });
        
        // Проверяем не забанен ли IP
        if (bannedIPs.has(clientIP)) {
            socket.emit('banned');
            socket.disconnect(true);
            return;
        }
        
        // Проверяем fingerprint
        if (socket.clientFingerprint && bannedFingerprints.has(socket.clientFingerprint)) {
            console.log('🚫 Banned fingerprint tried to rejoin:', socket.clientFingerprint.substring(0, 16) + '...');
            socket.emit('banned');
            socket.disconnect(true);
            return;
        }
        
        // Validate session token
        if (!userData || !userData.sessionToken) {
            socket.emit('error', { message: 'Invalid session data' });
            return;
        }
        
        const user = validateSessionToken(userData.sessionToken);
        
        if (!user) {
            socket.emit('invalidSession');
            return;
        }
        
        console.log(`👤 User ${user.nickname} (${user.id}) rejoining from ${clientIP}`);
        
        // Проверяем не забанен ли пользователь по ID
        if (bannedUsers.has(user.id)) {
            socket.emit('banned');
            return;
        }
        
        // Если IP изменился - обновляем и генерируем новый session token
        let sessionToken = user.sessionToken;
        
        if (user.ip !== clientIP) {
            console.log(`IP changed for user ${user.nickname}: ${user.ip} -> ${clientIP}`);
            user.ip = clientIP;
            
            // Генерируем новый session token при смене IP
            const newSessionToken = generateSessionToken();
            
            // Удаляем старый токен
            sessionTokens.delete(user.sessionToken);
            
            // Обновляем данные пользователя
            user.sessionToken = newSessionToken;
            sessionToken = newSessionToken;
            
            // Сохраняем новый токен
            sessionTokens.set(newSessionToken, user.id);
            registeredUsers.set(user.id, user);
            
            console.log(`New session token generated for ${user.nickname}: ${newSessionToken.substring(0, 16)}...`);
            
            saveData();
        }
        
        // Создаем/обновляем активного пользователя для ЭТОГО сокета
        const activeUser = {
            id: user.id,
            nickname: user.nickname,
            socketId: socket.id,
            avatarHue: user.avatarHue,
            joinedAt: Date.now(),
            isAdmin: user.isAdmin,
            ip: clientIP
        };
        
        // Сохраняем по socketId для множественных устройств
        users.set(socket.id, activeUser);
        socket.userId = user.id;
        
        // Отслеживаем все сессии этого пользователя
        if (!userSessions.has(user.id)) {
            userSessions.set(user.id, new Set());
        }
        userSessions.get(user.id).add(socket.id);
        
        console.log('✅ Socket.userId set:', socket.userId, 'socketId:', socket.id, 'for user:', user.nickname);
        console.log('✅ User sessions:', userSessions.get(user.id).size, 'active sessions');
        
        socket.emit('nicknameAccepted', {
            user: {
                id: user.id,
                nickname: user.nickname,
                avatarHue: user.avatarHue,
                isAdmin: user.isAdmin
            },
            deviceCode: user.deviceCode,
            sessionToken: sessionToken, // Отправляем текущий (или новый) токен
            isAdmin: user.isAdmin,
            isRejoin: true
        });
        
        // Отправляем историю сообщений
        const recentMessages = messages.filter(msg => 
            msg.timestamp > Date.now() - MESSAGE_RETENTION_TIME
        );
        socket.emit('messageHistory', recentMessages);
        
        // Уведомляем всех о входе
        io.emit('userJoined', {
            nickname: user.nickname,
            onlineCount: allConnections.size
        });
        
        console.log(`✅ User rejoined successfully: ${user.nickname} (${user.id}), socket.userId=${socket.userId}, total online: ${users.size}`);
    });
    
    socket.on('generateDeviceCode', () => {
        if (!socket.userId || !users.has(socket.id)) {
            socket.emit('error', { message: 'You must be logged in' });
            return;
        }
        
        const user = users.get(socket.id);
        const registeredUser = registeredUsers.get(user.id);
        
        if (!registeredUser) {
            socket.emit('error', { message: 'User not found' });
            return;
        }
        
        // Генерируем новый уникальный Device Code
        const newDeviceCode = generateUniqueDeviceCode();
        registeredUser.deviceCode = newDeviceCode;
        registeredUsers.set(user.id, registeredUser);
        
        saveData();
        
        console.log(`Device code generated for ${user.nickname}: ${newDeviceCode}`);
        
        socket.emit('deviceCodeGenerated', {
            deviceCode: newDeviceCode
        });
    });
    
    socket.on('message', (messageText) => {
        console.log('📨 Message received:', { socketId: socket.id, userId: socket.userId, hasUser: users.has(socket.id), messageText });
        
        if (!socket.userId || !users.has(socket.id)) {
            console.log('❌ User not found or no userId set');
            socket.emit('error', { message: 'You must set a nickname first' });
            return;
        }
        
        if (bannedUsers.has(socket.userId)) {
            console.log('❌ User is banned:', socket.userId);
            socket.emit('banned');
            return;
        }
        
        const user = users.get(socket.id);
        console.log('✅ User sending message:', user.nickname);
        
        if (!messageText || messageText.trim().length === 0 || messageText.length > 100) {
            socket.emit('error', { message: 'Message must be 1-100 characters' });
            return;
        }
        
        const trimmedMessage = messageText.trim();
        
        // Автомодерация: проверка на ссылки (http://, https://, www., .com, .ru, etc)
        const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.(com|ru|net|org|io|gg|xyz|me|co|uk|us|tv|yt|cc|link|site|online|store|app|dev|tech)[^\s]*)/gi;
        if (urlRegex.test(trimmedMessage)) {
            socket.emit('error', { message: 'Links are not allowed in chat' });
            console.log(`Blocked link from ${user.nickname}: ${trimmedMessage}`);
            return;
        }
        
        // Автомодерация: проверка на упоминания @никнейм
        if (/@\w+/.test(trimmedMessage)) {
            socket.emit('error', { message: 'Mentions (@username) are not allowed' });
            console.log(`Blocked mention from ${user.nickname}: ${trimmedMessage}`);
            return;
        }
        
        // Автомодерация: проверка на дубликаты сообщений
        const lastMessage = userLastMessages.get(socket.userId);
        if (lastMessage === trimmedMessage) {
            socket.emit('error', { message: 'Cannot send duplicate messages' });
            console.log(`Blocked duplicate from ${user.nickname}: ${trimmedMessage}`);
            return;
        }
        
        // Автомодерация: проверка на CAPS LOCK (все буквы в верхнем регистре)
        const lettersOnly = trimmedMessage.replace(/[^a-zA-Z]/g, '');
        if (lettersOnly.length >= 3 && lettersOnly === lettersOnly.toUpperCase()) {
            socket.emit('error', { message: 'Please do not use all CAPS' });
            console.log(`Blocked CAPS message from ${user.nickname}: ${trimmedMessage}`);
            return;
        }
        
        // Автомодерация: проверка на неанглийские символы
        // Разрешены: английские буквы, цифры, базовые символы, пробелы и эмодзи (Unicode > 127)
        const hasNonEnglish = /[а-яА-ЯёЁ\u0400-\u04FF\u4E00-\u9FFF\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF\u0590-\u05FF\u0600-\u06FF\u0750-\u077F\u0900-\u097F\uFF00-\uFFEF]/.test(trimmedMessage);
        if (hasNonEnglish) {
            socket.emit('error', { message: 'Only English language is allowed in chat' });
            console.log(`Blocked non-English message from ${user.nickname}: ${trimmedMessage}`);
            return;
        }
        
        // Сохраняем последнее сообщение пользователя
        userLastMessages.set(socket.userId, trimmedMessage);
        
        const message = {
            id: uuidv4(),
            userId: user.id,
            nickname: user.nickname,
            avatarHue: user.avatarHue,
            message: trimmedMessage,
            timestamp: Date.now()
        };
        
        messages.push(message);
        
        // Сохраняем данные после нового сообщения (каждые 10 сообщений)
        if (messages.length % 10 === 0) {
            saveData();
        }
        
        // Broadcast message to all users
        io.emit('message', message);
        
        console.log(`Message from ${user.nickname}: ${trimmedMessage}`);
    });
    
    socket.on('banUser', (targetUserId) => {
        // Check if requester is admin
        if (!socket.userId || socket.userId !== adminId) {
            socket.emit('error', { message: 'Only admin can ban users' });
            return;
        }
        
        // Ищем пользователя по userId в registeredUsers (постоянное хранилище)
        if (!registeredUsers.has(targetUserId)) {
            socket.emit('error', { message: 'User not found' });
            console.error(`Ban failed: User ${targetUserId} not found in registeredUsers`);
            return;
        }
        
        const targetUserData = registeredUsers.get(targetUserId);
        
        // Can't ban self
        if (targetUserId === adminId) {
            socket.emit('error', { message: 'Cannot ban admin' });
            return;
        }
        
        console.log(`Admin banning user: ${targetUserData.nickname} (${targetUserId})`);
        
        // Ban user permanently
        bannedUsers.add(targetUserId);
        bannedNicknames.add(targetUserData.nickname.toLowerCase()); // Блокируем никнейм навсегда
        
        // Блокируем IP адрес навсегда (кроме IP админа mefisto)
        if (targetUserData.ip) {
            // Находим IP админа
            let adminIP = null;
            if (adminId && registeredUsers.has(adminId)) {
                adminIP = registeredUsers.get(adminId).ip;
            }
            
            // Не баним IP админа
            if (targetUserData.ip !== adminIP) {
                bannedIPs.add(targetUserData.ip);
                console.log(`Banned IP: ${targetUserData.ip} (user: ${targetUserData.nickname})`);
            } else {
                console.log(`Skipped banning admin IP: ${targetUserData.ip}`);
            }
        }
        
        // Блокируем fingerprint пользователя
        if (userFingerprints.has(targetUserId)) {
            const fingerprint = userFingerprints.get(targetUserId);
            bannedFingerprints.add(fingerprint);
            console.log(`Banned fingerprint: ${fingerprint.substring(0, 16)}... (user: ${targetUserData.nickname})`);
        }
        
        // Удаляем session token забаненного пользователя
        if (targetUserData.sessionToken) {
            sessionTokens.delete(targetUserData.sessionToken);
        }
        
        // Remove all their messages
        const messagesToRemove = [];
        for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].userId === targetUserId) {
                messagesToRemove.push(messages[i].id);
                messages.splice(i, 1);
            }
        }
        
        // Notify all clients to remove messages
        messagesToRemove.forEach(messageId => {
            io.emit('messageDeleted', messageId);
        });
        
        // Отключаем ВСЕ активные сессии этого пользователя
        if (userSessions.has(targetUserId)) {
            userSessions.get(targetUserId).forEach(sessionSocketId => {
                const targetSocket = io.sockets.sockets.get(sessionSocketId);
                if (targetSocket) {
                    targetSocket.emit('banned');
                    targetSocket.disconnect(true);
                }
                // Удаляем из активных пользователей
                users.delete(sessionSocketId);
            });
            userSessions.delete(targetUserId);
        }
        
        // Remove from registered users
        registeredUsers.delete(targetUserId);
        
        // Сохраняем данные после бана
        saveData();
        
        io.emit('userLeft', {
            nickname: targetUserData.nickname,
            onlineCount: allConnections.size,
            banned: true
        });
        
        console.log(`✅ User banned: ${targetUserData.nickname} by admin`);
    });
    
    socket.on('disconnect', () => {
        // ВАЖНО: Удаляем из общего списка подключений в любом случае
        const wasInSet = allConnections.delete(socket.id);
        
        if (!wasInSet) {
            console.log(`⚠️ Warning: Socket ${socket.id} was not in allConnections set`);
        }
        
        // Обновляем счетчик для всех
        io.emit('onlineCount', allConnections.size);
        
        if (socket.userId && users.has(socket.id)) {
            const user = users.get(socket.id);
            users.delete(socket.id);
            
            // Удаляем из userSessions
            if (userSessions.has(socket.userId)) {
                userSessions.get(socket.userId).delete(socket.id);
                if (userSessions.get(socket.userId).size === 0) {
                    userSessions.delete(socket.userId);
                    // Только если это была последняя сессия - уведомляем об уходе
                    io.emit('userLeft', {
                        nickname: user.nickname,
                        onlineCount: allConnections.size
                    });
                }
            }
            
            console.log(`👤 User session ended: ${user.nickname} | Socket: ${socket.id} | Remaining sessions: ${userSessions.has(socket.userId) ? userSessions.get(socket.userId).size : 0} | Total online: ${allConnections.size}`);
        } else {
            console.log(`🔌 Connection closed: ${socket.id} | Total online: ${allConnections.size}`);
        }
    });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        onlineUsers: users.size,
        registeredUsers: registeredUsers.size,
        totalMessages: messages.length,
        adminExists: !!adminId,
        bannedUsers: bannedUsers.size,
        bannedIPs: bannedIPs.size,
        bannedFingerprints: bannedFingerprints.size
    });
});

// Get banned IPs list
app.get('/admin/banned-ips', (req, res) => {
    const bannedIPsList = Array.from(bannedIPs);
    res.json({
        count: bannedIPsList.length,
        ips: bannedIPsList
    });
});

// Clear all bans (requires admin key)
app.post('/admin/clear-bans', express.json(), (req, res) => {
    const { adminKey } = req.body;
    
    const ADMIN_KEY = process.env.ADMIN_KEY;
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }
    
    const stats = {
        bannedIPsCleared: bannedIPs.size,
        bannedUsersCleared: bannedUsers.size,
        bannedNicknamesCleared: bannedNicknames.size,
        bannedFingerprintsCleared: bannedFingerprints.size
    };
    
    // Очищаем все баны
    bannedIPs.clear();
    bannedUsers.clear();
    bannedNicknames.clear();
    bannedFingerprints.clear();
    
    saveData(); // Сохраняем после очистки
    
    console.log('All bans cleared by admin:', stats);
    
    res.json({
        success: true,
        message: 'All bans cleared',
        stats: stats
    });
});

// Clear all registered users (requires admin key)
app.post('/admin/clear-users', express.json(), (req, res) => {
    const { adminKey } = req.body;
    
    const ADMIN_KEY = process.env.ADMIN_KEY;
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }
    
    const stats = {
        registeredUsersCleared: registeredUsers.size,
        sessionTokensCleared: sessionTokens.size,
        activeUsersCleared: users.size
    };
    
    // Очищаем всех пользователей
    registeredUsers.clear();
    sessionTokens.clear();
    users.clear();
    adminId = null; // Сбрасываем админа
    
    saveData();
    
    console.log('All users cleared by admin:', stats);
    
    res.json({
        success: true,
        message: 'All users cleared',
        stats: stats
    });
});

// Remove specific IP ban
app.post('/admin/unban-ip', express.json(), (req, res) => {
    const { adminKey, ip } = req.body;
    
    const ADMIN_KEY = process.env.ADMIN_KEY;
    if (!ADMIN_KEY || adminKey !== ADMIN_KEY) {
        return res.status(403).json({ error: 'Invalid admin key' });
    }
    
    if (!ip) {
        return res.status(400).json({ error: 'IP address required' });
    }
    
    if (bannedIPs.has(ip)) {
        bannedIPs.delete(ip);
        saveData(); // Сохраняем после разбана
        console.log('IP unbanned:', ip);
        res.json({ success: true, message: `IP ${ip} unbanned` });
    } else {
        res.status(404).json({ error: 'IP not found in ban list' });
    }
});

// Debug endpoint - check user status
app.get('/debug/user/:nickname', (req, res) => {
    const nickname = req.params.nickname.toLowerCase();
    
    // Find all active sessions for this nickname
    const activeSessions = [];
    let userId = null;
    
    for (const [socketId, user] of users.entries()) {
        if (user.nickname.toLowerCase() === nickname) {
            activeSessions.push({
                socketId: socketId,
                ip: user.ip,
                joinedAt: user.joinedAt
            });
            userId = user.id;
        }
    }
    
    const registeredUser = Array.from(registeredUsers.entries()).find(
        ([id, user]) => user.nickname.toLowerCase() === nickname
    );
    
    res.json({
        nickname: req.params.nickname,
        activeSessions: activeSessions,
        sessionCount: activeSessions.length,
        userId: userId,
        registeredUser: registeredUser ? registeredUser[1] : null,
        registeredUserId: registeredUser ? registeredUser[0] : null,
        isBanned: userId ? bannedUsers.has(userId) : false,
        totalActiveConnections: users.size,
        totalRegisteredUsers: registeredUsers.size
    });
});

// Wave cache endpoints
app.post('/api/wave-cache', express.json(), async (req, res) => {
    try {
        const cacheData = req.body;
        await saveWaveCache(cacheData);
        res.json({ success: true, message: 'Cache saved' });
    } catch (error) {
        console.error('Error saving cache:', error);
        res.status(500).json({ error: 'Failed to save cache' });
    }
});

app.get('/api/wave-cache', async (req, res) => {
    try {
        const cache = await loadWaveCache();
        if (cache) {
            res.json(cache);
        } else {
            res.status(404).json({ error: 'No cache available' });
        }
    } catch (error) {
        console.error('Error loading cache:', error);
        res.status(500).json({ error: 'Failed to load cache' });
    }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Chat server running on port ${PORT}`);
    console.log(`Admin will be the first user with nickname 'mefisto'`);
    
    // Сохраняем данные при остановке сервера
    process.on('SIGINT', () => {
        console.log('Saving data before shutdown...');
        saveData();
        process.exit(0);
    });
    
    process.on('SIGTERM', () => {
        console.log('Saving data before shutdown...');
        saveData();
        process.exit(0);
    });
});
