import asyncio
import base64
import hashlib
import json
import math
import os
import queue
import struct
import sys
import tempfile
import threading
import time
import traceback
import uuid
from typing import Dict, Tuple, List, Any, Optional

try:
    import adsk.core
    import adsk.fusion
    FUSION_AVAILABLE = True
except ImportError:
    FUSION_AVAILABLE = False

def _log(msg):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    log_msg = f"[{timestamp}] [EasyEDA] {msg}"
    if FUSION_AVAILABLE:
        try:
            app = adsk.core.Application.get()
            if app:
                app.log(log_msg)
                return
        except Exception:
            pass
    print(log_msg)

# ==================== WebSocket ====================
_WS_OP_TEXT = 0x1
_WS_OP_BINARY = 0x2
_WS_OP_CLOSE = 0x8
_WS_OP_PING = 0x9
_WS_OP_PONG = 0xA
_WS_MAGIC = b'258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

class _WebSocketConnection:
    def __init__(self, reader, writer):
        self._reader = reader
        self._writer = writer
        self.remote_address = writer.get_extra_info('peername')
        self._closed = False

    async def send(self, data):
        if isinstance(data, str):
            payload = data.encode('utf-8')
            opcode = _WS_OP_TEXT
        else:
            payload = data
            opcode = _WS_OP_BINARY
        self._writer.write(self._encode_frame(opcode, payload))
        await self._writer.drain()

    async def close(self):
        if not self._closed:
            self._closed = True
            try:
                self._writer.write(self._encode_frame(_WS_OP_CLOSE, b''))
                await self._writer.drain()
            except Exception:
                pass
            try:
                self._writer.close()
            except Exception:
                pass

    async def recv(self):
        while not self._closed:
            message_data = bytearray()
            message_opcode = None
            while True:
                try:
                    fin, opcode, payload = await self._read_frame()
                except Exception:
                    self._closed = True
                    raise ConnectionError("WebSocket read error")
                if opcode is None:
                    self._closed = True
                    raise ConnectionError("Connection closed")
                if opcode == _WS_OP_PING:
                    self._writer.write(self._encode_frame(_WS_OP_PONG, payload))
                    await self._writer.drain()
                    continue
                elif opcode == _WS_OP_CLOSE:
                    await self.close()
                    raise ConnectionError("WebSocket closed by peer")
                elif opcode == _WS_OP_PONG:
                    continue
                if message_opcode is None:
                    if opcode not in (_WS_OP_TEXT, _WS_OP_BINARY):
                        raise ConnectionError("Unexpected opcode: {}".format(opcode))
                    message_opcode = opcode
                else:
                    if opcode != 0x0:
                        raise ConnectionError("Unexpected continuation opcode")
                message_data.extend(payload)
                if fin:
                    break
            if message_opcode == _WS_OP_TEXT:
                return message_data.decode('utf-8')
            elif message_opcode == _WS_OP_BINARY:
                return bytes(message_data)
        raise ConnectionError("WebSocket closed")

    def _encode_frame(self, opcode, payload):
        frame = bytearray()
        frame.append(0x80 | opcode)
        length = len(payload)
        if length < 126:
            frame.append(length)
        elif length < 65536:
            frame.append(126)
            frame.extend(struct.pack('!H', length))
        else:
            frame.append(127)
            frame.extend(struct.pack('!Q', length))
        frame.extend(payload)
        return bytes(frame)

    async def _read_frame(self):
        try:
            header = await self._reader.readexactly(2)
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            self._closed = True
            return False, None, None
        fin = (header[0] & 0x80) != 0
        opcode = header[0] & 0x0F
        masked = (header[1] & 0x80) != 0
        length = header[1] & 0x7F
        try:
            if length == 126:
                data = await self._reader.readexactly(2)
                length = struct.unpack('!H', data)[0]
            elif length == 127:
                data = await self._reader.readexactly(8)
                length = struct.unpack('!Q', data)[0]
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            self._closed = True
            return False, None, None
        try:
            if masked:
                mask_key = await self._reader.readexactly(4)
                payload = bytearray(await self._reader.readexactly(length))
                for i in range(len(payload)):
                    payload[i] ^= mask_key[i % 4]
                payload = bytes(payload)
            else:
                payload = await self._reader.readexactly(length)
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            self._closed = True
            return False, None, None
        return fin, opcode, payload

    async def __aiter__(self):
        while not self._closed:
            message_data = bytearray()
            message_opcode = None
            while True:
                try:
                    fin, opcode, payload = await self._read_frame()
                except Exception:
                    self._closed = True
                    break
                if opcode is None:
                    self._closed = True
                    break
                if opcode == _WS_OP_PING:
                    self._writer.write(self._encode_frame(_WS_OP_PONG, payload))
                    await self._writer.drain()
                    continue
                elif opcode == _WS_OP_CLOSE:
                    await self.close()
                    break
                elif opcode == _WS_OP_PONG:
                    continue
                if message_opcode is None:
                    if opcode not in (_WS_OP_TEXT, _WS_OP_BINARY):
                        break
                    message_opcode = opcode
                else:
                    if opcode != 0x0:
                        break
                message_data.extend(payload)
                if fin:
                    break
            if self._closed or message_opcode is None:
                break
            if message_opcode == _WS_OP_TEXT:
                yield message_data.decode('utf-8')
            elif message_opcode == _WS_OP_BINARY:
                yield bytes(message_data)

async def _ws_handshake(reader, writer):
    await reader.readline()
    headers = {}
    while True:
        line = await reader.readline()
        if line in (b'\r\n', b'\n', b''):
            break
        if b':' in line:
            key, value = line.split(b':', 1)
            headers[key.strip().lower()] = value.strip()
    ws_key = headers.get(b'sec-websocket-key', b'')
    accept = base64.b64encode(hashlib.sha1(ws_key + _WS_MAGIC).digest()).decode('ascii')
    response = (
        'HTTP/1.1 101 Switching Protocols\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        'Sec-WebSocket-Accept: {}\r\n'
        '\r\n'
    ).format(accept)
    writer.write(response.encode('ascii'))
    await writer.drain()

async def _ws_serve(handler, host, port):
    async def on_connect(reader, writer):
        try:
            await _ws_handshake(reader, writer)
        except Exception:
            try:
                writer.close()
            except Exception:
                pass
            return
        ws = _WebSocketConnection(reader, writer)
        try:
            await handler(ws)
        except Exception:
            pass
        finally:
            try:
                if not ws._closed:
                    ws._closed = True
                    writer.close()
            except Exception:
                pass
    server = await asyncio.start_server(on_connect, host, port)
    async with server:
        await server.serve_forever()

# ==================== config ====================
HOST = "0.0.0.0"
PORT = 8767
TEMP_DIR = tempfile.gettempdir()

# ==================== state ====================
designator_map: Dict[str, str] = {}
name_to_designator: Dict[str, str] = {}
_initial_offsets: Dict[str, Tuple[float, float, float, float, float]] = {}
upload_sessions: Dict[str, dict] = {}
monitor_enabled = False
_active_client = None
_ws_loop = None
_last_positions: Dict[str, Tuple[float, float, float]] = {}
_last_selected: set = set()
_imported_design = None

# ==================== TaskManager (CustomEvent + Queue) ====================
_task_queue = queue.Queue()
_custom_event_id = 'easyeda-sync-' + uuid.uuid4().hex[:8]
_handlers = []  # 全局列表，防止 Python GC 回收 handler

class _TaskEventHandler(adsk.core.CustomEventHandler):
    def notify(self, args):
        count = 0
        while True:
            try:
                task = _task_queue.get_nowait()
            except queue.Empty:
                break
            try:
                result = task['func'](*task.get('args', ()), **task.get('kwargs', {}))
                task['result'] = result
            except Exception:
                task['result'] = None
                task['error'] = traceback.format_exc()
            finally:
                task['done'].set()
            count += 1

def _call_main(func, *args, timeout=5.0):
    """同步：后台线程 → 主线程执行，阻塞等待结果"""
    task = {
        'func': func, 'args': args, 'kwargs': {},
        'result': None, 'error': None,
        'done': threading.Event(),
    }
    _task_queue.put(task)
    try:
        app = adsk.core.Application.get()
        if app:
            app.fireCustomEvent(_custom_event_id)
    except Exception:
        pass
    if not task['done'].wait(timeout):
        _log("[TM] timeout: {}".format(func.__name__))
        return None
    if task['error']:
        _log("[TM] error: {}".format(task['error'][:200]))
        return None
    return task['result']

def _call_main_fire(func, *args):
    """异步：后台线程 → 主线程执行，不等待结果"""
    task = {
        'func': func, 'args': args, 'kwargs': {},
        'result': None, 'error': None,
        'done': threading.Event(),
    }
    _task_queue.put(task)
    try:
        app = adsk.core.Application.get()
        if app:
            app.fireCustomEvent(_custom_event_id)
    except Exception:
        pass

async def _call_main_await(func, *args, timeout=30.0):
    """async：后台线程 → 主线程执行，不阻塞事件循环"""
    task = {
        'func': func, 'args': args, 'kwargs': {},
        'result': None, 'error': None,
        'done': threading.Event(),
    }
    _task_queue.put(task)
    try:
        app = adsk.core.Application.get()
        if app:
            app.fireCustomEvent(_custom_event_id)
    except Exception:
        pass
    deadline = time.time() + timeout
    while not task['done'].is_set():
        await asyncio.sleep(0.05)
        if time.time() > deadline:
            _log("[TM] async timeout: {}".format(func.__name__))
            return None
    if task['error']:
        _log("[TM] error: {}".format(task['error'][:200]))
        return None
    return task['result']

def _push_to_client(data):
    """从主线程安全推送 WebSocket 消息"""
    if _active_client is not None and _ws_loop is not None:
        try:
            asyncio.run_coroutine_threadsafe(_send_to_client(data), _ws_loop)
        except Exception:
            pass

# ==================== Fusion helpers ====================
def _get_app() -> Optional[Any]:
    if not FUSION_AVAILABLE:
        return None
    return adsk.core.Application.get()

def _get_design() -> Optional[Any]:
    global _imported_design
    if _imported_design:
        return _imported_design
    app = _get_app()
    if not app:
        return None
    design = app.activeProduct
    if not design or not isinstance(design, adsk.fusion.Design):
        return None
    return design

def _get_occ_transform(occ) -> Tuple[float, float, float, float]:
    transform = occ.transform2
    t = transform.translation
    x = t.x
    y = t.y
    z = t.z
    rot_z = math.degrees(math.atan2(transform.getCell(1, 0), transform.getCell(0, 0)))
    return x, y, z, rot_z

def _set_occ_transform(occ, x_cm, y_cm, z_cm, rotation_deg) -> None:
    transform = occ.transform2
    transform.setToIdentity()
    rad = math.radians(rotation_deg)
    cos_r = math.cos(rad)
    sin_r = math.sin(rad)
    transform.setCell(0, 0, cos_r)
    transform.setCell(0, 1, -sin_r)
    transform.setCell(1, 0, sin_r)
    transform.setCell(1, 1, cos_r)
    transform.setCell(2, 2, 1.0)
    transform.setCell(3, 3, 1.0)
    transform.translation = adsk.core.Vector3D.create(x_cm, y_cm, z_cm)
    occ.transform2 = transform

def _import_step(filepath: str) -> bool:
    global _imported_design
    app = _get_app()
    if not app:
        _log("No app")
        return False
    # 新建一个 Fusion 设计文档
    try:
        doc = app.documents.add(adsk.core.DocumentTypes.FusionDesignDocumentType)
        if doc:
            doc.activate()
            _log("Created new design document")
    except Exception:
        _log("Create document failed, using current: " + traceback.format_exc()[:200])
    # 导入 STEP
    try:
        result = app.executeTextCommand('Translator.Import {}'.format(filepath))
        _log("Import result: {}".format((result or '')[:200]))
    except Exception:
        _log("Import failed: " + traceback.format_exc())
        return False
    time.sleep(3)
    try:
        design = app.activeProduct
        if design and isinstance(design, adsk.fusion.Design):
            _imported_design = design
            # 切换到直接设计模式
            try:
                if design.designType != adsk.fusion.DesignTypes.DirectDesignType:
                    design.designType = adsk.fusion.DesignTypes.DirectDesignType
                    _log("Switched to Direct Design mode")
            except Exception:
                pass
            occs = design.rootComponent.allOccurrences.count
            _log("Design OK: {} occs".format(occs))
            return occs > 0
    except Exception:
        pass
    _log("No design after import")
    return False

def _match_designator(short_name: str, designator: str) -> bool:
    if not short_name or not designator:
        return False
    parts = short_name.split(' ')
    for part in parts:
        desig = part.split('~')[0].strip()
        if desig == designator:
            return True
    return False

def _do_build_mapping(components: List[dict]) -> List[dict]:
    global designator_map, name_to_designator, _initial_offsets
    design = _get_design()
    if not design:
        return []
    _initial_offsets.clear()
    mapping = []
    root = design.rootComponent
    all_occs = root.allOccurrences
    for comp_data in components:
        designator = comp_data.get("designator", "")
        if not designator:
            continue
        occ = None
        for i in range(all_occs.count):
            o = all_occs.item(i)
            short_name = o.name.split(":")[0].strip()
            if _match_designator(short_name, designator):
                occ = o
                break
        if occ:
            occ_name = occ.name
            short = occ_name.split(":")[0].strip()
            designator_map[designator] = occ_name
            name_to_designator[short] = designator
            mapping.append({"designator": designator, "fusion360Name": short})
            fx, fy, fz, frot = _get_occ_transform(occ)
            eda_x = comp_data.get("x", 0)
            eda_y = comp_data.get("y", 0)
            eda_rot = comp_data.get("rotation", 0)
            _initial_offsets[designator] = (eda_x, eda_y, eda_rot, fx, fy, fz, frot)
    _log("Mapping: {} / {} matched".format(len(mapping), len(components)))
    return mapping

def _do_position_update(designator: str, x_mm: float, y_mm: float, rotation: float) -> None:
    occ_name = designator_map.get(designator)
    if not occ_name:
        return
    design = _get_design()
    if not design:
        return
    occ = design.rootComponent.allOccurrences.itemByName(occ_name)
    if not occ:
        return
    offset = _initial_offsets.get(designator)
    if offset:
        init_eda_x, init_eda_y, init_eda_rot, init_fx, init_fy, init_fz, init_frot = offset
        new_fx = init_fx + (x_mm - init_eda_x) / 10.0
        new_fy = init_fy + (y_mm - init_eda_y) / 10.0
        new_fz = init_fz
        new_rot = init_frot + (rotation - init_eda_rot)
    else:
        new_fx = x_mm / 10.0
        new_fy = y_mm / 10.0
        _, _, new_fz, new_rot = _get_occ_transform(occ)
    try:
        _set_occ_transform(occ, new_fx, new_fy, new_fz, new_rot)
        rx, ry, rz, rrot = _get_occ_transform(occ)
        _last_positions[designator] = (rx * 10.0, ry * 10.0, rrot)
    except Exception:
        _log("[position] failed: {}".format(traceback.format_exc()[:200]))

def _snapshot_positions():
    global _last_positions
    design = _get_design()
    if not design:
        return
    root = design.rootComponent
    for designator, occ_name in designator_map.items():
        try:
            occ = root.allOccurrences.itemByName(occ_name)
            if occ:
                x, y, z, rot = _get_occ_transform(occ)
                _last_positions[designator] = (x * 10.0, y * 10.0, rot)
        except Exception:
            pass

def _do_cross_probe(designator: str) -> None:
    occ_name = designator_map.get(designator)
    if not occ_name:
        return
    design = _get_design()
    if not design:
        return
    occ = design.rootComponent.allOccurrences.itemByName(occ_name)
    if not occ:
        return
    x, y, z, _ = _get_occ_transform(occ)
    app = _get_app()
    if not app:
        return
    # 导航相机到元件位置
    try:
        camera = app.activeViewport.camera
        target = camera.target
        eye = camera.eye
        dx, dy, dz = x - target.x, y - target.y, z - target.z
        camera.target = adsk.core.Point3D.create(x, y, z)
        camera.eye = adsk.core.Point3D.create(eye.x + dx, eye.y + dy, eye.z + dz)
        camera.isSmoothTransition = True
        app.activeViewport.camera = camera
    except Exception:
        pass
    # 选中元件（保持高亮状态，用户点击其他地方自动取消）
    try:
        sel = app.userInterface.activeSelections
        sel.clear()
        sel.add(occ)
    except Exception:
        # add() 不可用时回退到透明度高亮
        try:
            comp = occ.component
            if comp:
                original_opacity = comp.opacity
                comp.opacity = 0.3
                def _delayed():
                    _call_main_fire(_restore_highlight, occ_name, original_opacity)
                t = threading.Timer(1.5, _delayed)
                t.daemon = True
                t.start()
        except Exception:
            pass

def _restore_highlight(occ_name, original_opacity):
    design = _get_design()
    if design:
        occ = design.rootComponent.allOccurrences.itemByName(occ_name)
        if occ and occ.component:
            occ.component.opacity = original_opacity

def _do_delete_object(designator: str) -> None:
    _log("[DELETE-F360] 开始: designator={}".format(designator))
    occ_name = designator_map.pop(designator, None)
    if not occ_name:
        _log("[DELETE-F360] 未找到映射: {}".format(designator))
        return
    design = _get_design()
    if not design:
        return
    occ = design.rootComponent.allOccurrences.itemByName(occ_name)
    if not occ:
        _log("[DELETE-F360] occ不存在: {}".format(occ_name))
        name_to_designator.pop(occ_name.split(":")[0].strip(), None)
        return

    # 尝试按名称匹配删除 body
    deleted_body = False
    try:
        for bodies_src in [
            occ.component.bRepBodies if occ.component else None,
        ]:
            if not bodies_src:
                continue
            for i in range(bodies_src.count):
                body = bodies_src.item(i)
                if _match_designator(body.name, designator):
                    body.deleteMe()
                    deleted_body = True
                    _log("[DELETE-F360] 删除body: '{}'".format(body.name))
                    break
            if deleted_body:
                break
    except Exception:
        _log("[DELETE-F360] body搜索异常: " + traceback.format_exc())

    # body 未匹配时，检查是否为独立组件后回退到 occ.deleteMe()
    if not deleted_body:
        try:
            comp = occ.component
            if comp:
                ref_count = sum(
                    1 for i in range(design.rootComponent.allOccurrences.count)
                    if design.rootComponent.allOccurrences.item(i).component == comp
                )
                if ref_count <= 1:
                    occ.deleteMe()
                    _log("[DELETE-F360] occ.deleteMe(): {}".format(occ_name))
                else:
                    _log("[DELETE-F360] 跳过删除(共享组件, {}个引用)".format(ref_count))
            else:
                occ.deleteMe()
        except Exception:
            _log("[DELETE-F360] 删除异常: " + traceback.format_exc())

    name_to_designator.pop(occ_name.split(":")[0].strip(), None)
    _log("[DELETE-F360] 完成: designator={}, deleted_body={}".format(designator, deleted_body))

def _is_fusion_busy() -> bool:
    try:
        app = _get_app()
        if not app:
            return False
        cmd = app.userInterface.activeCommand
        if cmd == 'SelectCommand':
            return False
        return True
    except Exception:
        return False

def _do_poll_positions() -> List[dict]:
    global _last_positions
    if not monitor_enabled or not designator_map:
        return []
    if _is_fusion_busy():
        return []
    design = _get_design()
    if not design:
        return []
    updates = []
    root = design.rootComponent
    deleted_designators = []
    for designator, occ_name in list(designator_map.items()):
        try:
            occ = root.allOccurrences.itemByName(occ_name)
            if not occ:
                # occurrence 不存在了，说明在 Fusion360 里被删除了
                _log("[轮询-删除检测] {} 的 occ '{}' 不存在了，通知EDA删除".format(designator, occ_name))
                deleted_designators.append(designator)
                updates.append({
                    "type": "delete_from_fusion360",
                    "designator": designator,
                })
                continue
            x, y, z, rot = _get_occ_transform(occ)
            x_mm = x * 10.0
            y_mm = y * 10.0
            last = _last_positions.get(designator)
            if last is None or abs(x_mm - last[0]) > 0.1 or abs(y_mm - last[1]) > 0.1 or abs(rot - last[2]) > 0.5:
                _log("[轮询] {} 位置变化: ({:.2f},{:.2f})mm".format(designator, x_mm, y_mm))
                updates.append({
                    "type": "position_update_from_fusion360",
                    "designator": designator,
                    "x": x_mm, "y": y_mm, "rotation": rot,
                })
            _last_positions[designator] = (x_mm, y_mm, rot)
        except Exception as e:
            _log("[轮询] 读取 {} 失败: {}".format(designator, e))
    # 清理已删除元件的映射
    for desig in deleted_designators:
        occ_name = designator_map.pop(desig, None)
        if occ_name:
            name_to_designator.pop(occ_name.split(":")[0].strip(), None)
        _last_positions.pop(desig, None)
    return updates

def _check_selection() -> list:
    global _last_selected
    results = []
    if not monitor_enabled:
        return results
    if _is_fusion_busy():
        return results
    try:
        app = _get_app()
        if not app:
            return results
        design = _get_design()
        if not design:
            return results
        current = set()
        sel = app.userInterface.activeSelections
        for i in range(sel.count):
            it = sel.item(i)
            if it and it.entity:
                nm = getattr(it.entity, 'name', '')
                if nm:
                    current.add(nm)
        new_sel = current - _last_selected
        for nm in new_sel:
            short = nm.split(":")[0].strip()
            des = name_to_designator.get(short)
            if des:
                _log("[选中] {} -> {}".format(nm, des))
                # 获取元件位置用于导航
                occ_name = designator_map.get(des)
                occ = design.rootComponent.allOccurrences.itemByName(occ_name) if occ_name else None
                x_mm, y_mm, rot = 0, 0, 0
                if occ:
                    try:
                        x, y, z, rot = _get_occ_transform(occ)
                        x_mm = x * 10.0  # cm -> mm
                        y_mm = y * 10.0
                    except Exception:
                        pass
                results.append({
                    "type": "cross_probe_from_fusion360",
                    "designator": des,
                    "x": x_mm,
                    "y": y_mm,
                    "rotation": rot
                })
        _last_selected = current
    except Exception as e:
        _log("[选中检查错误] {}".format(e))
    return results

# ==================== thread helpers ====================
async def _send_to_client(data: dict) -> None:
    if _active_client is not None:
        try:
            await _active_client.send(json.dumps(data))
        except Exception:
            pass

# ==================== WebSocket server ====================
async def _handle_message(raw_message):
    global monitor_enabled
    try:
        message = json.loads(raw_message)
        msg_type = message.get("type", "")
        if msg_type == "ping":
            await _send_to_client({"type": "pong"})
        elif msg_type == "file_upload_start":
            session_id = message["sessionId"]
            upload_sessions[session_id] = {
                "filename": message["filename"],
                "totalSize": message["totalSize"],
                "totalChunks": message["totalChunks"],
                "chunks": {},
            }
            await _send_to_client({"type": "upload_started", "sessionId": session_id})
        elif msg_type == "file_upload_chunk":
            session_id = message["sessionId"]
            session = upload_sessions.get(session_id)
            if session:
                session["chunks"][message["index"]] = message["data"]
                received = len(session["chunks"])
                await _send_to_client({
                    "type": "chunk_received",
                    "sessionId": session_id,
                    "index": message["index"],
                    "received": received,
                    "total": session["totalChunks"],
                })
                if received == session["totalChunks"]:
                    await _process_upload(session_id)
        elif msg_type == "build_mapping":
            mapping = await _call_main_await(_do_build_mapping, message["components"])
            await _send_to_client({"type": "mapping_result", "mapping": mapping or []})
        elif msg_type == "enable_monitor":
            monitor_enabled = True
            _last_positions.clear()
            await _call_main_await(_snapshot_positions)
            _start_poll_timer()
            _log("Monitor enabled")
        elif msg_type == "disable_monitor":
            monitor_enabled = False
            _last_positions.clear()
            _stop_poll_timer()
            _log("Monitor disabled")
        elif msg_type == "position_update":
            _call_main_fire(_do_position_update,
                message["designator"],
                message["x"], message["y"],
                message.get("rotation", 0))
        elif msg_type == "cross_probe":
            _call_main_fire(_do_cross_probe, message["designator"])
        elif msg_type == "delete_object":
            _log("[WS] 收到delete_object消息: designator={}".format(message.get("designator")))
            _call_main_fire(_do_delete_object, message["designator"])
    except json.JSONDecodeError as e:
        _log("Invalid JSON: {}".format(e))
    except Exception:
        await _send_to_client({"type": "error", "message": traceback.format_exc()})

async def handle_client(websocket):
    global _active_client, monitor_enabled
    _active_client = websocket
    _log("=== 客户端连接建立 ===")
    await _send_to_client({"type": "connection_confirmed"})
    _log("已发送连接确认")
    try:
        async for raw_message in websocket:
            await _handle_message(raw_message)
    except Exception as e:
        _log("连接异常: {}".format(e))
    finally:
        monitor_enabled = False
        _active_client = None
        _log("Client disconnected")

async def _process_upload(session_id: str) -> None:
    _log(f"=== 文件上传处理开始 ===")
    session = upload_sessions.pop(session_id, None)
    if not session:
        _log("错误: 上传会话不存在")
        return
    await _send_to_client({"type": "upload_complete", "sessionId": session_id})
    all_data = b""
    for i in range(session["totalChunks"]):
        chunk_b64 = session["chunks"].get(i)
        if chunk_b64:
            all_data += base64.b64decode(chunk_b64)
    filename = session["filename"]
    filepath = os.path.join(TEMP_DIR, "easyeda_{}".format(filename))
    try:
        with open(filepath, "wb") as f:
            f.write(all_data)
    except Exception as e:
        _log(f"文件保存失败: {e}")
        return
    await _send_to_client({"type": "import_started", "sessionId": session_id})
    success = await _call_main_await(_import_step, filepath, timeout=60.0)
    if success:
        await _send_to_client({
            "type": "import_complete",
            "sessionId": session_id,
            "details": "success {}".format(filename),
        })
    else:
        await _send_to_client({"type": "error", "message": "fail"})
    try:
        os.remove(filepath)
    except Exception:
        pass

async def _run_server():
    _log("Starting WebSocket server on ws://{}:{}".format(HOST, PORT))
    await _ws_serve(handle_client, HOST, PORT)

def _start_ws_thread():
    global _ws_loop
    _ws_loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_ws_loop)
    try:
        _ws_loop.run_until_complete(_run_server())
    except KeyboardInterrupt:
        _log("Server stopped")
    finally:
        _ws_loop.close()

# ==================== 主线程定时推送（替代 HTTP 轮询）====================

_poll_interval_ms = 2000  # 每 2 秒推送一次
_poll_timer_id = None

def _do_poll_and_push():
    """主线程：轮询位置/选中/删除，通过 WebSocket 推送给 EDA"""
    if not monitor_enabled or not designator_map:
        return
    updates = _check_selection()
    updates.extend(_do_poll_positions())
    if updates and _active_client is not None:
        for u in updates:
            _push_to_client(u)

def _start_poll_timer():
    """启动主线程定时器（通过反复 fireCustomEvent 实现）"""
    global _poll_timer_id
    if _poll_timer_id is not None:
        return
    _poll_timer_id = True  # 标记活跃
    _schedule_next_poll()

def _stop_poll_timer():
    global _poll_timer_id
    _poll_timer_id = None

def _schedule_next_poll():
    """通过 threading.Timer + fireCustomEvent 调度下一次轮询"""
    if _poll_timer_id is None or not monitor_enabled:
        return
    def _fire():
        if _poll_timer_id is not None and monitor_enabled:
            _call_main_fire(_do_poll_and_push)
            _schedule_next_poll()
    t = threading.Timer(_poll_interval_ms / 1000.0, _fire)
    t.daemon = True
    t.start()

# ==================== add-in entry ====================
def run(context):
    # 注册 CustomEvent（必须以 Add-In 方式加载才有效）
    app = _get_app()
    if app:
        handler = _TaskEventHandler()
        evt = app.registerCustomEvent(_custom_event_id)
        evt.add(handler)
        _handlers.append(handler)
        _log("CustomEvent registered: {}".format(_custom_event_id))
    else:
        _log("WARNING: app not available")
    ws_thread = threading.Thread(target=_start_ws_thread, daemon=True)
    ws_thread.start()
    _log("Add-in started")

def stop(context):
    global monitor_enabled, _active_client, _imported_design
    _log("Add-in stopping...")
    _stop_poll_timer()
    try:
        app = _get_app()
        if app:
            evt = app.registerCustomEvent(_custom_event_id)
            for h in _handlers:
                evt.remove(h)
            app.unregisterCustomEvent(_custom_event_id)
            _handlers.clear()
    except Exception:
        pass
    monitor_enabled = False
    _imported_design = None
    _active_client = None
    designator_map.clear()
    name_to_designator.clear()
    _last_positions.clear()
    _log("Add-in stopped")

if __name__ == "__main__":
    print("[EasyEDA] Standalone mode")
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    _ws_loop = loop
    try:
        loop.run_until_complete(_run_server())
    except KeyboardInterrupt:
        print("[EasyEDA] Server stopped")
    finally:
        loop.close()