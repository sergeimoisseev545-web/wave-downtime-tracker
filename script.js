// Configuration
const API_URL = '/api/wave'; // Используем локальный прокси
const ROBLOX_API_URL = '/api/roblox'; // Roblox versions API
const CACHE_API_URL = 'https://wave-chat-server.onrender.com/api/wave-cache'; // MongoDB cache
const REFRESH_INTERVAL = 30000; // 30 seconds
const STORAGE_KEY = 'waveDowntimeData';

// WEAO domains for direct fallback (if proxy fails)
const WEAO_DOMAINS = [
    'weao.xyz',
    'whatexpsare.online',
    'whatexploitsaretra.sh',
    'weao.gg'
];

// State
let currentState = {
    isDown: false,
    version: null,
    lastKnownVersion: null,
    downSince: null,
    apiDownSince: null,
    lastDowntimeDuration: 0,
    longestDowntime: 0,
    savedLastDowntime: 0, // Сохраненное значение последнего downtime для stat-card
    apiAvailable: true
};

// Notification state
let notificationsEnabled = false;
let notificationAudio = null;

// Load saved data from localStorage and MongoDB
async function loadSavedData() {
    try {
        // Сначала пытаемся загрузить из MongoDB
        const dbCache = await loadCacheFromDB();
        
        if (dbCache) {
            // Используем данные из MongoDB
            if (dbCache.lastDowntimeDuration) {
                currentState.lastDowntimeDuration = dbCache.lastDowntimeDuration;
            }
            if (dbCache.longestDowntime) {
                currentState.longestDowntime = dbCache.longestDowntime;
            }
            if (dbCache.savedLastDowntime !== undefined) {
                currentState.savedLastDowntime = dbCache.savedLastDowntime;
            } else if (dbCache.longestDowntime && !dbCache.savedLastDowntime) {
                // Одноразовая инициализация: используем longestDowntime как первое значение
                currentState.savedLastDowntime = dbCache.longestDowntime;
            }
            if (dbCache.lastKnownVersion) {
                currentState.lastKnownVersion = dbCache.lastKnownVersion;
            }
            if (dbCache.isDown !== undefined) {
                currentState.isDown = dbCache.isDown;
            }
            if (dbCache.apiDownSince) {
                currentState.apiDownSince = dbCache.apiDownSince;
            }
        } else {
            // Fallback на localStorage
            const saved = localStorage.getItem(STORAGE_KEY);
            if (saved) {
                const data = JSON.parse(saved);
                if (data.lastDowntimeDuration) {
                    currentState.lastDowntimeDuration = data.lastDowntimeDuration;
                }
                if (data.longestDowntime) {
                    currentState.longestDowntime = data.longestDowntime;
                }
                if (data.savedLastDowntime !== undefined) {
                    currentState.savedLastDowntime = data.savedLastDowntime;
                } else if (data.longestDowntime && !data.savedLastDowntime) {
                    // Одноразовая инициализация: используем longestDowntime как первое значение
                    currentState.savedLastDowntime = data.longestDowntime;
                }
                if (data.lastKnownVersion) {
                    currentState.lastKnownVersion = data.lastKnownVersion;
                }
                if (data.isDown !== undefined) {
                    currentState.isDown = data.isDown;
                }
                if (data.apiDownSince) {
                    currentState.apiDownSince = data.apiDownSince;
                }
            }
        }
        
        updateStatsDisplay();
    } catch (e) {
        console.error('Error loading saved data:', e);
    }
}

// Save data to localStorage and MongoDB
async function saveData() {
    try {
        const dataToSave = {
            lastDowntimeDuration: currentState.lastDowntimeDuration,
            longestDowntime: currentState.longestDowntime,
            savedLastDowntime: currentState.savedLastDowntime,
            lastKnownVersion: currentState.lastKnownVersion,
            isDown: currentState.isDown,
            apiDownSince: currentState.apiDownSince
        };
        
        // Сохраняем в localStorage
        localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));
        
        // Сохраняем в MongoDB через API
        try {
            await fetch(CACHE_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(dataToSave)
            });
        } catch (error) {
            console.warn('Failed to save cache to MongoDB:', error);
        }
    } catch (e) {
        console.error('Error saving data:', e);
    }
}

// Load cache from MongoDB
async function loadCacheFromDB() {
    try {
        const response = await fetch(CACHE_API_URL);
        if (response.ok) {
            const cache = await response.json();
            return cache;
        }
    } catch (error) {
        console.warn('Failed to load cache from MongoDB:', error);
    }
    return null;
}

// Fetch with fallback across multiple domains
async function fetchWithFallback(endpoint) {
    // Рандомизируем домены для распределения нагрузки
    const domains = [...WEAO_DOMAINS].sort(() => Math.random() - 0.5);
    
    for (const domain of domains) {
        try {
            const url = `https://${domain}${endpoint}`;
            
            const response = await fetch(url, {
                headers: { 'User-Agent': 'WEAO-3PService' }
            });
            
            if (response.status === 429) {
                continue;
            }
            
            if (!response.ok) {
                continue;
            }
            
            const data = await response.json();
            return data;
            
        } catch (error) {
            continue;
        }
    }
    
    return null;
}

// Fetch Roblox version info
async function fetchRobloxVersion() {
    try {
        // Сначала пытаемся через прокси
        const response = await fetch(ROBLOX_API_URL);
        
        if (response.ok) {
            const data = await response.json();
            return data;
        }
        
        // Если прокси не работает, пробуем напрямую с fallback
        console.warn('Proxy failed, trying direct access with fallback...');
        return await fetchWithFallback('/api/versions/current');
        
    } catch (error) {
        console.error('Error fetching Roblox version from proxy:', error);
        // Fallback на прямые запросы
        return await fetchWithFallback('/api/versions/current');
    }
}

// Fetch Wave status from API
async function fetchWaveStatus() {
    try {
        // Сначала пытаемся через прокси
        const response = await fetch(API_URL);
        
        if (response.ok) {
            const data = await response.json();
            return data;
        }
        
        // Если прокси не работает, пробуем напрямую с fallback
        console.warn('Proxy failed, trying direct access with fallback...');
        return await fetchWithFallback('/api/status/exploits/wave');
        
    } catch (error) {
        console.error('Error fetching Wave status from proxy:', error);
        // Fallback на прямые запросы
        return await fetchWithFallback('/api/status/exploits/wave');
    }
}

// Parse API date to timestamp
function parseApiDate(dateString) {
    // Format: "11/19/2025, 9:06:21 PM UTC"
    try {
        const cleanDate = dateString.replace(' UTC', '').replace(',', '');
        return new Date(cleanDate + ' UTC').getTime();
    } catch (e) {
        console.error('Error parsing date:', e);
        return null;
    }
}

// Format time duration
function formatDuration(milliseconds) {
    const seconds = Math.floor(milliseconds / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) {
        return `${days}d ${hours % 24}h ${minutes % 60}m`;
    } else if (hours > 0) {
        return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
    } else if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    } else {
        return `${seconds}s`;
    }
}

// Format time for timer display
function formatTimer(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

// Update timer display
function updateTimer() {
    const timerElement = document.getElementById('timer');
    
    if (currentState.isDown && currentState.apiDownSince) {
        const elapsed = Date.now() - currentState.apiDownSince;
        timerElement.textContent = formatTimer(elapsed);
        
        // Обновляем longest если текущий downtime больше
        if (elapsed > currentState.longestDowntime) {
            currentState.longestDowntime = elapsed;
        }
        
        // Обновляем статистику (включая Last Downtime если нет истории)
        updateStatsDisplay();
    }
}

// Update stats display
function updateStatsDisplay() {
    const lastDowntimeElement = document.getElementById('lastDowntime');
    const recordElement = document.getElementById('record');
    
    // Показываем сохраненное значение последнего downtime
    if (currentState.savedLastDowntime > 0) {
        lastDowntimeElement.textContent = formatDuration(currentState.savedLastDowntime);
    } else {
        lastDowntimeElement.textContent = 'No data yet';
    }
    
    if (currentState.longestDowntime > 0) {
        recordElement.textContent = formatDuration(currentState.longestDowntime);
    } else {
        recordElement.textContent = 'No data yet';
    }
}

// Update UI
async function updateUI(data) {
    const versionElement = document.getElementById('version');
    const statusTextElement = document.getElementById('statusText');
    const statusIndicatorElement = document.getElementById('statusIndicator');
    const timerSectionElement = document.getElementById('timerSection');
    const timerLabelElement = document.getElementById('timerLabel');
    
    const apiStatusSection = document.getElementById('apiStatusSection');
    const apiStatusMessage = document.getElementById('apiStatusMessage');
    
    if (!data) {
        // API недоступно - используем кешированные данные из MongoDB
        currentState.apiAvailable = false;
        
        // Показываем ошибку API в отдельной секции
        apiStatusSection.classList.remove('hidden');
        apiStatusMessage.textContent = '⚠️ WEAO API is currently unavailable - Using cached data from database';
        apiStatusMessage.className = 'api-status-message error';
        
        // Показываем закешированное состояние
        if (currentState.lastKnownVersion) {
            versionElement.textContent = currentState.lastKnownVersion;
        } else {
            versionElement.textContent = 'Unknown';
        }
        
        // Обновляем UI согласно закешированному состоянию
        if (currentState.isDown) {
            statusTextElement.innerHTML = 'WAVE IS DOWN! <img src="warningemoji.webp" alt="Warning" class="status-emoji">';
            statusTextElement.className = 'status-text status-down';
            timerSectionElement.classList.remove('hidden');
            timerLabelElement.textContent = 'Down for';
            const warningEl = document.getElementById('downgradeWarning');
            if (warningEl) {
                warningEl.style.display = 'block';
                console.log('✅ Downgrade warning shown');
            } else {
                console.error('❌ downgradeWarning element not found');
            }
            
            // Продолжаем показывать таймер
            if (currentState.apiDownSince) {
                updateTimer();
            }
        } else {
            const warningEl = document.getElementById('downgradeWarning');
            if (warningEl) {
                warningEl.style.display = 'none';
                console.log('ℹ️ Downgrade warning hidden');
            }
            statusTextElement.innerHTML = 'WAVE IS UP! <img src="happyemoji.webp" alt="Happy" class="status-emoji">';
            statusTextElement.className = 'status-text status-up';
            
            if (currentState.lastDowntimeDuration > 0) {
                timerSectionElement.classList.remove('hidden');
                document.getElementById('timer').textContent = formatDuration(currentState.lastDowntimeDuration);
                timerLabelElement.textContent = 'Last downtime duration';
            } else {
                timerSectionElement.classList.add('hidden');
            }
        }
        
        updateStatsDisplay();
        return;
    }
    
    // API снова доступен
    if (!currentState.apiAvailable) {
        // Показываем успешное подключение на 3 секунды
        apiStatusSection.classList.remove('hidden');
        apiStatusMessage.textContent = '✅ API reconnected successfully';
        apiStatusMessage.className = 'api-status-message success';
        setTimeout(() => {
            apiStatusSection.classList.add('hidden');
        }, 3000);
    } else {
        // API работает нормально - скрываем статус
        apiStatusSection.classList.add('hidden');
    }
    currentState.apiAvailable = true;
    
    // Сохраняем текущую версию как последнюю известную
    if (data.version) {
        const wasUpdated = currentState.lastKnownVersion && currentState.lastKnownVersion !== data.version;
        currentState.lastKnownVersion = data.version;
        versionElement.textContent = data.version;
        
        // Если версия изменилась (обновилась)
        if (wasUpdated && currentState.isDown) {
            // Wave обновился! Сохраняем результаты
            const finalDowntime = currentState.apiDownSince ? Date.now() - currentState.apiDownSince : 0;
            
            // Сохраняем как последний downtime
            currentState.lastDowntimeDuration = finalDowntime;
            
            // Обновляем рекорд если текущий downtime больше
            if (finalDowntime > currentState.longestDowntime) {
                currentState.longestDowntime = finalDowntime;
            }
            
            await saveData(); // Сохраняем в localStorage и MongoDB
        }
    } else {
        versionElement.textContent = currentState.lastKnownVersion || 'Unknown';
    }
    
    // Check if Wave is down (updateStatus: false means it's down)
    const isCurrentlyDown = data.updateStatus === false;
    
    // Получаем время обновления Roblox для Windows (только если API доступен)
    const robloxData = await fetchRobloxVersion();
    if (robloxData && robloxData.WindowsDate) {
        const robloxTimestamp = parseApiDate(robloxData.WindowsDate);
        if (robloxTimestamp) {
            // Обновляем apiDownSince только если оно ещё не установлено или изменилось
            if (!currentState.apiDownSince || currentState.apiDownSince !== robloxTimestamp) {
                currentState.apiDownSince = robloxTimestamp;
            }
        }
    }
    
    // Handle state changes
    if (isCurrentlyDown && !currentState.isDown) {
        // Wave just went down
        currentState.isDown = true;
        currentState.downSince = Date.now();
        currentState.version = data.version;
    } else if (!isCurrentlyDown && currentState.isDown) {
        // Wave came back up - сохраняем последний downtime!
        const finalDowntime = currentState.apiDownSince ? Date.now() - currentState.apiDownSince : 0;
        
        if (finalDowntime > 0) {
            // Сохраняем как последний downtime для stat-card
            currentState.savedLastDowntime = finalDowntime;
            
            // Обновляем рекорд если текущий downtime больше
            if (finalDowntime > currentState.longestDowntime) {
                currentState.longestDowntime = finalDowntime;
            }
            
            // Также сохраняем в lastDowntimeDuration для основного таймера
            currentState.lastDowntimeDuration = finalDowntime;
        }
        
        // TRIGGER NOTIFICATION!
        showWaveUpNotification();
        
        currentState.isDown = false;
        currentState.downSince = null;
        currentState.apiDownSince = null;
        await saveData(); // Сохраняем новое состояние
        updateStatsDisplay();
    }
    
    // Update UI based on status
    if (isCurrentlyDown) {
        statusTextElement.innerHTML = 'WAVE IS DOWN! <img src="warningemoji.webp" alt="Warning" class="status-emoji">';
        statusTextElement.className = 'status-text status-down';
        timerSectionElement.classList.remove('hidden');
        timerLabelElement.textContent = 'Down for';
        const warningEl = document.getElementById('downgradeWarning');
        if (warningEl) {
            warningEl.style.display = 'block';
            console.log('✅ Downgrade warning shown (main UI)');
        } else {
            console.error('❌ downgradeWarning element not found (main UI)');
        }
        updateTimer();
    } else {
        statusTextElement.innerHTML = 'WAVE IS UP! <img src="happyemoji.webp" alt="Happy" class="status-emoji">';
        statusTextElement.className = 'status-text status-up';
        const warningEl = document.getElementById('downgradeWarning');
        if (warningEl) {
            warningEl.style.display = 'none';
            console.log('ℹ️ Downgrade warning hidden (main UI)');
        }
        
        if (currentState.lastDowntimeDuration > 0) {
            timerSectionElement.classList.remove('hidden');
            document.getElementById('timer').textContent = formatDuration(currentState.lastDowntimeDuration);
            timerLabelElement.textContent = 'Last downtime duration';
        } else {
            timerSectionElement.classList.add('hidden');
        }
    }
}

// Initialize and start monitoring
async function init() {
    await loadSavedData();
    
    // Initial fetch
    const data = await fetchWaveStatus();
    await updateUI(data);
    
    // Set up refresh interval
    setInterval(async () => {
        const data = await fetchWaveStatus();
        await updateUI(data);
    }, REFRESH_INTERVAL);
    
    // Update timer every second when down
    setInterval(() => {
        if (currentState.isDown) {
            updateTimer();
        }
    }, 1000);
    
    // Периодически сохраняем состояние в кеш (каждые 2 минуты)
    setInterval(async () => {
        await saveData();
    }, 2 * 60 * 1000);
}

// Nya sound functionality
let nyaAudio = null;
let isNyaPlaying = false;

function toggleNyaSound() {
    const wavetyanImg = document.querySelector('.wavetyan-sitting');
    
    if (!nyaAudio) {
        nyaAudio = new Audio('nya.mp3');
        nyaAudio.addEventListener('ended', () => {
            isNyaPlaying = false;
            if (wavetyanImg) {
                wavetyanImg.classList.remove('bouncing');
            }
        });
    }
    
    if (isNyaPlaying) {
        nyaAudio.pause();
        nyaAudio.currentTime = 0;
        isNyaPlaying = false;
        if (wavetyanImg) {
            wavetyanImg.classList.remove('bouncing');
        }
    } else {
        nyaAudio.play();
        isNyaPlaying = true;
        if (wavetyanImg) {
            wavetyanImg.classList.add('bouncing');
        }
    }
}

// Notification functionality
function initNotifications() {
    notificationAudio = document.getElementById('notificationAudio');
    const notificationBtn = document.getElementById('notificationBtn');
    
    // Ensure audio is loaded
    if (notificationAudio) {
        notificationAudio.load();
        
        notificationAudio.addEventListener('error', (e) => {
            console.error('Audio loading error:', e);
        });
    }
    
    // Load notification preference
    const savedPref = localStorage.getItem('notificationsEnabled');
    if (savedPref === 'true') {
        notificationsEnabled = true;
        notificationBtn.classList.add('active');
    }
    
    notificationBtn.addEventListener('click', async () => {
        if (!notificationsEnabled) {
            // Request notification permission
            if ('Notification' in window) {
                const permission = await Notification.requestPermission();
                if (permission === 'granted') {
                    notificationsEnabled = true;
                    notificationBtn.classList.add('active');
                    localStorage.setItem('notificationsEnabled', 'true');
                    
                    // Show confirmation
                    new Notification('Wave Downtime Tracker', {
                        body: 'Notifications enabled! You will be notified when Wave is UP.',
                        icon: 'wavebluelogo.webp',
                        tag: 'wave-notification-test'
                    });
                } else {
                    alert('Please allow notifications to use this feature');
                }
            } else {
                alert('Your browser does not support notifications');
            }
        } else {
            // Disable notifications
            notificationsEnabled = false;
            notificationBtn.classList.remove('active');
            localStorage.setItem('notificationsEnabled', 'false');
        }
    });
}

function showWaveUpNotification() {
    if (!notificationsEnabled) {
        return;
    }
    
    // Play notification sound
    if (notificationAudio) {
        notificationAudio.currentTime = 0;
        notificationAudio.volume = 1.0;
        
        const playPromise = notificationAudio.play();
        if (playPromise !== undefined) {
            playPromise.catch(err => {
                console.error('Failed to play notification sound:', err);
            });
        }
    }
    
    // Show Windows notification
    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('WAVE IS UP! 🎉', {
            body: 'Wave exploit is now available!',
            icon: 'wavebluelogo.webp',
            tag: 'wave-status-up',
            requireInteraction: true
        });
    }
}



// Site branding copy functionality
function initSiteBrandingCopy() {
    const siteBranding = document.getElementById('siteBranding');
    if (!siteBranding) return;
    
    siteBranding.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText('wavestatus.com');
            
            // Show "Copied!" feedback in tooltip only
            const originalTooltip = siteBranding.getAttribute('data-tooltip');
            
            siteBranding.setAttribute('data-tooltip', 'Copied!');
            
            // Reset after 2 seconds
            setTimeout(() => {
                siteBranding.setAttribute('data-tooltip', originalTooltip);
            }, 2000);
        } catch (err) {
            console.error('Failed to copy:', err);
        }
    });
}

// Start the application
init();
initNotifications();
initSiteBrandingCopy();

// Show warning immediately for testing (remove after confirming it works)
document.addEventListener('DOMContentLoaded', () => {
    const warningEl = document.getElementById('downgradeWarning');
    if (warningEl) {
        warningEl.style.display = 'block';
        console.log('✅ Downgrade warning force-shown on page load');
    } else {
        console.error('❌ downgradeWarning element not found on DOMContentLoaded');
    }
});
