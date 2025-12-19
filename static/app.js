const bvidInput = document.getElementById('bvid');
const sessdataInput = document.getElementById('sessdata');
const buvid3Input = document.getElementById('buvid3');
const biliJctInput = document.getElementById('bili_jct');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const statusText = document.getElementById('statusText');
const targetTitle = document.getElementById('targetTitle');
const monitorBadge = document.getElementById('monitorBadge');
const commentList = document.getElementById('commentList');
const uploadBtn = document.getElementById('uploadBtn');
const cookieFile = document.getElementById('cookieFile');
const cookieStatus = document.getElementById('cookieStatus');

let ws = null;
let isRunning = false;

// Initialize WebSocket
function initWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);

    ws.onopen = () => {
        console.log("Connected to WS");
    };

    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
    };

    ws.onclose = () => {
        statusText.textContent = "连接断开，尝试重连...";
        setTimeout(initWebSocket, 3000);
    };
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'init':
            updateRunningState(msg.running);
            if (msg.title) targetTitle.textContent = msg.title;
            break;
        case 'status':
            statusText.textContent = msg.msg;
            if (msg.title) {
                targetTitle.textContent = msg.title;
            }
            if (msg.level === 'error') {
                statusText.style.color = '#ff4757';
                updateRunningState(false);
            } else if (msg.level === 'success') {
                statusText.style.color = '#2ecc71';
            } else {
                statusText.style.color = '#9499a0';
            }
            break;
        case 'new_comments':
            renderComments(msg.data);
            break;
        case 'clear_comments':
            commentList.innerHTML = '<div class="empty-state">正在加载评论...</div>';
            break;
    }
}

function updateRunningState(running) {
    isRunning = running;
    if (running) {
        startBtn.disabled = true;
        stopBtn.disabled = false;
        bvidInput.disabled = true;
        sessdataInput.disabled = true;
        monitorBadge.textContent = "MONITORING";
        monitorBadge.classList.add('active');
        // Clear empty state if it exists
        if (document.querySelector('.empty-state')) {
            commentList.innerHTML = '';
        }
    } else {
        startBtn.disabled = false;
        stopBtn.disabled = true;
        bvidInput.disabled = false;
        sessdataInput.disabled = false;
        monitorBadge.textContent = "OFFLINE";
        monitorBadge.classList.remove('active');
    }
}

function renderComments(comments) {
    // Reverse to show newest on top if prepending
    // Data comes in chronological (oldest -> newest), we want to prepend newest first.
    // So we iterate the list as is and prepend each one, effectively reversing them in the UI stack.
    comments.forEach(c => {
        const card = document.createElement('div');
        card.className = 'comment-card';
        card.innerHTML = `
            <img src="${c.avatar}" class="avatar" loading="lazy">
            <div class="content-wrapper">
                <div class="header">
                    <span class="username">${escapeHtml(c.user)}</span>
                    <span class="level">LV${c.level}</span>
                    <span class="time">${c.time}</span>
                </div>
                <div class="message">${escapeHtml(c.content)}</div>
            </div>
        `;
        commentList.prepend(card);
    });
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Cookie Handling

uploadBtn.addEventListener('click', () => cookieFile.click());

cookieFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const content = event.target.result;
            const json = JSON.parse(content);
            let cookies = {};

            // Handle EditThisCookie array format
            if (Array.isArray(json)) {
                json.forEach(c => cookies[c.name] = c.value);
            } else {
                cookies = json;
            }

            if (cookies.SESSDATA) {
                // Fill hidden inputs
                document.getElementById('sessdata').value = cookies.SESSDATA;
                document.getElementById('buvid3').value = cookies.buvid3 || "";
                document.getElementById('bili_jct').value = cookies.bili_jct || "";

                cookieStatus.style.display = 'block';
                cookieStatus.textContent = `✓ 已解析: SESSDATA, ${cookies.bili_jct ? 'bili_jct' : ''}`;
                uploadBtn.textContent = "✅ 已加载 " + file.name;
                uploadBtn.style.background = "#2ecc71";
            } else {
                alert("错误: JSON 中未找到 SESSDATA 字段");
            }
        } catch (err) {
            alert("JSON 解析失败: " + err);
        }
    };
    reader.readAsText(file);
});

// API Calls
// Load saved data on startup
const savedBvid = localStorage.getItem('bilibili_monitor_bvid');
const savedCookie = localStorage.getItem('bilibili_monitor_cookie');

if (savedBvid) {
    bvidInput.value = savedBvid;
}

if (savedCookie) {
    try {
        const parsed = JSON.parse(savedCookie);
        sessdataInput.value = parsed.sessdata || '';
        buvid3Input.value = parsed.buvid3 || '';
        biliJctInput.value = parsed.bili_jct || '';

        cookieStatus.style.display = 'block';
        cookieStatus.textContent = '✓ 已加载上次使用的 Cookie';
        cookieStatus.style.color = '#2ecc71';

        uploadBtn.textContent = "✅ 已恢复 Cookie";
        uploadBtn.style.background = "#2ecc71";
    } catch (e) {
        console.error('Failed to load saved cookie', e);
    }
}

startBtn.addEventListener('click', async () => {
    let bvid = bvidInput.value.trim();

    // Extract BVID from URL if full link is pasted
    // Regex matches BV followed by alphanumeric chars, ending at ? or / or end of string
    const bvMatch = bvid.match(/(BV[a-zA-Z0-9]+)/);
    if (bvMatch) {
        bvid = bvMatch[1];
        bvidInput.value = bvid; // Auto-correct input field
    }

    if (!bvid) {
        alert('请输入 BVID');
        return;
    }

    const sessdata = sessdataInput.value.trim();
    const buvid3 = buvid3Input.value.trim();
    const bili_jct = biliJctInput.value.trim();

    if (!sessdata) {
        alert('请先加载 Cookie JSON 文件');
        return;
    }

    // Save to localStorage
    localStorage.setItem('bilibili_monitor_bvid', bvid);
    localStorage.setItem('bilibili_monitor_cookie', JSON.stringify({
        sessdata, buvid3, bili_jct
    }));

    statusText.textContent = "正在启动...";
    try {
        const fetchSubComments = document.getElementById('fetchSubComments').checked;

        const response = await fetch('/api/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                bvid,
                sessdata,
                buvid3,
                bili_jct,
                fetch_sub_comments: fetchSubComments
            })
        });

        const data = await response.json();
        if (data.status === 'started') {
            updateRunningState(true);
        } else if (data.status === 'already_running') {
            alert("监控已在运行中");
        } else {
            updateRunningState(false);
            statusText.textContent = `启动失败: ${data.message || '未知错误'}`;
            statusText.style.color = '#ff4757';
        }
    } catch (error) {
        console.error('Error:', error);
        updateRunningState(false);
        statusText.textContent = '连接后端失败';
        statusText.style.color = '#ff4757';
    }
});

stopBtn.addEventListener('click', async () => {
    try {
        await fetch('/api/stop', { method: 'POST' });
        updateRunningState(false);
        statusText.textContent = "已手动停止";
    } catch (e) {
        console.error(e);
    }
});

// Start
initWebSocket();
