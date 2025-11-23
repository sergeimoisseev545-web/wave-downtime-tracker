let socket;
let currentUser = null;
let isAdmin = false;
let messageCooldown = false;
let browserFingerprint = null;
let currentDeviceCode = null;
let blurTimeout = null;

function setCookie(name, value, days = 365) {
    const expires = new Date();
    expires.setTime(expires.getTime() + days * 24 * 60 * 60 * 1000);
    const isSecure = window.location.protocol === 'https:';
    const sameSite = isSecure ? 'SameSite=None;Secure' : 'SameSite=Lax';
    document.cookie = `${name}=${value};expires=${expires.toUTCString()};path=/;${sameSite}`;
}

function getCookie(name) {
    const nameEQ = name + '=';
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) === ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
    }
    return null;
}

function deleteCookie(name) {
    const isSecure = window.location.protocol === 'https:';
    const sameSite = isSecure ? 'SameSite=None;Secure' : 'SameSite=Lax';
    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 UTC;path=/;${sameSite}`;
}

function saveSessionToken(token) {
    try {
        setCookie('chatSession', token, 365);
        localStorage.setItem('chatSessionToken', token);
        sessionStorage.setItem('chatSessionToken', token);
    } catch (error) {

    }
}

function getSessionToken() {
    try {
        const fromCookie = getCookie('chatSession');
        const fromLocal = localStorage.getItem('chatSessionToken');
        const fromSession = sessionStorage.getItem('chatSessionToken');
        const token = fromCookie || fromLocal || fromSession;

        if (token && (!fromCookie || !fromLocal || !fromSession)) {
            saveSessionToken(token);
        }

        return token;
    } catch (error) {
        return null;
    }
}

function deleteSessionToken() {
    try {
        deleteCookie('chatSession');
        localStorage.removeItem('chatSessionToken');
        sessionStorage.removeItem('chatSessionToken');
    } catch (error) {

    }
}

const systemMessageQueue = [];
let activeSystemMessages = 0;
const MAX_CONCURRENT_SYSTEM_MESSAGES = 3;
let isProcessingQueue = false;

async function generateFingerprint() {
    const components = [];

    try {
        components.push((screen?.width || 0) + 'x' + (screen?.height || 0));
        components.push(screen?.colorDepth || 0);
        components.push(new Date().getTimezoneOffset());
        components.push(navigator?.language || 'unknown');
        components.push(navigator?.platform || 'unknown');
        components.push(navigator?.userAgent || 'unknown');
        components.push(navigator?.hardwareConcurrency || 'unknown');
        components.push(navigator?.deviceMemory || 'unknown');
        components.push(navigator?.maxTouchPoints || 0);
    } catch (e) {

    }

    try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillStyle = '#f60';
        ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('Browser Fingerprint', 2, 15);
        components.push(canvas.toDataURL());
    } catch (e) {
        components.push('canvas-error');
    }

    try {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        if (gl) {
            const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
            if (debugInfo) {
                components.push(gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL));
                components.push(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL));
            }
        }
    } catch (e) {
        components.push('webgl-error');
    }

    const fingerprintString = components.join('|');
    const encoder = new TextEncoder();
    const data = encoder.encode(fingerprintString);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    return hashHex;
}

async function initializeChat() {
    try {
        browserFingerprint = await generateFingerprint();
    } catch (error) {
        browserFingerprint = 'fallback-' + Date.now() + '-' + Math.random();
    }

    let serverUrl;

    if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        serverUrl = 'http://localhost:3000';
    } else {
        serverUrl = 'https://wave-chat-server.onrender.com';
    }

    try {
        socket = io(serverUrl, {
            transports: ['websocket', 'polling'],
            reconnection: true,
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
            timeout: 20000,
            withCredentials: true
        });

        setupSocketListeners();
    } catch (error) {
        alert('Failed to initialize chat');
    }
}

function setupSocketListeners() {
    socket.on('connect', () => {
        if (browserFingerprint) {
            socket.emit('setFingerprint', browserFingerprint);
        }

        loadSavedNickname();
    });

    socket.on('connect_error', (error) => {

    });

    socket.on('connect_timeout', () => {

    });

    socket.on('error', (error) => {

    });

    socket.on('disconnect', (reason) => {

    });

    socket.on('userJoined', (data) => {
        showSystemMessage(`${data.nickname} joined the chat`, 'join');
        updateOnlineCount(data.onlineCount);
    });

    socket.on('userLeft', (data) => {
        if (data.banned) {
            showSystemMessage(`${data.nickname} banned from chat`, 'banned');
        } else {
            showSystemMessage(`${data.nickname} left the chat`, 'leave');
        }
        updateOnlineCount(data.onlineCount);
    });

    socket.on('message', (data) => {
        displayMessage(data);
    });

    socket.on('messageHistory', (messages) => {
        const chatMessages = document.getElementById('chatMessages');
        chatMessages.innerHTML = '';
        messages.forEach(msg => displayMessage(msg));
        scrollToBottom();
    });

    socket.on('onlineCount', (count) => {
        updateOnlineCount(count);
    });

    socket.on('error', (error) => {
        showError(error.message);
    });

    socket.on('nicknameAccepted', (data) => {
        currentUser = data.user;
        isAdmin = data.isAdmin;

        if (data.sessionToken) {
            saveSessionToken(data.sessionToken);

            setTimeout(() => {
                const savedToken = getSessionToken();
                if (savedToken !== data.sessionToken) {
                    saveSessionToken(data.sessionToken);
                }
            }, 100);
        }

        if (data.deviceCode) {
            currentDeviceCode = data.deviceCode;
            updateDeviceCodeDisplay(data.deviceCode);
        } else {
            currentDeviceCode = null;
            updateDeviceCodeDisplay(null);
        }

        document.getElementById('welcomeNickname').textContent = data.user.nickname;
        showChatInterface();
        if (isAdmin && !data.isRejoin && !data.isDeviceLogin) {
            showSystemMessage('You are now the chat administrator! You can ban users.', 'admin');
        }
        if (data.isDeviceLogin) {
            showSystemMessage('Logged in from another device successfully! Your device code has been deleted for security.', 'info');
        }
    });

    socket.on('sessionValid', (data) => {
        if (data && data.userId && data.nickname) {
            if (data.sessionToken) {
                saveSessionToken(data.sessionToken);
            }

            const sessionToken = getSessionToken();
            if (sessionToken) {
                socket.emit('rejoin', {
                    sessionToken: sessionToken
                });
            }
        }
    });

    socket.on('invalidSession', () => {
        deleteSessionToken();
        showNicknameSetup();
    });

    socket.on('banned', () => {
        showError('You have been banned from the chat');
        deleteSessionToken();
        currentUser = null;
        isAdmin = false;
        document.getElementById('welcomeNickname').textContent = '';
        showNicknameSetup();
    });

    socket.on('deviceCodeGenerated', (data) => {
        if (data.deviceCode) {
            currentDeviceCode = data.deviceCode;
            updateDeviceCodeDisplay(data.deviceCode);
            showSystemMessage('Device code generated successfully! Click to reveal.', 'info');
        }
    });

    socket.on('deviceCodeDeleted', (data) => {
        currentDeviceCode = null;
        updateDeviceCodeDisplay(null);
        showSystemMessage(`Device Code deleted: ${data.reason}`, 'info');
    });

    socket.on('messageDeleted', (messageId) => {
        const messageElement = document.querySelector(`[data-message-id="${messageId}"]`);
        if (messageElement) {
            messageElement.remove();
        }
    });
}

function loadSavedNickname() {
    const sessionToken = getSessionToken();

    if (sessionToken) {
        socket.emit('rejoin', {
            sessionToken: sessionToken
        });
    }
}

function saveNickname(nickname, userId, avatarHue) {

}

function clearNickname() {
    deleteSessionToken();
    currentUser = null;
    isAdmin = false;
    document.getElementById('welcomeNickname').textContent = '';
}

function validateNickname(nickname) {
    const englishOnly = /^[a-zA-Z0-9_]+$/;

    if (!nickname || nickname.trim().length < 3) {
        return 'Nickname must be at least 3 characters';
    }

    if (nickname.length > 20) {
        return 'Nickname must be at most 20 characters';
    }

    if (!englishOnly.test(nickname)) {
        return 'Nickname must contain only English letters, numbers, and underscores';
    }

    return null;
}

function showNicknameSetup() {
    document.getElementById('nicknameSetup').classList.remove('hidden');
    document.getElementById('chatWelcome').classList.add('hidden');
    document.getElementById('chatContainer').classList.add('hidden');
}

function showChatInterface() {
    const nicknameSetup = document.getElementById('nicknameSetup');
    const chatWelcome = document.getElementById('chatWelcome');
    const chatContainer = document.getElementById('chatContainer');
    const sendBtn = document.getElementById('sendMessageBtn');
    const messageInput = document.getElementById('messageInput');

    if (!nicknameSetup || !chatWelcome || !chatContainer) {
        alert('Error: Chat elements not found. Please refresh the page.');
        return;
    }

    nicknameSetup.style.cssText = 'display: none !important; visibility: hidden !important; height: 0 !important; overflow: hidden !important; opacity: 0 !important; position: absolute !important;';
    nicknameSetup.classList.add('hidden');
    nicknameSetup.setAttribute('aria-hidden', 'true');

    chatWelcome.style.cssText = 'display: flex !important; visibility: visible !important; opacity: 1 !important;';
    chatWelcome.classList.remove('hidden');
    chatWelcome.setAttribute('aria-hidden', 'false');

    const welcomeLeft = document.getElementById('welcomeLeft');
    if (welcomeLeft) {
        welcomeLeft.classList.remove('hidden');
        welcomeLeft.style.display = 'block';
    }

    chatContainer.classList.remove('hidden');
    chatContainer.style.cssText = 'display: flex !important; visibility: visible !important; opacity: 1 !important; flex-direction: column !important;';

    if (sendBtn) {
        sendBtn.disabled = false;
        sendBtn.style.pointerEvents = 'auto';
    }

    if (messageInput) {
        messageInput.disabled = false;
    }
}

function showError(message) {

    if (currentUser) {

        const chatErrorElement = document.getElementById('chatErrorMessage');
        chatErrorElement.textContent = message;
        chatErrorElement.classList.remove('hidden');
        setTimeout(() => {
            chatErrorElement.classList.add('hidden');
        }, 5000);
    } else {

        const errorElement = document.getElementById('nicknameError');
        errorElement.textContent = message;
        errorElement.style.display = 'block';
        setTimeout(() => {
            errorElement.style.display = 'none';
        }, 3000);
    }
}

function updateOnlineCount(count) {
    document.getElementById('onlineCount').textContent = count;
}

function displayMessage(data) {
    const chatMessages = document.getElementById('chatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'chat-message';
    messageDiv.setAttribute('data-message-id', data.id);

    if (data.type === 'system') {
        messageDiv.classList.add('system-message');
        if (data.subType === 'join') {
            messageDiv.classList.add('system-join');
        } else if (data.subType === 'leave') {
            messageDiv.classList.add('system-leave');
        } else if (data.subType === 'banned') {
            messageDiv.classList.add('system-banned');
        }
        messageDiv.innerHTML = `<span class="system-text">${escapeHtml(data.message)}</span>`;

        setTimeout(() => {
            if (messageDiv && messageDiv.parentNode) {
                messageDiv.style.transition = 'opacity 0.3s ease-out';
                messageDiv.style.opacity = '0';
                setTimeout(() => {
                    if (messageDiv.parentNode) {
                        messageDiv.remove();
                    }
                }, 300);
            }
        }, 3000);
    } else {
        const isOwnMessage = currentUser && data.userId === currentUser.id;
        if (isOwnMessage) {
            messageDiv.classList.add('own-message');
        }

        const isMefisto = data.nickname.toLowerCase() === 'mefisto';
        const avatarStyle = `filter: hue-rotate(${data.avatarHue}deg) saturate(1.5);`;

        const avatarHTML = isMefisto
            ? `<video src="mefistoavatar.mp4" class="chat-avatar-video" autoplay loop muted playsinline></video>`
            : `<img src="userschaticons.png" class="chat-avatar" style="${avatarStyle}" alt="${escapeHtml(data.nickname)}">`;

        messageDiv.innerHTML = `
            ${avatarHTML}
            <div class="message-content">
                <div class="message-header">
                    <span class="message-nickname">${escapeHtml(data.nickname)}${isMefisto ? '<span class="admin-crown">👑</span>' : ''}</span>
                    <span class="message-time">${formatTime(data.timestamp)}</span>
                    ${isAdmin && !isOwnMessage ? `<button class="ban-button" onclick="banUser('${data.userId}', '${escapeHtml(data.nickname)}')">Ban</button>` : ''}
                </div>
                <div class="message-text">${linkifyDowngrade(data.message)}</div>
            </div>
        `;
    }

    chatMessages.appendChild(messageDiv);
    scrollToBottom();
}

function showSystemMessage(message, type = 'info') {
    const systemMsg = {
        id: Date.now() + Math.random(),
        type: 'system',
        subType: type,
        message: message,
        timestamp: Date.now()
    };

    systemMessageQueue.push(systemMsg);

    processSystemMessageQueue();
}

function processSystemMessageQueue() {

    if (isProcessingQueue || activeSystemMessages >= MAX_CONCURRENT_SYSTEM_MESSAGES) {
        return;
    }

    if (systemMessageQueue.length === 0) {
        return;
    }

    isProcessingQueue = true;

    const message = systemMessageQueue.shift();

    activeSystemMessages++;

    displayMessage(message);

    setTimeout(() => {
        activeSystemMessages--;
        isProcessingQueue = false;
        processSystemMessageQueue();
    }, 3100);

    isProcessingQueue = false;
}

function scrollToBottom() {
    const chatMessages = document.getElementById('chatMessages');
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function linkifyDowngrade(text) {

    const escapedText = escapeHtml(text);

    const downgradeRegex = /\b(downgrad(e|ed|es|ing))\b/gi;

    return escapedText.replace(downgradeRegex, '<a href="/downgrade" class="downgrade-link" target="_blank">$1</a>');
}

function formatTime(timestamp) {
    const date = new Date(timestamp);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
}

document.getElementById('setNicknameBtn').addEventListener('click', () => {
    const nickname = document.getElementById('nicknameInput').value.trim();
    const error = validateNickname(nickname);

    if (error) {
        showError(error);
        return;
    }

    socket.emit('setNickname', nickname);
});

document.getElementById('nicknameInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        document.getElementById('setNicknameBtn').click();
    }
});

const sendBtn = document.getElementById('sendMessageBtn');
sendBtn.addEventListener('click', sendMessage);
sendBtn.addEventListener('touchstart', (e) => {
    e.preventDefault();
    sendMessage();
}, { passive: false });

document.getElementById('messageInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && (!messageCooldown || isAdmin)) {
        sendMessage();
    }
});

function sendMessage() {
    if (messageCooldown && !isAdmin) {
        return;
    }

    const messageInput = document.getElementById('messageInput');
    const message = messageInput.value.trim();

    if (!message || message.length > 100) {
        return;
    }

    if (!socket || !socket.connected) {
        showError('Not connected to chat server');
        return;
    }

    if (!currentUser) {
        showError('You must set a nickname first');
        return;
    }

    socket.emit('message', message);
    messageInput.value = '';

    if (!isAdmin) {
        startCooldown();
    }
}

function startCooldown() {
    messageCooldown = true;
    const cooldownElement = document.getElementById('messageCooldown');
    const sendButton = document.getElementById('sendMessageBtn');
    const messageInput = document.getElementById('messageInput');

    sendButton.disabled = true;
    messageInput.disabled = true;

    let timeLeft = 5;
    cooldownElement.textContent = `Wait ${timeLeft}s`;
    cooldownElement.style.display = 'block';

    const interval = setInterval(() => {
        timeLeft--;
        if (timeLeft > 0) {
            cooldownElement.textContent = `Wait ${timeLeft}s`;
        } else {
            clearInterval(interval);
            cooldownElement.style.display = 'none';
            messageCooldown = false;
            sendButton.disabled = false;
            messageInput.disabled = false;
        }
    }, 1000);
}

function banUser(userId, nickname) {
    if (!isAdmin) return;

    if (confirm(`Ban ${nickname} permanently? This will delete all their messages.`)) {
        socket.emit('banUser', userId);
    }
}

function updateDeviceCodeDisplay(code) {
    const deviceCodeElement = document.getElementById('deviceCodeValue');
    if (deviceCodeElement) {
        if (code) {
            deviceCodeElement.textContent = code;
            deviceCodeElement.classList.add('blurred');
            deviceCodeElement.classList.remove('revealed');
            deviceCodeElement.style.cursor = 'pointer';
        } else {
            deviceCodeElement.textContent = 'Not generated';
            deviceCodeElement.classList.remove('blurred', 'revealed');
            deviceCodeElement.style.cursor = 'default';
            deviceCodeElement.style.filter = 'none';
        }
    }
}

function toggleDeviceCodeBlur() {
    if (!currentDeviceCode) {
        showSystemMessage('Generate a device code first!', 'info');
        return;
    }

    const deviceCodeElement = document.getElementById('deviceCodeValue');
    if (!deviceCodeElement) return;

    deviceCodeElement.classList.remove('blurred');
    deviceCodeElement.classList.add('revealed');

    if (blurTimeout) {
        clearTimeout(blurTimeout);
    }

    blurTimeout = setTimeout(() => {
        deviceCodeElement.classList.remove('revealed');
        deviceCodeElement.classList.add('blurred');
    }, 3000);
}

function copyDeviceCode() {
    if (!currentDeviceCode) {
        showSystemMessage('Generate a device code first!', 'info');
        return;
    }

    navigator.clipboard.writeText(currentDeviceCode).then(() => {
        showSystemMessage('Device code copied to clipboard!', 'info');
    }).catch(err => {
        showError('Failed to copy device code');
    });
}

function generateDeviceCode() {
    if (!socket || !socket.connected) {
        showError('Not connected to server');
        return;
    }

    socket.emit('generateDeviceCode');
}

document.addEventListener('DOMContentLoaded', () => {
    try {
        initializeChat();
    } catch (error) {
        alert('Chat initialization failed');
    }

    const deviceCodeValue = document.getElementById('deviceCodeValue');
    const copyBtn = document.getElementById('copyDeviceCodeBtn');
    const generateBtn = document.getElementById('generateDeviceCodeBtn');

    if (deviceCodeValue) {
        deviceCodeValue.addEventListener('click', toggleDeviceCodeBlur);
    }

    if (copyBtn) {
        copyBtn.addEventListener('click', copyDeviceCode);
    }

    if (generateBtn) {
        generateBtn.addEventListener('click', generateDeviceCode);
    }

    window.addEventListener('beforeunload', () => {
        if (socket && socket.connected) {
            socket.disconnect();
        }
    });
});