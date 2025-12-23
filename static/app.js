let socket = null;
let accountPool = []; // 存储 Cookie 对象的数组

// DOM 元素引用
const dom = {
    bvid: document.getElementById('bvid'),
    cookieFile: document.getElementById('cookie-file'),
    importBtn: document.getElementById('import-btn'),
    fileName: document.getElementById('file-name'),
    accountList: document.getElementById('account-list'),
    poolCount: document.getElementById('pool-count'),
    clearPoolBtn: document.getElementById('clear-pool-btn'),
    btnStart: document.getElementById('start-btn'),
    btnStop: document.getElementById('stop-btn'),
    status: document.getElementById('status-indicator'),
    commentsContainer: document.getElementById('comments-container'),
    fetchSub: document.getElementById('fetch_sub'),
    btnClear: document.getElementById('clear-log')
};

// ================= 账号池逻辑 =================

// 从 localStorage 加载账号池
function loadAccountPool() {
    try {
        const saved = localStorage.getItem('bilibili_cookie_pool');
        if (saved) {
            accountPool = JSON.parse(saved);
            console.log(`从本地加载了 ${accountPool.length} 个账号`);
        }
    } catch (e) {
        console.error('加载账号池失败:', e);
    }
}

// 保存账号池到 localStorage
function saveAccountPool() {
    try {
        localStorage.setItem('bilibili_cookie_pool', JSON.stringify(accountPool));
    } catch (e) {
        console.error('保存账号池失败:', e);
    }
}

function updateAccountListUI() {
    dom.accountList.innerHTML = '';
    dom.poolCount.textContent = `(${accountPool.length} 个账号)`;

    if (accountPool.length === 0) {
        dom.accountList.innerHTML = '<div class="empty-tip">暂无账号，请导入 Cookie 文件</div>';
        dom.clearPoolBtn.style.display = 'none';
        return;
    }

    dom.clearPoolBtn.style.display = 'block';

    accountPool.forEach((acc, index) => {
        const card = document.createElement('div');
        card.className = 'account-card';

        // 简单的掩码处理，只显示前10位
        const maskSess = acc.sessdata.length > 10
            ? acc.sessdata.substring(0, 10) + '...'
            : acc.sessdata;

        card.innerHTML = `
            <div class="account-info">
                <span class="account-index">#${index + 1}</span>
                <span class="sess-mask">SESSDATA: ${maskSess}</span>
            </div>
            <button class="remove-btn" onclick="removeAccount(${index})">删除</button>
        `;
        dom.accountList.appendChild(card);
    });
}

// 暴露给全局以便 HTML onclick 调用
window.removeAccount = function (index) {
    accountPool.splice(index, 1);
    saveAccountPool();
    updateAccountListUI();
    if (accountPool.length === 0) {
        dom.fileName.textContent = '';
    }
};

// ================= Cookie 文件解析逻辑 =================

// 从浏览器导出的 Cookie 数组中提取指定 name 的 value
function extractCookieValue(cookieArray, cookieName) {
    const cookie = cookieArray.find(c => c.name && c.name.toUpperCase() === cookieName.toUpperCase());
    return cookie ? cookie.value : '';
}

// 判断是否是浏览器导出的 Cookie 格式（每个对象有 name 和 value 字段）
function isBrowserCookieFormat(data) {
    if (!Array.isArray(data) || data.length === 0) return false;
    // 检查第一个对象是否有 name 和 value 字段
    return data[0].name !== undefined && data[0].value !== undefined;
}

// 文件导入按钮点击
dom.importBtn.addEventListener('click', () => {
    dom.cookieFile.click();
});

// 文件选择处理
dom.cookieFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
        try {
            const data = JSON.parse(event.target.result);

            // 验证数据格式
            if (!Array.isArray(data)) {
                throw new Error("文件内容必须是 JSON 数组格式");
            }

            // 追加到现有账号池（不清空）
            let validCount = 0;

            // 检测文件格式
            if (isBrowserCookieFormat(data)) {
                // 格式1: 浏览器插件导出的格式 [{name: "SESSDATA", value: "xxx"}, ...]
                // 这种格式整个文件代表一个账号的所有 Cookie
                console.log("检测到浏览器导出的 Cookie 格式");

                const sessdata = extractCookieValue(data, 'SESSDATA');
                const buvid3 = extractCookieValue(data, 'buvid3');
                const bili_jct = extractCookieValue(data, 'bili_jct');

                if (sessdata) {
                    accountPool.push({
                        sessdata: sessdata,
                        buvid3: buvid3,
                        bili_jct: bili_jct
                    });
                    validCount = 1;
                } else {
                    throw new Error("Cookie 文件中未找到 SESSDATA");
                }
            } else {
                // 格式2: 我们定义的多账号格式 [{sessdata: "xxx", buvid3: "yyy"}, ...]
                console.log("检测到多账号 Cookie 格式");

                data.forEach((item, idx) => {
                    if (item.sessdata && typeof item.sessdata === 'string') {
                        accountPool.push({
                            sessdata: item.sessdata.trim(),
                            buvid3: (item.buvid3 || '').trim(),
                            bili_jct: (item.bili_jct || '').trim()
                        });
                        validCount++;
                    } else {
                        console.warn(`第 ${idx + 1} 条记录缺少 sessdata，已跳过`);
                    }
                });
            }

            if (validCount === 0) {
                throw new Error("文件中没有有效的账号数据（需要 SESSDATA）");
            }

            // 保存并更新 UI
            saveAccountPool();
            dom.fileName.textContent = `✅ ${file.name} (${validCount} 个账号)`;
            updateAccountListUI();

            alert(`成功导入 ${validCount} 个账号！`);

        } catch (err) {
            alert(`导入失败: ${err.message}`);
            console.error('解析 Cookie 文件失败:', err);
        }
    };

    reader.onerror = () => {
        alert("读取文件失败");
    };

    reader.readAsText(file);

    // 重置 input 以便可以重复选择同一文件
    e.target.value = '';
});

// 清空账号池
dom.clearPoolBtn.addEventListener('click', () => {
    if (!confirm("确定要清空所有账号吗？")) return;
    accountPool = [];
    saveAccountPool();
    dom.fileName.textContent = '';
    updateAccountListUI();
});

// ================= WebSocket & 监控逻辑 =================

function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/ws`;

    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
        console.log("WS Connected");
    };

    socket.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        handleMessage(msg);
    };

    socket.onclose = () => {
        console.log("WS Closed, retrying in 3s...");
        dom.status.className = 'status-offline';
        dom.status.textContent = '连接断开';
        setTimeout(initWebSocket, 3000);
    };
}

function handleMessage(msg) {
    switch (msg.type) {
        case 'init':
            updateRunningState(msg.running);
            if (msg.running && msg.title) {
                dom.status.textContent = `监控中: ${msg.title}`;
            }
            break;
        case 'status':
            dom.status.textContent = msg.msg;
            if (msg.level === 'success') dom.status.className = 'status-active';
            if (msg.level === 'error') dom.status.className = 'status-offline';

            appendSystemLog(msg.msg, msg.level);
            break;
        case 'new_comments':
            msg.data.forEach(comment => {
                appendComment(comment);
            });
            break;
        case 'clear_comments':
            dom.commentsContainer.innerHTML = '';
            break;
    }
}

function appendComment(c) {
    const div = document.createElement('div');
    div.className = 'comment-item';
    div.innerHTML = `
        <div class="comment-time">${c.time.split(' ')[1] || c.time}</div>
        <div class="comment-user">
            <span class="lv-badge">LV${c.level}</span>${c.user}
        </div>
        <div class="comment-content">${c.content}</div>
    `;
    dom.commentsContainer.prepend(div);
}

function appendSystemLog(text, level) {
    const div = document.createElement('div');
    div.style.padding = "5px 0";
    div.style.color = level === 'error' ? 'red' : (level === 'success' ? 'green' : '#666');
    div.style.fontSize = "12px";
    div.style.textAlign = "center";
    div.textContent = `--- ${text} ---`;
    dom.commentsContainer.prepend(div);
}

function updateRunningState(isRunning) {
    if (isRunning) {
        dom.btnStart.disabled = true;
        dom.btnStop.disabled = false;
        dom.status.className = 'status-active';
        dom.bvid.disabled = true;
        dom.importBtn.disabled = true;
        dom.clearPoolBtn.disabled = true;
    } else {
        dom.btnStart.disabled = false;
        dom.btnStop.disabled = true;
        dom.status.className = 'status-offline';
        dom.status.textContent = '就绪';
        dom.bvid.disabled = false;
        dom.importBtn.disabled = false;
        dom.clearPoolBtn.disabled = false;
    }
}

// ================= 按钮事件 =================

// 从 URL 或纯 BVID 中提取 BVID
function extractBvid(input) {
    // 如果已经是纯 BVID 格式
    if (/^BV[a-zA-Z0-9]+$/i.test(input)) {
        return input;
    }
    // 尝试从 URL 中提取 BV 号
    const match = input.match(/BV[a-zA-Z0-9]+/i);
    return match ? match[0] : null;
}

dom.btnStart.addEventListener('click', async () => {
    const rawInput = dom.bvid.value.trim();
    if (!rawInput) return alert("请输入 BVID 或视频链接");

    const bvid = extractBvid(rawInput);
    if (!bvid) return alert("无法识别 BVID，请输入正确的 BV 号或视频链接");

    if (accountPool.length === 0) return alert("请先导入 Cookie 文件！");

    dom.btnStart.disabled = true;

    try {
        const res = await fetch('/api/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bvid: bvid,
                fetch_sub_comments: dom.fetchSub.checked,
                cookies: accountPool
            })
        });
        const data = await res.json();
        if (data.status === 'started') {
            updateRunningState(true);
        } else {
            alert("启动失败: " + JSON.stringify(data));
            dom.btnStart.disabled = false;
        }
    } catch (e) {
        alert("请求错误: " + e);
        dom.btnStart.disabled = false;
    }
});

dom.btnStop.addEventListener('click', async () => {
    if (!confirm("确定停止监控吗？")) return;
    try {
        await fetch('/api/stop', { method: 'POST' });
        updateRunningState(false);
    } catch (e) {
        alert("停止失败");
    }
});

dom.btnClear.addEventListener('click', () => {
    dom.commentsContainer.innerHTML = '';
});

// 启动 WebSocket
initWebSocket();

// 从 localStorage 加载账号池
loadAccountPool();

// 初始化列表
updateAccountListUI();
