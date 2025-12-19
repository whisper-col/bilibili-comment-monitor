import asyncio
import datetime
from typing import List, Optional
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from bilibili_api import video, comment, Credential
from pymongo import MongoClient

app = FastAPI()

# ==================== MongoDB Connection ====================
MONGO_URI = "mongodb+srv://kimi:ambition0527@cluster0.tnfy9y6.mongodb.net/?appName=Cluster0"
mongo_client = MongoClient(MONGO_URI)
mongo_db = mongo_client["bilibili_monitor"]
comments_collection = mongo_db["comments"]

# Create index on rpid for faster lookups and deduplication
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

class MonitorState:
    def __init__(self):
        self.running = False
        self.target_bvid = ""
        self.sessdata = ""
        self.buvid3 = ""
        self.bili_jct = ""
        self.fetch_sub_comments = True
        self.task: Optional[asyncio.Task] = None
        self.last_rpid = 0
        self.oid = 0
        self.title = ""

monitor_state = MonitorState()

class ConfigRequest(BaseModel):
    bvid: str
    sessdata: str
    buvid3: str = ""
    bili_jct: str = ""
    fetch_sub_comments: bool = True

# ==================== Logic ====================

def save_comments_to_mongodb(comments_data: list, bvid: str, oid: int):
    """
    Save comments to MongoDB with upsert (avoid duplicates)
    """
    if not comments_data:
        return 0
    
    saved_count = 0
    for c in comments_data:
        try:
            doc = {
                "rpid": c['rpid'],
                "oid": oid,
                "bvid": bvid,
                "user": c['member']['uname'],
                "mid": c['member']['mid'],
                "content": c['content']['message'],
                "ctime": c['ctime'],
                "level": c['member']['level_info']['current_level'],
                "likes": c.get('like', 0),
                "rcount": c.get('rcount', 0),
                "fetched_at": datetime.datetime.utcnow()
            }
            # Upsert: update if exists, insert if not
            comments_collection.update_one(
                {"rpid": c['rpid']},
                {"$set": doc},
                upsert=True
            )
            saved_count += 1
        except Exception as e:
            print(f"Error saving comment {c.get('rpid')}: {e}")
            continue
    
    return saved_count

async def fetch_task():
    """Background task to fetch comments loops"""
    print("Monitor task started")
    credential = Credential(
        sessdata=monitor_state.sessdata, 
        buvid3=monitor_state.buvid3,
        bili_jct=monitor_state.bili_jct
    )
    
    # Init video info
    try:
        v = video.Video(bvid=monitor_state.target_bvid, credential=credential)
        info = await v.get_info()
        monitor_state.oid = info['aid']
        monitor_state.title = info['title']
        print(f"Video Info: OID={monitor_state.oid}, Title={monitor_state.title}")
        
        await manager.broadcast({
            "type": "clear_comments"  # Clear previous video's comments
        })
        
        await manager.broadcast({
            "type": "status", 
            "msg": f"已连接视频: {monitor_state.title}",
            "title": monitor_state.title,
            "level": "success"
        })
        
        # Fetch ALL history comments using page-based API
        all_replies = []
        page = 1
        max_pages = 100  # Safety limit (100 pages * ~20 comments = 2000 comments max)
        
        await manager.broadcast({
            "type": "status", 
            "msg": "正在加载历史评论...",
            "level": "info"
        })
        
        while page <= max_pages:
            try:
                # Use old get_comments with page_index for reliable pagination
                page_data = await comment.get_comments(
                    oid=monitor_state.oid, 
                    type_=comment.CommentResourceType.VIDEO, 
                    order=comment.OrderType.LIKE,  # LIKE to get all, we'll sort by time later
                    page_index=page,
                    credential=credential
                )
                
                replies = page_data.get('replies') or []
                page_info = page_data.get('page', {})
                total_count = page_info.get('count', 0)
                
                if not replies:
                    print(f"No more comments at page {page}")
                    break
                    
                all_replies.extend(replies)
                print(f"Page {page}: fetched {len(replies)} comments. Total: {len(all_replies)}/{total_count}")
                
                # Check if we've got all comments
                if len(all_replies) >= total_count:
                    print("Got all comments!")
                    break
                
                page += 1
                
                # Small delay to avoid rate limiting
                await asyncio.sleep(0.3)
                
            except Exception as e:
                print(f"Error fetching page {page}: {e}")
                import traceback
                traceback.print_exc()
                break
        
        print(f"Top-level comments fetched: {len(all_replies)}")
        
        # Conditionally fetch sub-replies
        sub_replies_count = 0
        if monitor_state.fetch_sub_comments:
            await manager.broadcast({
                "type": "status", 
                "msg": f"正在加载子评论... (已获取 {len(all_replies)} 条主评论)",
                "level": "info"
            })
            
            for top_comment in all_replies[:]:  # Iterate over a copy
                rcount = top_comment.get('rcount', 0)
                if rcount > 0:
                    try:
                        # Create Comment object to fetch sub-replies
                        c = comment.Comment(
                            oid=monitor_state.oid,
                            type_=comment.CommentResourceType.VIDEO,
                            rpid=top_comment['rpid'],
                            credential=credential
                        )
                        
                        # Fetch all pages of sub-replies (max 20 per page)
                        sub_page = 1
                        while True:
                            sub_data = await c.get_sub_comments(page_index=sub_page, page_size=20)
                            sub_list = sub_data.get('replies') or []
                            
                            if not sub_list:
                                break
                                
                            all_replies.extend(sub_list)
                            sub_replies_count += len(sub_list)
                            
                            # Check if we got all sub-replies
                            if len(sub_list) < 20:
                                break
                                
                            sub_page += 1
                            await asyncio.sleep(0.1)  # Rate limit
                            
                    except Exception as e:
                        print(f"Error fetching sub-replies for rpid {top_comment['rpid']}: {e}")
                        continue
        
        print(f"Sub-replies fetched: {sub_replies_count}")
        print(f"Total comments fetched: {len(all_replies)}")
        
        if all_replies:
            # Sort by time (ctime) - oldest first for processing
            all_replies.sort(key=lambda x: x['ctime'])
            
            # Set last_rpid to the newest comment (last after sorting by time)
            monitor_state.last_rpid = max(r['rpid'] for r in all_replies)
            print(f"Set last_rpid to {monitor_state.last_rpid}")
            
            # Process comments - already sorted oldest to newest
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
                except Exception as e:
                    print(f"Error parsing comment: {e}")
                    continue
            
            print(f"Broadcasting {len(initial_comments)} history comments.")
            
            # Save to MongoDB
            saved = save_comments_to_mongodb(all_replies, monitor_state.target_bvid, monitor_state.oid)
            print(f"Saved {saved} comments to MongoDB.")
            
            await manager.broadcast({
                "type": "new_comments", 
                "data": initial_comments
            })
            
            await manager.broadcast({
                "type": "status", 
                "msg": f"已加载 {len(initial_comments)} 条历史评论，开始实时监控...",
                "level": "success"
            })
        else:
            print("No history comments found.")
            monitor_state.last_rpid = 0
            await manager.broadcast({
                "type": "status", 
                "msg": "暂无历史评论，开始实时监控...",
                "level": "info"
            })
            
    except Exception as e:
        await manager.broadcast({"type": "status", "msg": f"初始化失败: {str(e)}", "level": "error"})
        monitor_state.running = False
        return

    while monitor_state.running:
        try:
            # Use the new lazy API for real-time polling too
            data = await comment.get_comments_lazy(
                oid=monitor_state.oid, 
                type_=comment.CommentResourceType.VIDEO, 
                order=comment.OrderType.TIME, 
                offset="",  # Always get latest
                credential=credential
            )
            replies = data.get('replies') or []
            
            new_comments = []
            if replies:
                for r in replies:
                    current_rpid = r['rpid']
                    if current_rpid > monitor_state.last_rpid:
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
                # Update last_rpid
                max_id = max([c['rpid'] for c in new_comments])
                monitor_state.last_rpid = max(monitor_state.last_rpid, max_id)
                
                # Send to frontend (reversed to match chronological order usually preferred in logs, 
                # but frontend can handle prepending. Let's send list and let frontend handle)
                # Send to frontend
                # We want to send them such that they appear correct.
                # new_comments was built by appending [Newest...Newer_than_last] (API returns Newest -> Oldest)
                # API Loop: r in replies (Newest first).
                # new_comments.append(r) -> [Newest, NextNewest...]
                # We need to reverse this too for the same reason.
                
                await manager.broadcast({
                    "type": "new_comments", 
                    "data": list(reversed(new_comments))
                })
                
        except Exception as e:
            await manager.broadcast({"type": "status", "msg": f"API请求错误: {str(e)}", "level": "warning"})
            
        await asyncio.sleep(5)

# ==================== Endpoints ====================

@app.post("/api/start")
async def start_monitor(req: ConfigRequest):
    if monitor_state.running:
        return {"status": "already_running"}
    
    monitor_state.target_bvid = req.bvid
    monitor_state.sessdata = req.sessdata
    monitor_state.buvid3 = req.buvid3
    monitor_state.bili_jct = req.bili_jct
    monitor_state.fetch_sub_comments = req.fetch_sub_comments
    monitor_state.running = True
    monitor_state.task = asyncio.create_task(fetch_task())
    return {"status": "started"}

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
        # Send current status on connect
        status_msg = "监控进行中" if monitor_state.running else "等待开始..."
        await websocket.send_json({
            "type": "init", 
            "running": monitor_state.running,
            "title": monitor_state.title,
            "status": status_msg
        })
        while True:
            # Keep connection open
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

# Mount static files
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
