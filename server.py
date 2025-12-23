import asyncio
import datetime
import random
import itertools
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from bilibili_api import video, comment, Credential
from bilibili_api.exceptions import ResponseCodeException, ApiException
from pymongo import MongoClient


app = FastAPI()

# ==================== MongoDB Connection ====================
# 建议将敏感信息放入环境变量
MONGO_URI = "mongodb+srv://kimi:ambition0527@cluster0.tnfy9y6.mongodb.net/?appName=Cluster0"
mongo_client = MongoClient(MONGO_URI)
mongo_db = mongo_client["bilibili_monitor"]
comments_collection = mongo_db["comments"]
comments_collection.create_index("rpid", unique=True)


# ==================== State & Models ====================
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                pass


manager = ConnectionManager()


# --- 新增：单个Cookie配置模型 ---
class CookieConfig(BaseModel):
    sessdata: str
    buvid3: str = ""
    bili_jct: str = ""


# --- 修改：请求模型支持多Cookie ---
class ConfigRequest(BaseModel):
    bvid: str
    # 兼容旧模式（单账号），也可以直接传 cookies 列表
    sessdata: Optional[str] = None
    buvid3: Optional[str] = ""
    bili_jct: Optional[str] = ""
    
    # 新模式：多账号列表
    cookies: Optional[List[CookieConfig]] = None
    
    fetch_sub_comments: bool = True


class CredentialPool:
    """凭证池管理类：处理多账号轮询和重试"""
    def __init__(self, configs: List[CookieConfig]):
        self.credentials = []
        for cfg in configs:
            self.credentials.append(
                Credential(sessdata=cfg.sessdata, buvid3=cfg.buvid3, bili_jct=cfg.bili_jct)
            )
        # 创建无限循环迭代器
        self.iterator = itertools.cycle(self.credentials)
        self.total = len(self.credentials)

    def get_next(self) -> Credential:
        """获取下一个凭证"""
        if not self.credentials:
            raise Exception("No credentials configured")
        return next(self.iterator)

    async def execute_with_retry(self, func, *args, **kwargs):
        """
        执行API函数，如果失败则切换账号重试。
        最多重试次数等于凭证数量。
        """
        last_error = None
        # 尝试遍历一轮所有的账号
        for _ in range(self.total):
            cred = self.get_next()
            try:
                # 将 credential 注入到 kwargs 中
                kwargs['credential'] = cred
                return await func(*args, **kwargs)
            except (ResponseCodeException, ApiException) as e:
                # 遇到风控或API错误，记录错误并尝试下一个账号
                print(f"API Request failed with credential {id(cred)}: {e}. Switching account...")
                last_error = e
                # 简单休眠一下避免死循环过快
                await asyncio.sleep(0.5)
            except Exception as e:
                # 其他未知错误直接抛出
                raise e
        
        # 如果所有账号都失败
        print("All credentials failed.")
        if last_error:
            raise last_error


class MonitorState:
    def __init__(self):
        self.running = False
        self.target_bvid = ""
        self.cred_pool: Optional[CredentialPool] = None  # 替换原本的单 credential
        self.fetch_sub_comments = True
        self.task: Optional[asyncio.Task] = None
        self.last_rpid = 0
        self.oid = 0
        self.title = ""


monitor_state = MonitorState()


# ==================== Logic ====================
def save_comments_to_mongodb(comments_data: list, bvid: str, oid: int, title: str = ""):
    if not comments_data:
        return 0
    coll_name = f"comments_{bvid}"
    collection = mongo_db[coll_name]
    collection.create_index("rpid", unique=True)
    saved_count = 0
    for c in comments_data:
        try:
            location = ""
            if 'reply_control' in c and c['reply_control']:
                location = c['reply_control'].get('location', '')
            fans_medal = ""
            fans_detail = c['member'].get('fans_detail')
            if fans_detail:
                fans_medal = fans_detail.get('medal_name', '')
            
            doc = {
                "rpid": c['rpid'],
                "oid": oid,
                "bvid": bvid,
                "user": c['member']['uname'],
                "mid": c['member']['mid'],
                "content": c['content']['message'],
                "ctime": c['ctime'],
                "sex": c['member'].get('sex', '保密'),
                "location": location,
                "level": c['member']['level_info']['current_level'],
                "likes": c.get('like', 0),
                "rcount": c.get('rcount', 0),
                "fans_medal": fans_medal,
                "parent": c.get('parent', 0),
                "root": c.get('root', 0),
                "fetched_at": datetime.datetime.utcnow()
            }
            collection.update_one({"rpid": c['rpid']}, {"$set": doc}, upsert=True)
            saved_count += 1
        except Exception as e:
            continue
    try:
        metadata_coll = mongo_db["video_metadata"]
        metadata_coll.update_one(
            {"bvid": bvid},
            {"$set": {"bvid": bvid, "oid": oid, "title": title, "last_updated": datetime.datetime.utcnow(), "comment_count": collection.count_documents({}), "collection_name": coll_name}},
            upsert=True
        )
    except Exception:
        pass
    return saved_count


async def fetch_task():
    """Background task with Multi-Cookie Rotation"""
    print("Monitor task started with Credential Pool")
    
    pool = monitor_state.cred_pool
    if not pool or not pool.credentials:
        await manager.broadcast({"type": "status", "msg": "未配置有效的Cookie", "level": "error"})
        return

    # Init video info (Try with rotation)
    try:
        # 使用 pool.execute_with_retry 包装 API 调用
        # 注意：video.Video 本身初始化需要 credential，但 get_info 不需要传 credential（它是实例方法）
        # 这里为了简单，我们直接用第一个 credential 初始化 Video 对象，通常 get_info 不太容易风控
        # 或者我们重新封装一下获取 info 的逻辑
        
        async def get_video_info(credential):
            v = video.Video(bvid=monitor_state.target_bvid, credential=credential)
            return await v.get_info()

        info = await pool.execute_with_retry(get_video_info)
        
        monitor_state.oid = info['aid']
        monitor_state.title = info['title']
        print(f"Video Info: OID={monitor_state.oid}, Title={monitor_state.title}")
        
        await manager.broadcast({"type": "clear_comments"})
        await manager.broadcast({
            "type": "status", 
            "msg": f"已连接视频: {monitor_state.title} (使用 {pool.total} 个账号轮询)",
            "title": monitor_state.title,
            "level": "success"
        })
        
        # === 历史评论抓取 ===
        all_replies = []
        page = 1
        max_pages = 100 
        
        await manager.broadcast({"type": "status", "msg": "正在加载历史评论...", "level": "info"})
        
        while page <= max_pages:
            try:
                # 使用轮询机制获取评论
                # comment.get_comments 是静态/模块方法，可以直接传 credential
                page_data = await pool.execute_with_retry(
                    comment.get_comments,
                    oid=monitor_state.oid, 
                    type_=comment.CommentResourceType.VIDEO, 
                    order=comment.OrderType.LIKE,
                    page_index=page
                )
                
                replies = page_data.get('replies') or []
                page_info = page_data.get('page', {})
                total_count = page_info.get('count', 0)
                
                if not replies:
                    print(f"No more comments at page {page}")
                    break
                    
                all_replies.extend(replies)
                print(f"Page {page}: fetched {len(replies)}. Total: {len(all_replies)}/{total_count}")
                
                if len(all_replies) >= total_count:
                    print("Got all comments!")
                    break
                
                page += 1
                # 依然保留随机延迟，但因为有多账号，可以适当减少
                await asyncio.sleep(random.uniform(0.5, 1.5))
                
            except Exception as e:
                print(f"Error fetching page {page}: {e}")
                break
        
        # === 子评论抓取 ===
        if monitor_state.fetch_sub_comments:
            await manager.broadcast({
                "type": "status", 
                "msg": f"正在加载子评论... (主评论 {len(all_replies)} 条)",
                "level": "info"
            })
            
            sub_replies_count = 0
            for top_comment in all_replies[:]:
                rcount = top_comment.get('rcount', 0)
                if rcount > 0:
                    sub_page = 1
                    while True:
                        try:
                            # 动态定义抓取子评论的函数以适配 execute_with_retry
                            async def fetch_sub(credential, oid, rpid, page_idx):
                                c = comment.Comment(oid=oid, type_=comment.CommentResourceType.VIDEO, rpid=rpid, credential=credential)
                                return await c.get_sub_comments(page_index=page_idx, page_size=20)

                            sub_data = await pool.execute_with_retry(
                                fetch_sub,
                                oid=monitor_state.oid,
                                rpid=top_comment['rpid'],
                                page_idx=sub_page
                            )
                            
                            sub_list = sub_data.get('replies') or []
                            if not sub_list:
                                break
                            
                            all_replies.extend(sub_list)
                            sub_replies_count += len(sub_list)
                            
                            if len(sub_list) < 20:
                                break
                            sub_page += 1
                            await asyncio.sleep(0.1)
                        except Exception as e:
                            print(f"Error fetching sub-replies: {e}")
                            break
        
        print(f"Total comments fetched: {len(all_replies)}")
        
        if all_replies:
            all_replies.sort(key=lambda x: x['ctime'])
            monitor_state.last_rpid = max(r['rpid'] for r in all_replies)
            
            saved = save_comments_to_mongodb(
                all_replies, monitor_state.target_bvid, monitor_state.oid, monitor_state.title
            )
            
            # 格式化数据发给前端
            initial_comments = []
            for r in all_replies:
                try:
                    info = {
                        'rpid': r['rpid'],
                        'user': r['member']['uname'],
                        'mid': r['member']['mid'],
                        'avatar': r['member']['avatar'],
                        'content': r['content']['message'],
                        'time': datetime.datetime.fromtimestamp(r['ctime']).strftime('%Y-%m-%d %H:%M:%S'),
                        'level': r['member']['level_info']['current_level']
                    }
                    initial_comments.append(info)
                except: continue
            
            latest_comments = list(reversed(sorted(initial_comments, key=lambda x: x['time'], reverse=True)[:20]))
            
            await manager.broadcast({"type": "new_comments", "data": latest_comments})
            await manager.broadcast({
                "type": "status", 
                "msg": f"已保存 {saved} 条评论，显示最新 {len(latest_comments)} 条",
                "level": "success"
            })
        else:
            monitor_state.last_rpid = 0
            await manager.broadcast({"type": "status", "msg": "暂无历史评论，开始实时监控...", "level": "info"})
            
    except Exception as e:
        import traceback
        traceback.print_exc()
        await manager.broadcast({"type": "status", "msg": f"初始化失败: {str(e)}", "level": "error"})
        monitor_state.running = False
        return

    # === 实时监控循环 ===
    while monitor_state.running:
        try:
            # 实时监控也使用轮询
            data = await pool.execute_with_retry(
                comment.get_comments_lazy,
                oid=monitor_state.oid,
                type_=comment.CommentResourceType.VIDEO,
                order=comment.OrderType.TIME,
                offset=""
            )
            
            replies = data.get('replies') or []
            new_comments = []
            if replies:
                for r in replies:
                    if r['rpid'] > monitor_state.last_rpid:
                        info = {
                            'rpid': r['rpid'],
                            'user': r['member']['uname'],
                            'mid': r['member']['mid'],
                            'avatar': r['member']['avatar'],
                            'content': r['content']['message'],
                            'time': datetime.datetime.fromtimestamp(r['ctime']).strftime('%H:%M:%S'),
                            'level': r['member']['level_info']['current_level']
                        }
                        new_comments.append(info)
                    else:
                        break
            
            if new_comments:
                max_id = max([c['rpid'] for c in new_comments])
                monitor_state.last_rpid = max(monitor_state.last_rpid, max_id)
                await manager.broadcast({"type": "new_comments", "data": list(reversed(new_comments))})
                # 同时也保存到数据库
                # 注意：raw data 在 replies 里，info 是格式化后的
                # 我们需要筛选出 raw replies
                raw_new_replies = [r for r in replies if r['rpid'] > (monitor_state.last_rpid - len(new_comments))]
                # 这里逻辑稍微有点复杂，简单点：直接拿 new_comments 对应的 rpid 去 replies 里找
                to_save = []
                new_rpids = set(c['rpid'] for c in new_comments)
                for r in replies:
                    if r['rpid'] in new_rpids:
                        to_save.append(r)
                if to_save:
                    save_comments_to_mongodb(to_save, monitor_state.target_bvid, monitor_state.oid, monitor_state.title)

        except Exception as e:
            await manager.broadcast({"type": "status", "msg": f"监控异常: {str(e)}", "level": "warning"})
            
        # 多账号模式下，休眠时间可以适当缩短
        sleep_time = 10 + random.uniform(-2, 2)
        await asyncio.sleep(sleep_time)


# ==================== Endpoints ====================
@app.post("/api/start")
async def start_monitor(req: ConfigRequest):
    if monitor_state.running:
        return {"status": "already_running"}
    
    # 构建配置列表
    cookies_configs = []
    
    # 1. 优先使用新的 cookies 列表
    if req.cookies:
        cookies_configs = req.cookies
    # 2. 如果没有列表，尝试兼容旧的单账号字段
    elif req.sessdata:
        cookies_configs.append(CookieConfig(
            sessdata=req.sessdata,
            buvid3=req.buvid3,
            bili_jct=req.bili_jct
        ))
    
    if not cookies_configs:
        return {"status": "error", "msg": "未提供任何Cookie信息"}

    monitor_state.target_bvid = req.bvid
    # 初始化凭证池
    monitor_state.cred_pool = CredentialPool(cookies_configs)
    monitor_state.fetch_sub_comments = req.fetch_sub_comments
    
    monitor_state.running = True
    monitor_state.task = asyncio.create_task(fetch_task())
    return {"status": "started", "account_count": len(cookies_configs)}


@app.post("/api/stop")
async def stop_monitor():
    if not monitor_state.running:
        return {"status": "not_running"}
    
    monitor_state.running = False
    if monitor_state.task:
        monitor_state.task.cancel()
        try:
            await monitor_state.task
        except asyncio.CancelledError:
            pass
        monitor_state.task = None
        
    await manager.broadcast({"type": "status", "msg": "监控已停止", "level": "info"})
    return {"status": "stopped"}


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        status_msg = "监控进行中" if monitor_state.running else "等待开始..."
        await websocket.send_json({
            "type": "init", 
            "running": monitor_state.running,
            "title": monitor_state.title,
            "status": status_msg
        })
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


app.mount("/", StaticFiles(directory="static", html=True), name="static")


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
