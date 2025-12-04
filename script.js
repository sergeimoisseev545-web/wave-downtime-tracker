const API_URL = '/api/wave';
const ROBLOX_API_URL = '/api/roblox';
const CACHE_API_URL = 'https://wave-chat-server.onrender.com/api/wave-cache';
const REFRESH_INTERVAL = 30000;
const STORAGE_KEY = 'waveDowntimeData';

const WEAO_DOMAINS = [
    'weao.xyz',
    'whatexpsare.online',
    'whatexploitsaretra.sh',
    'weao.gg'
];

let currentState = {
    isDown: false,
    version: null,
    lastKnownVersion: null,
    downSince: null,
    apiDownSince: null,
    lastDowntimeDuration: 0,
    longestDowntime: 0,
    savedLastDowntime: 0,
    apiAvailable: true,
    previousRobloxVersion: 'version-e380c8edc8f6477c'
};

let notificationsEnabled = false;
let notificationAudio = null;

async function loadSavedData() {
    try {

        const dbCache = await loadCacheFromDB();

        if (dbCache) {

            if (dbCache.lastDowntimeDuration) {
                currentState.lastDowntimeDuration = dbCache.lastDowntimeDuration;
            }
            if (dbCache.longestDowntime) {
                currentState.longestDowntime = dbCache.longestDowntime;
            }
            if (dbCache.savedLastDowntime !== undefined) {
                currentState.savedLastDowntime = dbCache.savedLastDowntime;
            } else if (dbCache.longestDowntime && !dbCache.savedLastDowntime) {

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
                if (data.previousRobloxVersion) {
                    currentState.previousRobloxVersion = data.previousRobloxVersion;
                }
            }
        }
        
        const savedPrevVersion = localStorage.getItem('previousRobloxVersion');
        if (savedPrevVersion) {
            currentState.previousRobloxVersion = savedPrevVersion;
        }

        updateStatsDisplay();
    } catch (e) {
    }
}

async function saveData() {
    try {
        const dataToSave = {
            lastDowntimeDuration: currentState.lastDowntimeDuration,
            longestDowntime: currentState.longestDowntime,
            savedLastDowntime: currentState.savedLastDowntime,
            lastKnownVersion: currentState.lastKnownVersion,
            isDown: currentState.isDown,
            apiDownSince: currentState.apiDownSince,
            previousRobloxVersion: currentState.previousRobloxVersion
        };
        
        localStorage.setItem('previousRobloxVersion', currentState.previousRobloxVersion);

        localStorage.setItem(STORAGE_KEY, JSON.stringify(dataToSave));

        try {
            await fetch(CACHE_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(dataToSave)
            });
        } catch (error) {
        }
    } catch (e) {
    }
}

async function loadCacheFromDB() {
    try {
        const response = await fetch(CACHE_API_URL);
        if (response.ok) {
            const cache = await response.json();
            return cache;
        }
    } catch (error) {
    }
    return null;
}

async function fetchWithFallback(endpoint) {

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

async function fetchRobloxVersion() {
    try {

        const response = await fetch(ROBLOX_API_URL);

        if (response.ok) {
            const data = await response.json();
            return data;
        }

        return await fetchWithFallback('/api/versions/current');

    } catch (error) {

        return await fetchWithFallback('/api/versions/current');
    }
}

async function fetchWaveStatus() {
    try {

        const response = await fetch(API_URL);

        if (response.ok) {
            const data = await response.json();
            return data;
        }

        return await fetchWithFallback('/api/status/exploits/wave');

    } catch (error) {

        return await fetchWithFallback('/api/status/exploits/wave');
    }
}

function parseApiDate(dateString) {

    try {
        const cleanDate = dateString.replace(' UTC', '').replace(',', '');
        return new Date(cleanDate + ' UTC').getTime();
    } catch (e) {
        return null;
    }
}

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

function formatTimer(milliseconds) {
    const totalSeconds = Math.floor(milliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function updateTimer() {
    const timerElement = document.getElementById('timer');

    if (currentState.isDown && currentState.apiDownSince) {
        const elapsed = Date.now() - currentState.apiDownSince;
        timerElement.textContent = formatTimer(elapsed);

        if (elapsed > currentState.longestDowntime) {
            currentState.longestDowntime = elapsed;
        }

        updateStatsDisplay();
    }
}

function updateStatsDisplay() {
    const lastDowntimeElement = document.getElementById('lastDowntime');
    const recordElement = document.getElementById('record');

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

async function updateUI(data) {
    const versionElement = document.getElementById('version');
    const statusTextElement = document.getElementById('statusText');
    const statusIndicatorElement = document.getElementById('statusIndicator');
    const timerSectionElement = document.getElementById('timerSection');
    const timerLabelElement = document.getElementById('timerLabel');

    const apiStatusSection = document.getElementById('apiStatusSection');
    const apiStatusMessage = document.getElementById('apiStatusMessage');

    if (!data) {

        currentState.apiAvailable = false;

        apiStatusSection.classList.remove('hidden');
        apiStatusMessage.textContent = '⚠️ WEAO API is currently unavailable - Using cached data from database';
        apiStatusMessage.className = 'api-status-message error';

        if (currentState.lastKnownVersion) {
            versionElement.textContent = currentState.lastKnownVersion;
        } else {
            versionElement.textContent = 'Unknown';
        }

        if (currentState.isDown) {
            statusTextElement.innerHTML = 'WAVE IS DOWN! <img src="warningemoji.webp" alt="Warning" class="status-emoji">';
            statusTextElement.className = 'status-text status-down';
            timerSectionElement.classList.remove('hidden');
            timerLabelElement.textContent = 'Down for';
            const warningEl = document.getElementById('downgradeWarning');
            const buttonEl = document.getElementById('downgradeButtonContainer');
            if (warningEl) {
                warningEl.style.display = 'block';
            } else {
            }
            if (buttonEl) {
                buttonEl.style.display = 'block';
            }

            if (currentState.apiDownSince) {
                updateTimer();
            }
        } else {
            const warningEl = document.getElementById('downgradeWarning');
            const buttonEl = document.getElementById('downgradeButtonContainer');
            if (warningEl) {
                warningEl.style.display = 'none';
            }
            if (buttonEl) {
                buttonEl.style.display = 'none';
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

    if (!currentState.apiAvailable) {

        apiStatusSection.classList.remove('hidden');
        apiStatusMessage.textContent = '✅ API reconnected successfully';
        apiStatusMessage.className = 'api-status-message success';
        setTimeout(() => {
            apiStatusSection.classList.add('hidden');
        }, 3000);
    } else {

        apiStatusSection.classList.add('hidden');
    }
    currentState.apiAvailable = true;

    if (data.version) {
        const wasUpdated = currentState.lastKnownVersion && currentState.lastKnownVersion !== data.version;
        currentState.lastKnownVersion = data.version;
        versionElement.textContent = data.version;

        if (wasUpdated && currentState.isDown) {

            const finalDowntime = currentState.apiDownSince ? Date.now() - currentState.apiDownSince : 0;

            currentState.lastDowntimeDuration = finalDowntime;

            if (finalDowntime > currentState.longestDowntime) {
                currentState.longestDowntime = finalDowntime;
            }

            await saveData();
        }
    } else {
        versionElement.textContent = currentState.lastKnownVersion || 'Unknown';
    }

    const isCurrentlyDown = data.updateStatus === false;

    const robloxData = await fetchRobloxVersion();
    if (robloxData && robloxData.WindowsDate) {
        const robloxTimestamp = parseApiDate(robloxData.WindowsDate);
        if (robloxTimestamp) {

            if (!currentState.apiDownSince || currentState.apiDownSince !== robloxTimestamp) {
                currentState.apiDownSince = robloxTimestamp;
            }
        }
    }

    if (isCurrentlyDown && !currentState.isDown) {
        // Save current Roblox version as previous before going down
        if (robloxData && robloxData.Windows) {
            currentState.previousRobloxVersion = robloxData.Windows;
            localStorage.setItem('previousRobloxVersion', robloxData.Windows);
        }
        
        currentState.isDown = true;
        currentState.downSince = Date.now();
        currentState.version = data.version;
    } else if (!isCurrentlyDown && currentState.isDown) {

        const finalDowntime = currentState.apiDownSince ? Date.now() - currentState.apiDownSince : 0;

        if (finalDowntime > 0) {

            currentState.savedLastDowntime = finalDowntime;

            if (finalDowntime > currentState.longestDowntime) {
                currentState.longestDowntime = finalDowntime;
            }

            currentState.lastDowntimeDuration = finalDowntime;
        }

        showWaveUpNotification();

        currentState.isDown = false;
        currentState.downSince = null;
        currentState.apiDownSince = null;
        await saveData();
        updateStatsDisplay();
    }

    if (isCurrentlyDown) {
        statusTextElement.innerHTML = 'WAVE IS DOWN! <img src="warningemoji.webp" alt="Warning" class="status-emoji">';
        statusTextElement.className = 'status-text status-down';
        timerSectionElement.classList.remove('hidden');
        timerLabelElement.textContent = 'Down for';
        const warningEl = document.getElementById('downgradeWarning');
        const buttonEl = document.getElementById('downgradeButtonContainer');
        if (warningEl) {
            warningEl.style.display = 'block';
        } else {
        }
        if (buttonEl) {
            buttonEl.style.display = 'block';
        }
        updateTimer();
    } else {
        statusTextElement.innerHTML = 'WAVE IS UP! <img src="happyemoji.webp" alt="Happy" class="status-emoji">';
        statusTextElement.className = 'status-text status-up';
        const warningEl = document.getElementById('downgradeWarning');
        const buttonEl = document.getElementById('downgradeButtonContainer');
        if (warningEl) {
            warningEl.style.display = 'none';
        }
        if (buttonEl) {
            buttonEl.style.display = 'none';
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

async function init() {
    await loadSavedData();

    const data = await fetchWaveStatus();
    await updateUI(data);

    setInterval(async () => {
        const data = await fetchWaveStatus();
        await updateUI(data);
    }, REFRESH_INTERVAL);

    setInterval(() => {
        if (currentState.isDown) {
            updateTimer();
        }
    }, 1000);

    setInterval(async () => {
        await saveData();
    }, 2 * 60 * 1000);
}

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

function initNotifications() {
    notificationAudio = document.getElementById('notificationAudio');
    const notificationBtn = document.getElementById('notificationBtn');

    if (notificationAudio) {
        notificationAudio.load();

        notificationAudio.addEventListener('error', (e) => {
        });
    }

    const savedPref = localStorage.getItem('notificationsEnabled');
    if (savedPref === 'true') {
        notificationsEnabled = true;
        notificationBtn.classList.add('active');
    }

    notificationBtn.addEventListener('click', async () => {
        if (!notificationsEnabled) {

            if ('Notification' in window) {
                const permission = await Notification.requestPermission();
                if (permission === 'granted') {
                    notificationsEnabled = true;
                    notificationBtn.classList.add('active');
                    localStorage.setItem('notificationsEnabled', 'true');

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

    if (notificationAudio) {
        notificationAudio.currentTime = 0;
        notificationAudio.volume = 1.0;

        const playPromise = notificationAudio.play();
        if (playPromise !== undefined) {
            playPromise.catch(err => {
            });
        }
    }

    if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('WAVE IS UP! 🎉', {
            body: 'Wave exploit is now available!',
            icon: 'wavebluelogo.webp',
            tag: 'wave-status-up',
            requireInteraction: true
        });
    }
}

function initSiteBrandingCopy() {
    const siteBranding = document.getElementById('siteBranding');
    if (!siteBranding) return;

    siteBranding.addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText('wavestatus.com');

            const originalTooltip = siteBranding.getAttribute('data-tooltip');

            siteBranding.setAttribute('data-tooltip', 'Copied!');

            setTimeout(() => {
                siteBranding.setAttribute('data-tooltip', originalTooltip);
            }, 2000);
        } catch (err) {
        }
    });
}

init();
initNotifications();
initSiteBrandingCopy();

document.addEventListener('DOMContentLoaded', () => {
    const warningEl = document.getElementById('downgradeWarning');
    const buttonEl = document.getElementById('downgradeButtonContainer');
    if (warningEl) {
        warningEl.style.display = 'block';
    } else {
    }
    if (buttonEl) {
        buttonEl.style.display = 'block';
    }
});