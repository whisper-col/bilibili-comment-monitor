import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { basicAuth } from 'hono/basic-auth'
import { MongoClient, Db } from 'mongodb'

// 定义环境变量类型
type Bindings = {
    MONGO_URI: string;
    AUTH_USER: string;
    AUTH_PASSWORD: string;
    GITHUB_TOKEN: string;
    GITHUB_REPO: string;
}

// ==================== MongoDB 连接管理 ====================
// 在 Cloudflare Workers 中，每个请求新建连接更可靠

/**
 * 获取数据库实例（每次新建连接，使用完毕后需要释放）
 */
async function getDb(mongoUri: string, dbName: string = 'bilibili_monitor'): Promise<Db> {
    const client = new MongoClient(mongoUri, {
        autoEncryption: undefined,
        monitorCommands: false,
        connectTimeoutMS: 10000,
        serverSelectionTimeoutMS: 10000,
        maxPoolSize: 1,
    } as any);

    await client.connect();
    return client.db(dbName);
}

const app = new Hono<{ Bindings: Bindings }>()

// 启用 CORS
app.use('*', cors())

// 不需要认证的路由（主页和登录页由前端 JS 处理认证检查）
const publicRoutes = ['/', '/api/auth/login', '/api/auth/check', '/login', '/meta.json', '/config'];

// Basic Auth 认证（保护 API 路由）
app.use('*', async (c, next) => {
    const authUser = c.env?.AUTH_USER as string;
    const authPassword = c.env?.AUTH_PASSWORD as string;
    const path = new URL(c.req.url).pathname;

    // 公开路由不需要认证
    if (publicRoutes.some(r => path === r || path.startsWith(r))) {
        return next();
    }

    // 如果没有配置认证信息，跳过认证（方便开发测试）
    if (!authUser || !authPassword) {
        return next();
    }

    // 检查是否有 Authorization header
    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
        // API 路由未认证 → 返回 401 JSON
        return c.json({ code: 401, msg: '需要登录' }, 401);
    }

    // 使用 Basic Auth
    const auth = basicAuth({
        username: authUser,
        password: authPassword,
    });
    return auth(c, next);
})

// ==================== 评论监控 WebUI API ====================

// 获取视频列表
app.get('/api/videos', async (c) => {
    const mongoUri = c.env?.MONGO_URI as string;
    if (!mongoUri) {
        return c.json({ code: 500, msg: 'MONGO_URI not configured' });
    }

    try {
        const db = await getDb(mongoUri);
        const videos = await db.collection('video_metadata')
            .find({})
            .sort({ last_updated: -1 })
            .limit(50)
            .toArray();

        return c.json({
            code: 0,
            data: videos.map(v => ({
                bvid: v.bvid,
                title: v.title,
                oid: v.oid,
                comment_count: v.comment_count,
                last_updated: v.last_updated
            }))
        });
    } catch (e: any) {
        return c.json({ code: 500, msg: e.message });
    }
});

// 获取指定视频的评论
app.get('/api/comments/:bvid', async (c) => {
    const mongoUri = c.env?.MONGO_URI as string;
    if (!mongoUri) {
        return c.json({ code: 500, msg: 'MONGO_URI not configured' });
    }

    const bvid = c.req.param('bvid');
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');

    try {
        const db = await getDb(mongoUri);
        const collName = `comments_${bvid}`;

        // 获取评论总数
        const total = await db.collection(collName).countDocuments();

        // 获取评论列表（按时间倒序）
        const comments = await db.collection(collName)
            .find({})
            .sort({ ctime: -1 })
            .skip(offset)
            .limit(Math.min(limit, 100))
            .toArray();

        return c.json({
            code: 0,
            data: {
                total,
                comments: comments.map(c => ({
                    rpid: c.rpid,
                    user: c.user,
                    mid: c.mid,
                    content: c.content,
                    ctime: c.ctime,
                    time: new Date(c.ctime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
                    level: c.level,
                    likes: c.likes,
                    rcount: c.rcount,
                    sex: c.sex,
                    location: c.location,
                    fans_medal: c.fans_medal,
                    parent: c.parent,
                    root: c.root
                }))
            }
        });
    } catch (e: any) {
        return c.json({ code: 500, msg: e.message });
    }
});

// 获取视频详情（包括最新评论）
app.get('/api/video/:bvid', async (c) => {
    const mongoUri = c.env?.MONGO_URI as string;
    if (!mongoUri) {
        return c.json({ code: 500, msg: 'MONGO_URI not configured' });
    }

    const bvid = c.req.param('bvid');

    try {
        const db = await getDb(mongoUri);

        // 获取视频元数据
        const metadata = await db.collection('video_metadata').findOne({ bvid });

        // 获取最新20条评论
        const collName = `comments_${bvid}`;
        const recentComments = await db.collection(collName)
            .find({})
            .sort({ ctime: -1 })
            .limit(20)
            .toArray();

        return c.json({
            code: 0,
            data: {
                video: metadata ? {
                    bvid: metadata.bvid,
                    title: metadata.title,
                    oid: metadata.oid,
                    comment_count: metadata.comment_count,
                    last_updated: metadata.last_updated
                } : null,
                recent_comments: recentComments.map(c => ({
                    rpid: c.rpid,
                    user: c.user,
                    mid: c.mid,
                    content: c.content,
                    ctime: c.ctime,
                    time: new Date(c.ctime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
                    level: c.level,
                    likes: c.likes
                }))
            }
        });
    } catch (e: any) {
        return c.json({ code: 500, msg: e.message });
    }
});


// ==================== Cookie 池管理 API ====================

// 获取 Cookie 池（脱敏）
app.get('/api/cookies', async (c) => {
    const mongoUri = c.env?.MONGO_URI as string;
    if (!mongoUri) return c.json({ code: 500, msg: 'MONGO_URI not configured' });
    try {
        const db = await getDb(mongoUri);
        const cookies = await db.collection('cookie_pool').find({}).toArray();
        return c.json({ code: 0, data: cookies.map((c: any, i: number) => ({ index: i, sessdata_mask: c.sessdata ? c.sessdata.substring(0, 10) + '...' : '', created_at: c.created_at })) });
    } catch (e: any) { return c.json({ code: 500, msg: e.message }); }
});

// 导入 Cookie 列表（追加）
app.post('/api/cookies', async (c) => {
    const mongoUri = c.env?.MONGO_URI as string;
    if (!mongoUri) return c.json({ code: 500, msg: 'MONGO_URI not configured' });
    const body = await c.req.json();
    const cookies = body.cookies;
    if (!Array.isArray(cookies) || cookies.length === 0) return c.json({ code: 400, msg: '请提供 Cookie 数组' });
    try {
        const db = await getDb(mongoUri);
        const coll = db.collection('cookie_pool');
        let addedCount = 0;
        for (const cookie of cookies) {
            if (cookie.sessdata) { await coll.insertOne({ sessdata: cookie.sessdata, buvid3: cookie.buvid3 || '', bili_jct: cookie.bili_jct || '', created_at: new Date() }); addedCount++; }
        }
        return c.json({ code: 0, msg: `成功导入 ${addedCount} 个账号` });
    } catch (e: any) { return c.json({ code: 500, msg: e.message }); }
});

// 删除单个 Cookie
app.delete('/api/cookies/:index', async (c) => {
    const mongoUri = c.env?.MONGO_URI as string;
    if (!mongoUri) return c.json({ code: 500, msg: 'MONGO_URI not configured' });
    const index = parseInt(c.req.param('index'));
    try {
        const db = await getDb(mongoUri);
        const cookies = await db.collection('cookie_pool').find({}).toArray();
        if (index < 0 || index >= cookies.length) return c.json({ code: 404, msg: '索引无效' });
        await db.collection('cookie_pool').deleteOne({ _id: cookies[index]._id });
        return c.json({ code: 0, msg: '删除成功' });
    } catch (e: any) { return c.json({ code: 500, msg: e.message }); }
});

// 清空 Cookie 池
app.delete('/api/cookies', async (c) => {
    const mongoUri = c.env?.MONGO_URI as string;
    if (!mongoUri) return c.json({ code: 500, msg: 'MONGO_URI not configured' });
    try {
        const db = await getDb(mongoUri);
        await db.collection('cookie_pool').deleteMany({});
        return c.json({ code: 0, msg: '已清空' });
    } catch (e: any) { return c.json({ code: 500, msg: e.message }); }
});


// ==================== 监控列表管理 API ====================

// 获取监控列表
app.get('/api/monitor', async (c) => {
    const mongoUri = c.env?.MONGO_URI as string;
    if (!mongoUri) return c.json({ code: 500, msg: 'MONGO_URI not configured' });
    try {
        const db = await getDb(mongoUri);
        const configs = await db.collection('monitor_config').find({}).sort({ created_at: -1 }).toArray();
        return c.json({ code: 0, data: configs.map((c: any) => ({ bvid: c.bvid, title: c.title || '', enabled: c.enabled !== false, fetch_replies: c.fetch_replies === true, created_at: c.created_at })) });
    } catch (e: any) { return c.json({ code: 500, msg: e.message }); }
});

// 添加监控视频
app.post('/api/monitor', async (c) => {
    const mongoUri = c.env?.MONGO_URI as string;
    if (!mongoUri) return c.json({ code: 500, msg: 'MONGO_URI not configured' });
    const body = await c.req.json();
    let bvid = body.bvid?.trim();
    if (!bvid) return c.json({ code: 400, msg: '请输入 BVID' });
    const match = bvid.match(/BV[a-zA-Z0-9]+/i);
    if (match) bvid = match[0];
    if (!/^BV[a-zA-Z0-9]+$/i.test(bvid)) return c.json({ code: 400, msg: '无效的 BVID 格式' });

    try {
        const db = await getDb(mongoUri);
        if (await db.collection('monitor_config').findOne({ bvid })) {
            return c.json({ code: 400, msg: '该视频已在监控列表中' });
        }

        const title = body.title?.trim() || '';
        const newMonitor = { bvid, title, enabled: true, fetch_replies: false, created_at: new Date() };
        await db.collection('monitor_config').insertOne(newMonitor);
        return c.json({ code: 0, msg: '添加成功', data: { bvid, title } });
    } catch (e: any) { return c.json({ code: 500, msg: e.message }); }
});

// 删除监控视频
app.delete('/api/monitor/:bvid', async (c) => {
    const mongoUri = c.env?.MONGO_URI as string;
    if (!mongoUri) return c.json({ code: 500, msg: 'MONGO_URI not configured' });
    const bvid = c.req.param('bvid');
    try {
        const db = await getDb(mongoUri);
        const result = await db.collection('monitor_config').deleteOne({ bvid });
        if (result.deletedCount === 0) return c.json({ code: 404, msg: '未找到该视频' });
        return c.json({ code: 0, msg: '删除成功' });
    } catch (e: any) { return c.json({ code: 500, msg: e.message }); }
});

// 更新监控状态（启用/禁用、抓取回复开关）
app.patch('/api/monitor/:bvid', async (c) => {
    const mongoUri = c.env?.MONGO_URI as string;
    if (!mongoUri) return c.json({ code: 500, msg: 'MONGO_URI not configured' });
    const bvid = c.req.param('bvid');
    const body = await c.req.json();
    try {
        const db = await getDb(mongoUri);
        const updateFields: any = {};
        if (body.enabled !== undefined) updateFields.enabled = body.enabled;
        if (body.fetch_replies !== undefined) updateFields.fetch_replies = body.fetch_replies;

        const result = await db.collection('monitor_config').updateOne(
            { bvid },
            { $set: updateFields }
        );
        if (result.matchedCount === 0) return c.json({ code: 404, msg: '未找到该视频' });
        return c.json({ code: 0, msg: '更新成功' });
    } catch (e: any) { return c.json({ code: 500, msg: e.message }); }
});


// ==================== 手动运行 API ====================

// 触发 GitHub Actions 运行爬虫
app.post('/api/run', async (c) => {
    const githubToken = c.env?.GITHUB_TOKEN as string;
    const githubRepo = c.env?.GITHUB_REPO as string || 'whisper-col/feishu-killbill-comments';

    if (!githubToken) {
        return c.json({ code: 500, msg: 'GITHUB_TOKEN 未配置' });
    }

    // 获取请求体参数
    let bvid = '';
    let fetchReplies = 'true';
    try {
        const body = await c.req.json();
        bvid = body.bvid || '';
        fetchReplies = body.fetch_replies !== false ? 'true' : 'false';
    } catch {
        // 没有 body 使用默认值
    }

    // 使用 waitUntil 异步调用 GitHub API，立即返回响应
    const ctx = c.executionCtx;
    const githubPromise = fetch(
        `https://api.github.com/repos/${githubRepo}/actions/workflows/crawl.yml/dispatches`,
        {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `token ${githubToken}`,
                'User-Agent': 'Bilibili-Monitor-Worker'
            },
            body: JSON.stringify({
                ref: 'master',
                inputs: {
                    bvid: bvid,
                    fetch_replies: fetchReplies
                }
            })
        }
    );

    // 使用 waitUntil 让请求在后台完成
    if (ctx && ctx.waitUntil) {
        ctx.waitUntil(githubPromise);
        return c.json({ code: 0, msg: bvid ? `已触发抓取 ${bvid}` : '已触发抓取任务' });
    }

    // 降级：如果不支持 waitUntil，同步等待
    try {
        const response = await githubPromise;
        if (response.status === 204) {
            return c.json({ code: 0, msg: bvid ? `已触发抓取 ${bvid}` : '已触发抓取任务' });
        } else {
            const error = await response.text();
            return c.json({ code: response.status, msg: `触发失败: ${error}` });
        }
    } catch (e: any) {
        return c.json({ code: 500, msg: e.message });
    }
});

// 获取运行状态
app.get('/api/run/status', async (c) => {
    const githubToken = c.env?.GITHUB_TOKEN as string;
    const githubRepo = c.env?.GITHUB_REPO as string || 'whisper-col/bilibili-comment-monitor';

    if (!githubToken) {
        return c.json({ code: 0, data: { configured: false } });
    }

    try {
        // 获取最近的 workflow runs
        const response = await fetch(
            `https://api.github.com/repos/${githubRepo}/actions/workflows/crawl.yml/runs?per_page=1`,
            {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'Authorization': `token ${githubToken}`,
                    'User-Agent': 'Bilibili-Monitor-Worker'
                }
            }
        );

        if (response.ok) {
            const data: any = await response.json();
            const run = data.workflow_runs?.[0];
            return c.json({
                code: 0,
                data: {
                    configured: true,
                    lastRun: run ? {
                        status: run.status,
                        conclusion: run.conclusion,
                        created_at: run.created_at,
                        html_url: run.html_url
                    } : null
                }
            });
        } else {
            return c.json({ code: 0, data: { configured: true, error: '获取状态失败' } });
        }
    } catch (e: any) {
        return c.json({ code: 500, msg: e.message });
    }
});


// ==================== 飞书数据连接器 API (保留原有功能) ====================

// 获取数据库列表 (飞书连接器用)
app.post('/get_databases', async (c) => {
    const { uri } = await c.req.json();
    const client = new MongoClient(uri, {
        autoEncryption: undefined,
        monitorCommands: false,
        connectTimeoutMS: 5000,
    } as any);
    try {
        await client.connect();
        const admin = client.db().admin();
        const result = await admin.listDatabases();
        const databases = result.databases
            .map((db: any) => db.name)
            .filter((name: string) => !['admin', 'local', 'config'].includes(name));
        return c.json({ code: 0, data: databases });
    } catch (e: any) {
        return c.json({ code: 500, msg: e.message });
    } finally {
        await client.close();
    }
});

// 获取 Collections 列表 (飞书连接器用)
app.post('/get_collections', async (c) => {
    const { uri, db } = await c.req.json();
    const client = new MongoClient(uri, {
        autoEncryption: undefined,
        monitorCommands: false,
        connectTimeoutMS: 5000,
    } as any);
    try {
        await client.connect();
        const collections = await client.db(db).listCollections().toArray();
        const names = collections.map((c: any) => c.name).sort();
        return c.json({ code: 0, data: names });
    } catch (e: any) {
        return c.json({ code: 500, msg: e.message });
    } finally {
        await client.close();
    }
});

// 获取视频列表 (飞书用)
app.post('/get_videos', async (c) => {
    const { uri, db } = await c.req.json();
    const client = new MongoClient(uri, {
        autoEncryption: undefined,
        monitorCommands: false,
        connectTimeoutMS: 5000,
    } as any);
    try {
        await client.connect();
        const collection = client.db(db).collection("video_metadata");
        const videos = await collection.find({}).sort({ last_updated: -1 }).limit(100).toArray();
        return c.json({ code: 0, data: videos });
    } catch (e: any) {
        return c.json({ code: 500, msg: e.message });
    } finally {
        await client.close();
    }
});

// 飞书配置界面
app.get('/config', (c) => {
    return c.html(`
    <!DOCTYPE html>
    <html>
    <head><meta charset="UTF-8"><title>MongoDB 直连配置</title>
    <style>
      body { font-family: sans-serif; padding: 20px; }
      label { display: block; margin-top: 10px; font-weight: bold; }
      input, select { width: 100%; padding: 8px; margin: 5px 0; border: 1px solid #ddd; border-radius: 4px; box-sizing: border-box; }
      .btn { background: #3370ff; color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; width: 100%; margin-top: 20px; }
      .btn-secondary { background: #f3f3f3; color: #333; margin-top: 5px; }
    </style>
    </head>
    <body>
      <h3>🔌 MongoDB 视频评论选择</h3>
      <label>Connection String (URI)</label>
      <input type="text" id="uri" placeholder="mongodb+srv://..." />
      
      <div style="display:flex; gap:10px; align-items:flex-end; margin-top:10px;">
        <div style="flex:1;">
          <label>Database</label>
          <select id="db" style="width:100%;">
            <option value="bilibili_monitor">bilibili_monitor</option>
          </select>
        </div>
        <button class="btn btn-secondary" id="loadDbBtn" style="width:auto; margin:0; padding:8px 15px;">🔄 加载</button>
      </div>
      
      <div style="margin-top:15px; padding:10px; background:#f5f5f5; border-radius:6px;">
        <label style="margin-top:0;">📺 按视频选择（评论数据）</label>
        <div style="display:flex; gap:10px; align-items:center;">
          <select id="videoSelect" style="flex:1;">
            <option value="">请先加载视频列表...</option>
          </select>
          <button class="btn btn-secondary" id="loadVideosBtn" style="width:auto; margin:0; padding:8px 15px;">🔄 加载</button>
        </div>
      </div>
      
      <div style="margin-top:10px; padding:10px; background:#f5f5f5; border-radius:6px;">
        <label style="margin-top:0;">📂 按 Collection 选择（其他数据）</label>
        <div style="display:flex; gap:10px; align-items:center;">
          <select id="coll" style="flex:1;">
            <option value="">请先加载 Collection 列表...</option>
          </select>
          <button class="btn btn-secondary" id="loadCollBtn" style="width:auto; margin:0; padding:8px 15px;">🔄 加载</button>
        </div>
      </div>
      
      <button class="btn" id="saveBtn" style="margin-top:20px;">保存并开始同步</button>

      <script type="module">
        import { bitable } from 'https://esm.sh/@lark-base-open/connector-api';
        
        async function loadDatabases() {
            const uri = document.getElementById('uri').value.trim();
            if(!uri) return alert("请先填写 URI");
            
            localStorage.setItem('mongo_uri', uri);
            const btn = document.getElementById('loadDbBtn');
            btn.textContent = "加载中...";
            
            try {
                const res = await fetch('/get_databases', {
                    method: 'POST',
                    body: JSON.stringify({ uri })
                });
                const json = await res.json();
                if(json.code !== 0) throw new Error(json.msg);
                
                const select = document.getElementById('db');
                select.innerHTML = '';
                json.data.forEach(dbName => {
                    const opt = document.createElement('option');
                    opt.value = dbName;
                    opt.textContent = dbName;
                    if(dbName === 'bilibili_monitor') opt.selected = true;
                    select.appendChild(opt);
                });
                
                btn.textContent = "🔄 加载";
            } catch(e) {
                alert("加载失败: " + e.message);
                btn.textContent = "🔄 加载";
            }
        }
        document.getElementById('loadDbBtn').addEventListener('click', loadDatabases);
        
        async function loadVideos() {
            const uri = document.getElementById('uri').value.trim();
            const db = document.getElementById('db').value;
            if(!uri) return alert("请先填写 URI");
            if(!db) return alert("请先选择 Database");
            
            const btn = document.getElementById('loadVideosBtn');
            btn.textContent = "加载中...";
            
            try {
                const res = await fetch('/get_videos', {
                    method: 'POST',
                    body: JSON.stringify({ uri, db })
                });
                const json = await res.json();
                if(json.code !== 0) throw new Error(json.msg);
                
                const select = document.getElementById('videoSelect');
                select.innerHTML = '<option value="">-- 请选择视频 --</option>';
                
                json.data.forEach(v => {
                    const opt = document.createElement('option');
                    opt.value = v.collection_name || 'comments_' + v.bvid;
                    opt.textContent = '📺 ' + (v.title || v.bvid) + ' (' + (v.comment_count || 0) + '条)';
                    select.appendChild(opt);
                });
                
                btn.textContent = "🔄 加载";
            } catch(e) {
                alert("加载失败: " + e.message);
                btn.textContent = "🔄 加载";
            }
        }
        document.getElementById('loadVideosBtn').addEventListener('click', loadVideos);
        
        async function loadCollections() {
            const uri = document.getElementById('uri').value.trim();
            const db = document.getElementById('db').value;
            if(!uri) return alert("请先填写 URI");
            if(!db) return alert("请先选择 Database");
            
            const btn = document.getElementById('loadCollBtn');
            btn.textContent = "加载中...";
            
            try {
                const res = await fetch('/get_collections', {
                    method: 'POST',
                    body: JSON.stringify({ uri, db })
                });
                const json = await res.json();
                if(json.code !== 0) throw new Error(json.msg);
                
                const select = document.getElementById('coll');
                select.innerHTML = '<option value="">-- 请选择 Collection --</option>';
                
                json.data.forEach(name => {
                    const opt = document.createElement('option');
                    opt.value = name;
                    opt.textContent = name;
                    select.appendChild(opt);
                });
                
                btn.textContent = "🔄 加载";
            } catch(e) {
                alert("加载失败: " + e.message);
                btn.textContent = "🔄 加载";
            }
        }
        document.getElementById('loadCollBtn').addEventListener('click', loadCollections);
        
        // 选择视频时清空 Collection 选择，反之亦然
        document.getElementById('videoSelect').addEventListener('change', () => {
            if(document.getElementById('videoSelect').value) {
                document.getElementById('coll').value = '';
            }
        });
        document.getElementById('coll').addEventListener('change', () => {
            if(document.getElementById('coll').value) {
                document.getElementById('videoSelect').value = '';
            }
        });
        
        const savedUri = localStorage.getItem('mongo_uri');
        if (savedUri) document.getElementById('uri').value = savedUri;

        document.getElementById('saveBtn').onclick = async () => {
          const videoVal = document.getElementById('videoSelect').value;
          const collVal = document.getElementById('coll').value;
          const selectedColl = videoVal || collVal;
          
          if(!selectedColl) return alert("请选择一个视频或 Collection");
          
          const config = {
            uri: document.getElementById('uri').value.trim(),
            db: document.getElementById('db').value,
            coll: selectedColl
          };
          await bitable.saveConfigAndGoNext(config);
        }
      </script>
    </body>
    </html>
  `)
})

// 飞书数据获取
app.post('/records', async (c) => {
    const reqBody = await c.req.json();
    console.log(`[records] reqBody: ${JSON.stringify(reqBody).substring(0, 500)}`);
    const params = JSON.parse(reqBody.params);
    console.log(`[records] params keys: ${Object.keys(params).join(', ')}`);
    const config = typeof params.datasourceConfig === 'string' ? JSON.parse(params.datasourceConfig) : params.datasourceConfig;

    // 分页参数 - 尝试从多个位置读取
    const pageToken = reqBody.pageToken || params.pageToken || "";
    const pageSize = 500; // 飞书限制每页最多 500 条

    console.log(`[records] pageToken: "${pageToken}", coll: ${config.coll}`);

    const client = new MongoClient(config.uri, {
        autoEncryption: undefined,
        monitorCommands: false,
        connectTimeoutMS: 10000,
    } as any);
    try {
        await client.connect();
        const collection = client.db(config.db).collection(config.coll);

        // 计算跳过的记录数
        const skip = pageToken ? parseInt(pageToken) : 0;

        console.log(`[records] skip: ${skip}`);

        // 多取一条来判断是否有更多数据，避免慢速的 countDocuments
        const docs = await collection.find({})
            .sort({ ctime: 1 })
            .skip(skip)
            .limit(pageSize + 1)
            .toArray();

        // 判断是否有更多数据
        const hasMore = docs.length > pageSize;
        const actualDocs = hasMore ? docs.slice(0, pageSize) : docs;

        const collName = config.coll || '';

        // 根据 collection 类型格式化数据
        const records = actualDocs.map(doc => {
            const primaryID = String(doc._id);
            let data: any = { id: primaryID };

            if (collName === 'video_stats') {
                data = {
                    id: primaryID,
                    bvid: doc.bvid || "",
                    timestamp: doc.timestamp ? new Date(doc.timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : "",
                    view: doc.view ? String(doc.view) : "0",
                    like: doc.like ? String(doc.like) : "0",
                    coin: doc.coin ? String(doc.coin) : "0",
                    favorite: doc.favorite ? String(doc.favorite) : "0",
                    share: doc.share ? String(doc.share) : "0",
                    reply: doc.reply ? String(doc.reply) : "0",
                    danmaku: doc.danmaku ? String(doc.danmaku) : "0",
                    online: doc.online ? String(doc.online) : "0"
                };
            } else if (collName === 'video_metadata') {
                data = {
                    id: primaryID,
                    bvid: doc.bvid || "",
                    title: doc.title || "",
                    comment_count: doc.comment_count ? String(doc.comment_count) : "0",
                    last_updated: doc.last_updated ? new Date(doc.last_updated).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : ""
                };
            } else if (collName === 'monitor_config') {
                data = {
                    id: primaryID,
                    bvid: doc.bvid || "",
                    title: doc.title || "",
                    enabled: doc.enabled === true ? "是" : "否",
                    fetch_replies: doc.fetch_replies === true ? "是" : "否",
                    created_at: doc.created_at ? new Date(doc.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : ""
                };
            } else {
                // 评论表
                data = {
                    id: doc.rpid ? String(doc.rpid) : primaryID,
                    user: doc.user || "",
                    mid: doc.mid ? String(doc.mid) : "",
                    sex: doc.sex || "",
                    location: doc.location || "",
                    content: doc.content || "",
                    time: doc.ctime ? new Date(doc.ctime * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : "",
                    level: doc.level ? String(doc.level) : "0",
                    likes: doc.likes ? String(doc.likes) : "0",
                    rcount: doc.rcount ? String(doc.rcount) : "0",
                    fans_medal: doc.fans_medal || ""
                };
            }

            return { primaryID: data.id, data };
        });

        // 计算下一页 token
        const nextSkip = skip + actualDocs.length;

        console.log(`[records] returned ${records.length}, hasMore: ${hasMore}, nextPageToken: ${hasMore ? nextSkip : ''}`);

        return c.json({
            code: 0,
            msg: "success",
            data: {
                hasMore,
                pageToken: hasMore ? String(nextSkip) : "",
                records
            }
        });
    } catch (err: any) {
        console.log(`[records] error: ${err.message}`);
        return c.json({ code: 500, msg: "连接失败: " + err.message });
    } finally {
        await client.close();
    }
})

// 飞书表结构定义 - 根据 collection 动态返回字段
app.post('/table_meta', async (c) => {
    const reqBody = await c.req.json();
    const params = JSON.parse(reqBody.params);
    const config = typeof params.datasourceConfig === 'string' ? JSON.parse(params.datasourceConfig) : params.datasourceConfig;

    const collName = config.coll || '';
    let tableName = collName;
    let fields: any[] = [];

    // 根据 collection 名称确定字段结构
    if (collName === 'video_stats') {
        tableName = '视频统计数据';
        fields = [
            { fieldID: "id", fieldName: "记录ID", fieldType: 1, isPrimary: true },
            { fieldID: "bvid", fieldName: "视频BV号", fieldType: 1 },
            { fieldID: "timestamp", fieldName: "采集时间", fieldType: 1 },
            { fieldID: "view", fieldName: "播放量", fieldType: 1 },
            { fieldID: "like", fieldName: "点赞数", fieldType: 1 },
            { fieldID: "coin", fieldName: "投币数", fieldType: 1 },
            { fieldID: "favorite", fieldName: "收藏数", fieldType: 1 },
            { fieldID: "share", fieldName: "分享数", fieldType: 1 },
            { fieldID: "reply", fieldName: "评论数", fieldType: 1 },
            { fieldID: "danmaku", fieldName: "弹幕数", fieldType: 1 },
            { fieldID: "online", fieldName: "在线人数", fieldType: 1 }
        ];
    } else if (collName === 'video_metadata') {
        tableName = '视频元数据';
        fields = [
            { fieldID: "id", fieldName: "记录ID", fieldType: 1, isPrimary: true },
            { fieldID: "bvid", fieldName: "视频BV号", fieldType: 1 },
            { fieldID: "title", fieldName: "视频标题", fieldType: 1 },
            { fieldID: "comment_count", fieldName: "评论数", fieldType: 1 },
            { fieldID: "last_updated", fieldName: "最后更新", fieldType: 1 }
        ];
    } else if (collName === 'monitor_config') {
        tableName = '监控配置';
        fields = [
            { fieldID: "id", fieldName: "记录ID", fieldType: 1, isPrimary: true },
            { fieldID: "bvid", fieldName: "视频BV号", fieldType: 1 },
            { fieldID: "title", fieldName: "视频标题", fieldType: 1 },
            { fieldID: "enabled", fieldName: "是否启用", fieldType: 1 },
            { fieldID: "fetch_replies", fieldName: "抓取回复", fieldType: 1 },
            { fieldID: "created_at", fieldName: "创建时间", fieldType: 1 }
        ];
    } else {
        // 评论表或其他表
        if (collName.startsWith('comments_')) {
            const client = new MongoClient(config.uri, {
                autoEncryption: undefined,
                monitorCommands: false,
                connectTimeoutMS: 5000,
            } as any);
            try {
                await client.connect();
                const bvid = collName.replace('comments_', '');
                const metadata = await client.db(config.db).collection('video_metadata').findOne({ bvid });
                if (metadata && metadata.title) {
                    tableName = metadata.title;
                }
            } catch (e) {
                tableName = collName;
            } finally {
                await client.close();
            }
        }
        fields = [
            { fieldID: "id", fieldName: "评论ID", fieldType: 1, isPrimary: true },
            { fieldID: "user", fieldName: "用户名", fieldType: 1 },
            { fieldID: "mid", fieldName: "用户UID", fieldType: 1 },
            { fieldID: "sex", fieldName: "性别", fieldType: 1 },
            { fieldID: "location", fieldName: "IP属地", fieldType: 1 },
            { fieldID: "content", fieldName: "评论内容", fieldType: 1 },
            { fieldID: "time", fieldName: "发布时间", fieldType: 1 },
            { fieldID: "level", fieldName: "等级", fieldType: 1 },
            { fieldID: "likes", fieldName: "点赞数", fieldType: 1 },
            { fieldID: "rcount", fieldName: "回复数", fieldType: 1 },
            { fieldID: "fans_medal", fieldName: "粉丝勋章", fieldType: 1 }
        ];
    }

    return c.json({
        code: 0, msg: "success",
        data: { tableName, fields }
    })
})

// 飞书元数据
app.get('/meta.json', (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json({
        schemaVersion: 1, type: "data_connector",
        extraData: { dataSourceConfigUiUri: `${origin}/config` },
        protocol: {
            type: "http", httpProtocol: {
                uris: [
                    { type: "tableMeta", uri: "/table_meta" },
                    { type: "records", uri: "/records" }
                ]
            }
        }
    })
})


// ==================== 认证 API ====================

// 登录验证
app.post('/api/auth/login', async (c) => {
    const authUser = c.env?.AUTH_USER as string;
    const authPassword = c.env?.AUTH_PASSWORD as string;

    // 如果没有配置认证信息，直接返回成功
    if (!authUser || !authPassword) {
        return c.json({ code: 0, msg: '登录成功', data: { needAuth: false } });
    }

    const body = await c.req.json();
    const { username, password } = body;

    if (username === authUser && password === authPassword) {
        return c.json({ code: 0, msg: '登录成功' });
    }

    return c.json({ code: 401, msg: '用户名或密码错误' }, 401);
});

// 检查是否需要认证
app.get('/api/auth/check', async (c) => {
    const authUser = c.env?.AUTH_USER as string;
    const authPassword = c.env?.AUTH_PASSWORD as string;

    // 如果没有配置认证信息，不需要认证
    if (!authUser || !authPassword) {
        return c.json({ code: 0, data: { needAuth: false } });
    }

    return c.json({ code: 0, data: { needAuth: true } });
});

// ==================== 静态页面 ====================

// 登录页面
app.get('/login', (c) => {
    return c.html(getLoginHTML());
});

// 主页 - 评论监控 WebUI
app.get('/', (c) => {
    return c.html(getIndexHTML());
});

// 登录页面 HTML
function getLoginHTML(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>登录 - B站评论监控</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #e0e0e0;
        }
        
        .login-container {
            background: rgba(255,255,255,0.05);
            border-radius: 16px;
            padding: 40px;
            width: 100%;
            max-width: 400px;
            margin: 20px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.3);
        }
        
        .login-header {
            text-align: center;
            margin-bottom: 30px;
        }
        
        .login-header h1 {
            font-size: 1.8rem;
            background: linear-gradient(90deg, #00d4ff, #7b2ff7);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin-bottom: 8px;
        }
        
        .login-header p {
            color: #888;
            font-size: 0.9rem;
        }
        
        .form-group {
            margin-bottom: 20px;
        }
        
        .form-group label {
            display: block;
            margin-bottom: 8px;
            color: #aaa;
            font-size: 0.9rem;
        }
        
        .form-group input[type="text"],
        .form-group input[type="password"] {
            width: 100%;
            padding: 14px 16px;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 10px;
            background: rgba(0,0,0,0.3);
            color: #fff;
            font-size: 1rem;
            transition: border-color 0.2s, box-shadow 0.2s;
        }
        
        .form-group input:focus {
            outline: none;
            border-color: #00d4ff;
            box-shadow: 0 0 0 3px rgba(0,212,255,0.1);
        }
        
        .remember-row {
            display: flex;
            align-items: center;
            gap: 8px;
            margin-bottom: 25px;
        }
        
        .remember-row input[type="checkbox"] {
            width: 18px;
            height: 18px;
            accent-color: #00d4ff;
        }
        
        .remember-row label {
            color: #888;
            font-size: 0.9rem;
            cursor: pointer;
        }
        
        .login-btn {
            width: 100%;
            padding: 14px;
            border: none;
            border-radius: 10px;
            background: linear-gradient(90deg, #00d4ff, #7b2ff7);
            color: white;
            font-size: 1rem;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.2s, transform 0.2s;
        }
        
        .login-btn:hover {
            opacity: 0.9;
            transform: translateY(-1px);
        }
        
        .login-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
        }
        
        .error-msg {
            background: rgba(255,82,82,0.1);
            border: 1px solid rgba(255,82,82,0.3);
            color: #ff5252;
            padding: 12px 16px;
            border-radius: 8px;
            margin-bottom: 20px;
            font-size: 0.9rem;
            display: none;
        }
        
        .error-msg.show {
            display: block;
        }
    </style>
</head>
<body>
    <div class="login-container">
        <div class="login-header">
            <h1>📡 B站评论监控</h1>
            <p>请登录以继续</p>
        </div>
        
        <div class="error-msg" id="error-msg"></div>
        
        <form id="login-form">
            <div class="form-group">
                <label for="username">用户名</label>
                <input type="text" id="username" name="username" placeholder="请输入用户名" required>
            </div>
            
            <div class="form-group">
                <label for="password">密码</label>
                <input type="password" id="password" name="password" placeholder="请输入密码" required>
            </div>
            
            <div class="remember-row">
                <input type="checkbox" id="remember" name="remember" checked>
                <label for="remember">记住登录</label>
            </div>
            
            <button type="submit" class="login-btn" id="login-btn">登 录</button>
        </form>
    </div>
    
    <script>
        const AUTH_KEY = 'bilibili_monitor_auth';
        
        // 检查是否已有保存的凭据
        async function checkSavedAuth() {
            const saved = localStorage.getItem(AUTH_KEY);
            if (saved) {
                try {
                    const { username, password } = JSON.parse(saved);
                    // 尝试自动登录
                    const res = await fetch('/api/auth/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, password })
                    });
                    if (res.ok) {
                        // 保存到 sessionStorage 供后续请求使用
                        sessionStorage.setItem(AUTH_KEY, saved);
                        window.location.href = '/';
                        return;
                    } else {
                        // 凭据无效，清除
                        localStorage.removeItem(AUTH_KEY);
                    }
                } catch (e) {
                    localStorage.removeItem(AUTH_KEY);
                }
            }
        }
        
        checkSavedAuth();
        
        document.getElementById('login-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const btn = document.getElementById('login-btn');
            const errorEl = document.getElementById('error-msg');
            const username = document.getElementById('username').value.trim();
            const password = document.getElementById('password').value;
            const remember = document.getElementById('remember').checked;
            
            btn.disabled = true;
            btn.textContent = '登录中...';
            errorEl.classList.remove('show');
            
            try {
                const res = await fetch('/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                
                const json = await res.json();
                
                if (res.ok && json.code === 0) {
                    // 登录成功
                    const authData = JSON.stringify({ username, password });
                    sessionStorage.setItem(AUTH_KEY, authData);
                    
                    if (remember) {
                        localStorage.setItem(AUTH_KEY, authData);
                    }
                    
                    window.location.href = '/';
                } else {
                    errorEl.textContent = json.msg || '登录失败';
                    errorEl.classList.add('show');
                }
            } catch (err) {
                errorEl.textContent = '网络错误，请重试';
                errorEl.classList.add('show');
            } finally {
                btn.disabled = false;
                btn.textContent = '登 录';
            }
        });
    </script>
</body>
</html>`;
}

// 提供静态资源的内联 HTML
function getIndexHTML(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>B站评论监控</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
            min-height: 100vh;
            color: #e0e0e0;
        }
        
        .container {
            max-width: 900px;
            margin: 0 auto;
            padding: 20px;
        }
        
        header {
            text-align: center;
            padding: 30px 0;
            border-bottom: 1px solid rgba(255,255,255,0.1);
            margin-bottom: 30px;
        }
        
        header h1 {
            font-size: 2rem;
            background: linear-gradient(90deg, #00d4ff, #7b2ff7);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
        }
        
        .status-bar {
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 15px;
            margin-top: 15px;
            flex-wrap: wrap;
        }
        
        .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            padding: 6px 14px;
            border-radius: 20px;
            font-size: 0.85rem;
            background: rgba(255,255,255,0.1);
        }
        
        .status-badge.success {
            background: rgba(0, 200, 83, 0.2);
            color: #00c853;
        }
        
        .pulse {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #00c853;
            animation: pulse 2s infinite;
        }
        
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.5; }
        }
        
        .video-selector {
            background: rgba(255,255,255,0.05);
            border-radius: 12px;
            padding: 20px;
            margin-bottom: 20px;
        }
        
        .video-selector h3 {
            margin-bottom: 15px;
            font-size: 1rem;
            color: #888;
        }
        
        select {
            width: 100%;
            padding: 12px 15px;
            border: 1px solid rgba(255,255,255,0.2);
            border-radius: 8px;
            background: rgba(0,0,0,0.3);
            color: #fff;
            font-size: 1rem;
            cursor: pointer;
        }
        
        select:focus {
            outline: none;
            border-color: #00d4ff;
        }
        
        .video-info {
            margin-top: 15px;
            padding: 15px;
            background: rgba(0,0,0,0.2);
            border-radius: 8px;
            display: none;
        }
        
        .video-info.show {
            display: block;
        }
        
        .video-info h4 {
            color: #00d4ff;
            margin-bottom: 10px;
        }
        
        .video-info p {
            color: #888;
            font-size: 0.9rem;
            margin: 5px 0;
        }
        
        .comments-section {
            background: rgba(255,255,255,0.05);
            border-radius: 12px;
            padding: 20px;
        }
        
        .section-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        }
        
        .section-header h2 {
            font-size: 1.2rem;
        }
        
        .refresh-btn {
            background: linear-gradient(90deg, #00d4ff, #7b2ff7);
            border: none;
            color: white;
            padding: 8px 16px;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.9rem;
            transition: opacity 0.2s;
        }
        
        .refresh-btn:hover {
            opacity: 0.8;
        }
        
        .refresh-btn:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }
        
        .comments-list {
            display: flex;
            flex-direction: column;
            gap: 12px;
            max-height: 600px;
            overflow-y: auto;
        }
        
        .comment-item {
            background: rgba(0,0,0,0.3);
            border-radius: 10px;
            padding: 15px;
            border-left: 3px solid #00d4ff;
            transition: transform 0.2s;
        }
        
        .comment-item:hover {
            transform: translateX(5px);
        }
        
        .comment-item.sub-comment {
            margin-left: 20px;
            border-left-color: #7b2ff7;
            opacity: 0.85;
        }
        
        .comment-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }
        
        .comment-user {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        
        .user-name {
            font-weight: 600;
            color: #fff;
        }
        
        .user-level {
            font-size: 0.75rem;
            padding: 2px 6px;
            border-radius: 4px;
            background: linear-gradient(90deg, #ff6b6b, #ffa502);
            color: white;
        }
        
        .user-medal {
            font-size: 0.75rem;
            padding: 2px 6px;
            border-radius: 4px;
            background: rgba(123, 47, 247, 0.3);
            color: #b388ff;
        }
        
        .comment-time {
            color: #666;
            font-size: 0.85rem;
        }
        
        .comment-content {
            color: #e0e0e0;
            line-height: 1.6;
            word-break: break-word;
        }
        
        .comment-footer {
            display: flex;
            gap: 15px;
            margin-top: 10px;
            font-size: 0.85rem;
            color: #666;
        }
        
        .comment-footer span {
            display: flex;
            align-items: center;
            gap: 4px;
        }
        
        .loading {
            text-align: center;
            padding: 40px;
            color: #666;
        }
        
        .empty-state {
            text-align: center;
            padding: 60px 20px;
            color: #666;
        }
        
        .empty-state svg {
            width: 80px;
            height: 80px;
            margin-bottom: 20px;
            opacity: 0.3;
        }
        
        .load-more {
            display: block;
            width: 100%;
            padding: 12px;
            margin-top: 15px;
            background: rgba(255,255,255,0.1);
            border: none;
            border-radius: 8px;
            color: #888;
            cursor: pointer;
            transition: background 0.2s;
        }
        
        .load-more:hover {
            background: rgba(255,255,255,0.15);
        }

        @media (max-width: 600px) {
            .container {
                padding: 10px;
            }
            header h1 {
                font-size: 1.5rem;
            }
            .comment-header {
                flex-direction: column;
                align-items: flex-start;
                gap: 5px;
            }
        }
        
        /* 隐藏滚动条但保留滚动功能 */
        ::-webkit-scrollbar {
            width: 0;
            height: 0;
        }
        * {
            scrollbar-width: none;
        }
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>📡 B站评论监控</h1>
            <button id="logout-btn" onclick="logout()" style="position:absolute;right:20px;top:30px;background:rgba(255,82,82,0.2);color:#ff5252;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-size:0.85rem;">退出登录</button>
        </header>

        <div class="video-selector">
            <h3>📋 监控管理</h3>
            <div style="display:flex;gap:10px;margin-bottom:10px;">
                <input type="text" id="bvid-input" placeholder="输入 BVID 或视频链接" style="flex:1;padding:12px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.2);border-radius:8px;color:#fff;">
                <button class="refresh-btn" onclick="addMonitor()">添加</button>
            </div>
            <input type="text" id="title-input" placeholder="视频名称（可选）" style="width:100%;padding:10px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.2);border-radius:8px;color:#fff;margin-bottom:10px;box-sizing:border-box;">
            <div id="monitor-list" style="max-height:150px;overflow-y:auto;"></div>
        </div>

        <div class="video-selector">
            <h3>🔑 账号池 <span id="cookie-count">(0个)</span></h3>
            <div style="display:flex;gap:10px;margin-bottom:10px;">
                <input type="file" id="cookie-file" accept=".json" hidden>
                <button class="refresh-btn" onclick="document.getElementById('cookie-file').click()">📁 导入 Cookie</button>
                <button class="refresh-btn" style="background:#666;" onclick="clearCookies()">🗑️ 清空</button>
            </div>
            <div id="cookie-list" style="max-height:120px;overflow-y:auto;"></div>
        </div>

        <div class="video-selector">
            <h3>📺 选择视频查看评论</h3>
            <select id="video-select">
                <option value="">加载中...</option>
            </select>
        </div>

        <div class="comments-section">
            <div class="section-header">
                <h2>💬 最新评论</h2>
                <button class="refresh-btn" id="refresh-btn" onclick="loadComments()">🔄 刷新</button>
            </div>
            <div class="comments-list" id="comments-list">
                <div class="loading">请先选择一个视频...</div>
            </div>
            <button class="load-more" id="load-more" style="display:none;" onclick="loadMoreComments()">
                加载更多...
            </button>
        </div>
    </div>

    <script>
        const AUTH_KEY = 'bilibili_monitor_auth';
        let currentBvid = '';
        let currentOffset = 0;
        let videosData = [];

        // 获取认证头
        function getAuthHeaders() {
            const saved = sessionStorage.getItem(AUTH_KEY) || localStorage.getItem(AUTH_KEY);
            if (saved) {
                const { username, password } = JSON.parse(saved);
                return {
                    'Authorization': 'Basic ' + btoa(username + ':' + password)
                };
            }
            return {};
        }

        // 带认证的 fetch
        let redirecting = false;
        async function authFetch(url, options = {}) {
            const headers = { ...getAuthHeaders(), ...(options.headers || {}) };
            const res = await fetch(url, { ...options, headers });
            if (res.status === 401 && !redirecting) {
                // 未认证，跳转登录
                redirecting = true;
                sessionStorage.removeItem(AUTH_KEY);
                window.location.href = '/login';
            }
            return res;
        }

        // 退出登录
        function logout() {
            if (!confirm('确定要退出登录吗？')) return;
            localStorage.removeItem(AUTH_KEY);
            sessionStorage.removeItem(AUTH_KEY);
            window.location.href = '/login';
        }

        // 初始化
        async function init() {
            // 检查是否有保存的凭据
            const saved = sessionStorage.getItem(AUTH_KEY) || localStorage.getItem(AUTH_KEY);
            if (!saved) {
                // 检查是否需要认证
                try {
                    const res = await fetch('/api/auth/check');
                    const json = await res.json();
                    if (json.data?.needAuth) {
                        window.location.href = '/login';
                        return;
                    }
                } catch (e) {
                    console.error(e);
                }
            } else {
                // 验证凭据是否有效
                try {
                    const { username, password } = JSON.parse(saved);
                    const res = await fetch('/api/auth/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, password })
                    });
                    if (!res.ok) {
                        localStorage.removeItem(AUTH_KEY);
                        sessionStorage.removeItem(AUTH_KEY);
                        window.location.href = '/login';
                        return;
                    }
                    // 确保 sessionStorage 有凭据
                    sessionStorage.setItem(AUTH_KEY, saved);
                } catch (e) {
                    console.error(e);
                }
            }
            
            await Promise.all([loadMonitorList(), loadCookies(), loadVideos(), loadRunStatus()]);
            document.getElementById('cookie-file').addEventListener('change', handleCookieFile);
        }

        async function loadRunStatus() {
            try {
                const res = await authFetch('/api/run/status');
                const json = await res.json();
                const status = document.getElementById('run-status-text');
                if (!status) return; // 元素不存在时跳过
                if (!json.data?.configured) {
                    status.textContent = '未配置 Token';
                    return;
                }
                if (json.data.lastRun) {
                    const run = json.data.lastRun;
                    const time = new Date(run.created_at).toLocaleString('zh-CN');
                    if (run.status === 'completed') {
                        status.textContent = run.conclusion === 'success' ? '✓ ' + time : '✗ 失败';
                    } else {
                        status.textContent = '⏳ 运行中';
                    }
                } else {
                    status.textContent = '就绪';
                }
            } catch (e) { console.error('loadRunStatus error:', e); }
        }

        // ================= 监控列表管理 =================
        async function loadMonitorList() {
            try {
                const res = await authFetch('/api/monitor');
                const json = await res.json();
                if (json.code !== 0) return;
                const list = document.getElementById('monitor-list');
                if (json.data.length === 0) {
                    list.innerHTML = '<div style="color:#666;text-align:center;padding:10px;">暂无监控，请添加 BVID</div>';
                    return;
                }
                list.innerHTML = json.data.map(m => {
                    const enabled = m.enabled !== false;
                    const statusText = enabled ? '运行中' : '已暂停';
                    const statusColor = enabled ? '#4CAF50' : '#ff9800';
                    const hasTitle = m.title && m.title.length > 0;
                    const fetchReplies = m.fetch_replies === true;
                    const pauseBtn = enabled 
                        ? '<button style="background:rgba(255,152,0,0.2);color:#ff9800;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;" onclick="toggleMonitor(\\'' + m.bvid + '\\', false)">⏸️</button>'
                        : '<button style="background:rgba(76,175,80,0.2);color:#4CAF50;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;" onclick="toggleMonitor(\\'' + m.bvid + '\\', true)">▶️</button>';
                    const replyBtn = fetchReplies
                        ? '<button style="background:rgba(156,39,176,0.3);color:#ce93d8;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;" onclick="toggleReplies(\\'' + m.bvid + '\\', false)" title="抓取回复: 开">💬</button>'
                        : '<button style="background:rgba(100,100,100,0.2);color:#666;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;" onclick="toggleReplies(\\'' + m.bvid + '\\', true)" title="抓取回复: 关">💬</button>';
                    return '<div style="display:flex;justify-content:space-between;align-items:center;padding:8px;background:rgba(0,0,0,0.2);border-radius:6px;margin-bottom:6px;">' +
                        '<div style="flex:1;min-width:0;">' +
                        (hasTitle 
                            ? '<div style="color:#fff;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + m.title + '">' + m.title + '</div><div style="font-size:0.8rem;"><span style="color:#00d4ff;">' + m.bvid + '</span> <span style="color:' + statusColor + ';margin-left:8px;">' + statusText + '</span></div>'
                            : '<div style="color:#00d4ff;font-weight:500;">' + m.bvid + ' <span style="color:' + statusColor + ';font-weight:normal;">' + statusText + '</span></div>') +
                        '</div>' +
                        '<div style="display:flex;gap:5px;flex-shrink:0;">' +
                        '<button style="background:rgba(0,212,255,0.2);color:#00d4ff;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;" onclick="runSingle(\\'' + m.bvid + '\\')">🚀</button>' +
                        replyBtn +
                        pauseBtn +
                        '<button style="background:rgba(255,82,82,0.2);color:#ff5252;border:none;padding:4px 8px;border-radius:4px;cursor:pointer;" onclick="removeMonitor(\\'' + m.bvid + '\\')">🗑️</button>' +
                        '</div></div>';
                }).join('');
            } catch (e) { console.error(e); }
        }

        async function addMonitor() {
            const input = document.getElementById('bvid-input');
            const titleInput = document.getElementById('title-input');
            const btn = document.querySelector('.video-selector .refresh-btn');
            let bvid = input.value.trim();
            if (!bvid) { alert('请输入 BVID'); return; }
            const match = bvid.match(/BV[a-zA-Z0-9]+/i);
            if (match) bvid = match[0];
            const title = titleInput.value.trim();
            
            btn.disabled = true;
            btn.textContent = '添加中...';
            
            try {
                const res = await authFetch('/api/monitor', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bvid, title }) });
                const json = await res.json();
                if (json.code !== 0) { alert(json.msg); return; }
                input.value = '';
                titleInput.value = '';
                // 立即刷新列表
                await loadMonitorList();
            } catch (e) { alert('添加失败: ' + e.message); }
            finally {
                btn.disabled = false;
                btn.textContent = '添加';
            }
        }

        async function removeMonitor(bvid) {
            if (!confirm('确定删除 ' + bvid + '？')) return;
            // 立即显示 loading 状态
            updateBvidStatus(bvid, '删除中...');
            try {
                const res = await authFetch('/api/monitor/' + bvid, { method: 'DELETE' });
                const json = await res.json();
                if (json.code !== 0) { alert(json.msg); await loadMonitorList(); return; }
                await loadMonitorList();
            } catch (e) { alert('删除失败'); await loadMonitorList(); }
        }

        async function toggleMonitor(bvid, enabled) {
            // 立即显示 loading 状态
            updateBvidStatus(bvid, enabled ? '启用中...' : '暂停中...');
            try {
                const res = await authFetch('/api/monitor/' + bvid, { 
                    method: 'PATCH', 
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled })
                });
                const json = await res.json();
                if (json.code !== 0) { alert(json.msg); }
                await loadMonitorList();
            } catch (e) { alert('操作失败'); await loadMonitorList(); }
        }

        async function toggleReplies(bvid, fetch_replies) {
            try {
                const res = await authFetch('/api/monitor/' + bvid, { 
                    method: 'PATCH', 
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fetch_replies })
                });
                const json = await res.json();
                if (json.code !== 0) { alert(json.msg); }
                await loadMonitorList();
            } catch (e) { alert('操作失败'); await loadMonitorList(); }
        }

        function updateBvidStatus(bvid, text) {
            // 更新指定 BVID 的状态文字
            const list = document.getElementById('monitor-list');
            const items = list.querySelectorAll('div > div > span:first-child');
            items.forEach(span => {
                if (span.textContent === bvid) {
                    const statusSpan = span.nextElementSibling;
                    if (statusSpan) statusSpan.textContent = text;
                }
            });
        }

        async function runSingle(bvid) {
            // 立即显示 loading 状态
            updateBvidStatus(bvid, '触发中...');
            try {
                const fetchReplies = document.getElementById('fetch-replies')?.checked ?? true;
                const res = await authFetch('/api/run', { 
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ bvid, fetch_replies: fetchReplies })
                });
                const json = await res.json();
                if (json.code === 0) {
                    updateBvidStatus(bvid, '已触发');
                    setTimeout(() => loadMonitorList(), 2000);
                } else {
                    alert(json.msg);
                    await loadMonitorList();
                }
            } catch (e) {
                alert('运行失败: ' + e.message);
                await loadMonitorList();
            }
        }

        // ================= Cookie 池管理 =================
        async function loadCookies() {
            try {
                const res = await authFetch('/api/cookies');
                const json = await res.json();
                if (json.code !== 0) return;
                document.getElementById('cookie-count').textContent = '(' + json.data.length + '个)';
                const list = document.getElementById('cookie-list');
                if (json.data.length === 0) {
                    list.innerHTML = '<div style="color:#666;text-align:center;padding:10px;">暂无账号，请导入 Cookie</div>';
                    return;
                }
                list.innerHTML = json.data.map((c, i) => '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px;background:rgba(0,0,0,0.2);border-radius:4px;margin-bottom:4px;"><span style="color:#00d4ff;font-size:0.85rem;">#' + (i+1) + ' ' + c.sessdata_mask + '</span><button style="color:#ff5252;background:none;border:none;cursor:pointer;" onclick="removeCookie(' + i + ')">删除</button></div>').join('');
            } catch (e) { console.error(e); }
        }

        async function handleCookieFile(e) {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (event) => {
                try {
                    const data = JSON.parse(event.target.result);
                    if (!Array.isArray(data)) throw new Error('格式错误');
                    let cookies = [];
                    if (data[0] && data[0].name !== undefined) {
                        const sess = data.find(c => c.name && c.name.toUpperCase() === 'SESSDATA');
                        if (sess) cookies.push({ sessdata: sess.value, buvid3: (data.find(c => c.name === 'buvid3') || {}).value || '', bili_jct: (data.find(c => c.name === 'bili_jct') || {}).value || '' });
                    } else {
                        data.forEach(item => { if (item.sessdata) cookies.push(item); });
                    }
                    if (cookies.length === 0) throw new Error('无有效 Cookie');
                    const res = await authFetch('/api/cookies', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookies }) });
                    const json = await res.json();
                    alert(json.msg || '导入成功');
                    await loadCookies();
                } catch (err) { alert('导入失败: ' + err.message); }
            };
            reader.readAsText(file);
            e.target.value = '';
        }

        async function removeCookie(index) {
            if (!confirm('确定删除？')) return;
            try {
                await authFetch('/api/cookies/' + index, { method: 'DELETE' });
                await loadCookies();
            } catch (e) { alert('删除失败'); }
        }

        async function clearCookies() {
            if (!confirm('确定清空所有账号？')) return;
            try {
                await authFetch('/api/cookies', { method: 'DELETE' });
                await loadCookies();
            } catch (e) { alert('清空失败'); }
        }

        // 加载视频列表（带重试）
        async function loadVideos(retryCount = 0) {
            const select = document.getElementById('video-select');
            try {
                select.innerHTML = '<option value="">加载中...</option>';
                const res = await authFetch('/api/videos');
                const json = await res.json();
                
                if (json.code !== 0) throw new Error(json.msg);
                
                videosData = json.data;
                
                if (videosData.length === 0) {
                    select.innerHTML = '<option value="">暂无视频数据，等待爬虫抓取...</option>';
                    return;
                }
                
                select.innerHTML = '<option value="">-- 请选择视频 --</option>';
                videosData.forEach(v => {
                    const opt = document.createElement('option');
                    opt.value = v.bvid;
                    opt.textContent = \`\${v.title} (\${v.comment_count || 0}条)\`;
                    select.appendChild(opt);
                });
                
                // 默认选中第一个
                if (videosData.length > 0) {
                    select.value = videosData[0].bvid;
                    selectVideo(videosData[0].bvid);
                }
            } catch (e) {
                console.error('加载视频列表失败:', e);
                // 自动重试最多 2 次
                if (retryCount < 2) {
                    setTimeout(() => loadVideos(retryCount + 1), 1000);
                    return;
                }
                select.innerHTML = '<option value="" onclick="loadVideos()">⚠️ 加载失败，点击重试</option>';
            }
        }

        // 选择视频
        function selectVideo(bvid) {
            currentBvid = bvid;
            currentOffset = 0;
            loadComments();
        }

        // 加载评论
        async function loadComments() {
            if (!currentBvid) return;
            
            const btn = document.getElementById('refresh-btn');
            const list = document.getElementById('comments-list');
            
            btn.disabled = true;
            btn.textContent = '加载中...';
            
            if (currentOffset === 0) {
                list.innerHTML = '<div class="loading">加载中...</div>';
            }
            
            try {
                const res = await fetch(\`/api/comments/\${currentBvid}?limit=50&offset=\${currentOffset}\`);
                const json = await res.json();
                
                if (json.code !== 0) throw new Error(json.msg);
                
                const { total, comments } = json.data;
                
                if (currentOffset === 0) {
                    list.innerHTML = '';
                }
                
                if (comments.length === 0 && currentOffset === 0) {
                    list.innerHTML = \`
                        <div class="empty-state">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor">
                                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                            </svg>
                            <p>暂无评论数据</p>
                        </div>
                    \`;
                    return;
                }
                
                comments.forEach(c => {
                    const div = document.createElement('div');
                    div.className = 'comment-item' + (c.root ? ' sub-comment' : '');
                    div.innerHTML = \`
                        <div class="comment-header">
                            <div class="comment-user">
                                <span class="user-name">\${escapeHtml(c.user)}</span>
                                <span class="user-level">Lv\${c.level}</span>
                                \${c.fans_medal ? \`<span class="user-medal">\${escapeHtml(c.fans_medal)}</span>\` : ''}
                            </div>
                            <span class="comment-time">\${c.time}</span>
                        </div>
                        <div class="comment-content">\${escapeHtml(c.content)}</div>
                        <div class="comment-footer">
                            <span>👍 \${c.likes}</span>
                            <span>💬 \${c.rcount}</span>
                            \${c.location ? \`<span>📍 \${escapeHtml(c.location)}</span>\` : ''}
                        </div>
                    \`;
                    list.appendChild(div);
                });
                
                // 显示/隐藏加载更多按钮
                const loadMoreBtn = document.getElementById('load-more');
                if (currentOffset + comments.length < total) {
                    loadMoreBtn.style.display = 'block';
                    loadMoreBtn.textContent = \`加载更多 (\${currentOffset + comments.length}/\${total})\`;
                } else {
                    loadMoreBtn.style.display = 'none';
                }
                
            } catch (e) {
                console.error('加载评论失败:', e);
                if (currentOffset === 0) {
                    list.innerHTML = '<div class="loading">加载失败: ' + e.message + '</div>';
                }
            } finally {
                btn.disabled = false;
                btn.textContent = '🔄 刷新';
            }
        }

        // 加载更多
        function loadMoreComments() {
            currentOffset += 50;
            loadComments();
        }

        // HTML 转义
        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        // 视频选择事件
        document.getElementById('video-select').addEventListener('change', (e) => {
            if (e.target.value) {
                selectVideo(e.target.value);
            }
        });

        // 启动
        init();
        
        // 每分钟自动刷新
        setInterval(() => {
            if (currentBvid) {
                currentOffset = 0;
                loadComments();
            }
        }, 60000);
    </script>
</body>
</html>`;
}

export default app