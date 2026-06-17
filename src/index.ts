import * as extensionConfig from '../extension.json';
import fusion360ScriptContent from '../script/Interactive-with-fusion.py';

const FUSION360_WEBSOCKET_ID = 'fusion360-pcb-exporter';
const DEFAULT_FUSION360_ADDRESS = 'ws://localhost:8767';
const BIDIRECTIONAL_LISTENER_ID = 'fusion360-bidirectional-sync';
const BIDIRECTIONAL_MOUSE_ID = 'fusion360-bidirectional-mouse';
const MIL_TO_MM = 0.0254;
const MM_TO_MIL = 1 / 0.0254;

let isExporting = false;
let suppressDeleteSync = false;
let suppressPositionSync = false;
let activeUploadSessionId: string | null = null;

const CHUNK_SIZE = 512 * 1024; // 512KB per chunk
const STORAGE_KEY_BIDIRECTIONAL = 'fusion360_bidirectional';

function isBidirectionalEnabled(): boolean {
    return eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY_BIDIRECTIONAL) === true;
}
let wsReady = false;
let designatorToPrimitiveId: Map<string, string> = new Map();
let fusion360NameToDesignator: Map<string, string> = new Map();
let primitiveIdToDesignator: Map<string, string> = new Map();

function stateSnapshot(): string {
    return `wsReady=${wsReady}, isBidirectional=${isBidirectionalEnabled()}, edaMap=${designatorToPrimitiveId.size}, f360Map=${fusion360NameToDesignator.size}`;
}

export function activate(status?: 'onStartupFinished', arg?: string): void {
    eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_BIDIRECTIONAL, false);
}

export function about(): void {
    eda.sys_Dialog.showInformationMessage(
        eda.sys_I18n.text('PCB Fusion360 导出工具 v', undefined, undefined, extensionConfig.version),
        eda.sys_I18n.text('About'),
    );
}

// ==================== 连接 ====================

async function connectToFusion360Async(): Promise<void> {
    return new Promise((resolve, reject) => {
        try {
            const timeoutId = setTimeout(() => {
                if (!wsReady)
                    reject(new Error('连接超时'));
            }, 5000);
            eda.sys_WebSocket.register(FUSION360_WEBSOCKET_ID, DEFAULT_FUSION360_ADDRESS, handleFusion360Message, () => {
                clearTimeout(timeoutId);
                wsReady = true;
                console.log(`[连接] 连接成功, ${stateSnapshot()}`);
                if (isBidirectionalEnabled()) {
                    console.log(`[连接] 恢复Fusion360端监听`);
                    sendToFusion360({ type: 'enable_monitor' });
                }
                resolve();
            });
        }
        catch (error) { reject(error); }
    });
}

export function connectFusion360(): void {
    if (wsReady) {
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('已连接到Fusion360服务器'), ESYS_ToastMessageType.INFO);
        return;
    }
    eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在连接到Fusion360服务器...'), ESYS_ToastMessageType.INFO);
    try {
        eda.sys_WebSocket.register(FUSION360_WEBSOCKET_ID, DEFAULT_FUSION360_ADDRESS, handleFusion360Message, () => {
            wsReady = true;
            console.log(`[连接] 连接成功, ${stateSnapshot()}`);
            if (isBidirectionalEnabled()) {
                console.log(`[连接] 恢复Fusion360端监听`);
                sendToFusion360({ type: 'enable_monitor' });
            }
            eda.sys_Message.showToastMessage(eda.sys_I18n.text('成功连接到Fusion360服务器!'), ESYS_ToastMessageType.SUCCESS);
        });
    }
    catch (error) {
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('连接Fusion360失败') + ': ' + ((error as Error).message), ESYS_ToastMessageType.ERROR);
    }
}

// ==================== 消息处理 ====================

async function handleFusion360Message(event: MessageEvent<any>): Promise<void> {
    wsReady = true;
    try {
        const raw = typeof event === 'string' ? event : (event as any).data || event;
        const message = typeof raw === 'string' ? JSON.parse(raw) : raw;
        console.log(`[收到] type=${message.type}, ${stateSnapshot()}`);
        switch (message.type) {
            case 'pong':
                break;
            case 'connection_confirmed':
                eda.sys_Message.showToastMessage(eda.sys_I18n.text('Fusion360连接已确认'), ESYS_ToastMessageType.SUCCESS);
                break;
            case 'upload_progress':
                eda.sys_Message.showToastMessage(eda.sys_I18n.text('处理进度') + ' ' + message.progress + '%', ESYS_ToastMessageType.INFO);
                break;
            case 'upload_started':
                console.log('[上传] 服务端已接受分片上传, sessionId=' + message.sessionId);
                break;
            case 'chunk_received':
                if (activeUploadSessionId === message.sessionId) {
                    const pct = Math.round(message.received / message.total * 100);
                    console.log('[上传] 分片 ' + message.index + ' 已确认, 进度 ' + pct + '%');
                }
                break;
            case 'upload_complete':
                eda.sys_Message.showToastMessage(eda.sys_I18n.text('文件上传完成，正在导入到Fusion360...'), ESYS_ToastMessageType.SUCCESS);
                break;
            case 'import_started':
                eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在导入STEP文件到Fusion360...'), ESYS_ToastMessageType.INFO);
                break;
            case 'import_progress':
                if (activeUploadSessionId === message.sessionId) {
                    const sec = Math.round(message.elapsed_ms / 1000);
                    console.log('[导入] 进行中, 已耗时 ' + sec + 's');
                }
                break;
            case 'import_complete':
                isExporting = false;
                activeUploadSessionId = null;
                eda.sys_Message.showToastMessage(eda.sys_I18n.text('PCB导入完成') + (message.details ? ': ' + message.details : ''), ESYS_ToastMessageType.SUCCESS);
                break;
            case 'error':
                isExporting = false;
                activeUploadSessionId = null;
                eda.sys_Message.showToastMessage(eda.sys_I18n.text('Fusion360错误') + ': ' + (message.message || ''), ESYS_ToastMessageType.ERROR);
                break;
            case 'mapping_result':
                await handleMappingResult(message.mapping);
                break;
            case 'position_update_from_fusion360':
                await handlePositionUpdateFromFusion360(message);
                break;
            case 'cross_probe_from_fusion360':
                await handleCrossProbeFromFusion360(message);
                break;
            case 'delete_from_fusion360':
                await handleDeleteFromFusion360(message);
                break;
            case 'document_changed':
                if (isBidirectionalEnabled()) {
                    disableBidirectional();
                    eda.sys_Message.showToastMessage(eda.sys_I18n.text('Fusion360文档已切换，双向交互已自动停止，请重新启用'), ESYS_ToastMessageType.WARNING);
                }
                break;
            default:
                console.log(`[收到] 未知消息类型: ${message.type}`);
        }
    }
    catch (error) {
        console.error(`[收到] 消息处理异常:`, error);
    }
}

// ==================== 分片上传工具 ====================

function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        binary += String.fromCharCode.apply(null, slice);
    }
    return btoa(binary);
}

async function sendFileChunked(buffer: ArrayBuffer, filename: string): Promise<void> {
    const sessionId = Date.now().toString(36) + Math.random().toString(36).substring(2);
    activeUploadSessionId = sessionId;

    const totalSize = buffer.byteLength;
    const totalChunks = Math.ceil(totalSize / CHUNK_SIZE);

    sendToFusion360({
        type: 'file_upload_start',
        sessionId,
        filename,
        totalSize,
        totalChunks,
    });

    await new Promise(r => setTimeout(r, 50));

    for (let i = 0; i < totalChunks; i++) {
        if (!wsReady)
            throw new Error('上传过程中连接断开');
        const start = i * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, totalSize);
        const chunk = buffer.slice(start, end);
        const base64Data = arrayBufferToBase64(chunk);

        sendToFusion360({
            type: 'file_upload_chunk',
            sessionId,
            index: i,
            data: base64Data,
        });

        if (i % 10 === 9) {
            await new Promise(r => setTimeout(r, 0));
        }
    }

    console.log(`[上传] 所有分片已发送: ${totalChunks} 片, ${(totalSize / 1024).toFixed(1)} KB`);
}

// ==================== 导出 ====================

export async function exportToFusion360(): Promise<void> {
    if (isExporting) {
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在导出中，请稍候...'), ESYS_ToastMessageType.INFO);
        return;
    }
    try {
        isExporting = true;
        disableBidirectional();
        if (!wsReady) {
            eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在连接到Fusion360服务器...'), ESYS_ToastMessageType.INFO);
            await connectToFusion360Async();
            if (!wsReady)
                throw new Error('无法连接到Fusion360服务器');
        }
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在获取PCB 3D STEP文件...'), ESYS_ToastMessageType.INFO);
        const pcbFile = await eda.pcb_ManufactureData.get3DFile('pcbModel', 'step', ['Component Model'], 'Parts');

        if (!pcbFile)
            throw new Error('无法获取PCB 3D STEP文件');
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('PCB STEP文件获取成功') + ': ' + pcbFile.name + ' (' + (pcbFile.size / 1024).toFixed(2) + ' KB)', ESYS_ToastMessageType.SUCCESS);

        const fileArrayBuffer = await new Promise<ArrayBuffer>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                if (reader.result instanceof ArrayBuffer)
                    resolve(reader.result); else reject(new Error('FileReader返回的不是ArrayBuffer'));
            };
            reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
            reader.readAsArrayBuffer(pcbFile);
        });
        if (fileArrayBuffer.byteLength === 0)
            throw new Error('PCB文件数据为空');

        const filename = pcbFile.name.endsWith('.step') ? pcbFile.name : `${pcbFile.name}.step`;
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在发送文件到Fusion360') + ' (' + (fileArrayBuffer.byteLength / 1024).toFixed(2) + ' KB)', ESYS_ToastMessageType.INFO);
        await sendFileChunked(fileArrayBuffer, filename);
    }
    catch (error) {
        isExporting = false;
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('导出失败') + ': ' + ((error as Error).message), ESYS_ToastMessageType.ERROR);
    }
}

// ==================== 双向交互 ====================

export async function enableBidirectional(): Promise<void> {
    console.log(`[双向] ===== 开始启用 ===== ${stateSnapshot()}`);
    if (isBidirectionalEnabled()) {
        console.log(`[双向] 已启用，跳过`);
        return;
    }

    if (!wsReady) {
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('正在连接到Fusion360服务器...'), ESYS_ToastMessageType.INFO);
        try {
            await connectToFusion360Async();
        }
        catch (error) {
            eda.sys_Message.showToastMessage(eda.sys_I18n.text('连接Fusion360失败') + ': ' + ((error as Error).message), ESYS_ToastMessageType.ERROR);
            return;
        }
    }

    designatorToPrimitiveId.clear();
    primitiveIdToDesignator.clear();
    fusion360NameToDesignator.clear();

    let components: any[] = [];
    try {
        components = await eda.pcb_PrimitiveComponent.getAll();
        console.log(`[双向] 获取到 ${components.length} 个元件`);
    }
    catch (error) {
        console.error('[双向] 获取元件列表失败:', error);
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('获取元件列表失败，无法启用双向交互'), ESYS_ToastMessageType.ERROR);
        return;
    }

    if (components.length === 0) {
        console.log(`[双向] 失败: components.length=0`);
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('未找到任何元件，无法启用双向交互'), ESYS_ToastMessageType.WARNING);
        return;
    }

    for (const comp of components) {
        const designator = comp.getState_Designator();
        const primitiveId = comp.getState_PrimitiveId();
        if (designator) {
            designatorToPrimitiveId.set(designator, primitiveId);
            primitiveIdToDesignator.set(primitiveId, designator);
        }
    }
    console.log(`[双向] edaMap=${designatorToPrimitiveId.size}, 明细: [${[...designatorToPrimitiveId.keys()].join(', ')}]`);

    if (designatorToPrimitiveId.size === 0) {
        console.log(`[双向] 失败: 所有元件位号为空`);
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('没有元件有有效的位号，无法启用双向交互'), ESYS_ToastMessageType.WARNING);
        return;
    }

    // 注册事件监听器（防重复）
    if (!eda.pcb_Event.isEventListenerAlreadyExist(BIDIRECTIONAL_LISTENER_ID)) {
        eda.pcb_Event.addPrimitiveEventListener(BIDIRECTIONAL_LISTENER_ID, 'all', onPcbPrimitiveChange);
        console.log(`[双向] 已注册 PrimitiveEventListener`);
    }
    else {
        console.log(`[双向] PrimitiveEventListener 已存在，跳过`);
    }
    if (!eda.pcb_Event.isEventListenerAlreadyExist(BIDIRECTIONAL_MOUSE_ID)) {
        eda.pcb_Event.addMouseEventListener(BIDIRECTIONAL_MOUSE_ID, 'selected', onPcbMouseSelect);
        console.log(`[双向] 已注册 MouseEventListener`);
    }
    else {
        console.log(`[双向] MouseEventListener 已存在，跳过`);
    }

    const { offsetX, offsetY } = await eda.pcb_Document.getCanvasOrigin();

    const componentData: Array<{ designator: string; x: number; y: number; rotation: number }> = [];
    for (const [designator, primitiveId] of designatorToPrimitiveId) {
        try {
            const comp = await eda.pcb_PrimitiveComponent.get(primitiveId);
            if (comp)
                componentData.push({ designator, x: (comp.getState_X() - offsetX) * MIL_TO_MM, y: (comp.getState_Y() - offsetY) * MIL_TO_MM, rotation: comp.getState_Rotation() });
        }
        catch (error) {
            console.error(`[双向] 获取元件 ${designator} 位置失败:`, error);
        }
    }
    console.log(`[双向] componentData=${componentData.length} 条`);

    if (componentData.length === 0) {
        console.log(`[双向] 失败: 无法获取任何元件位置`);
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('无法获取元件位置数据，无法启用双向交互'), ESYS_ToastMessageType.ERROR);
        try {
            eda.pcb_Event.removeEventListener(BIDIRECTIONAL_LISTENER_ID);
            eda.pcb_Event.removeEventListener(BIDIRECTIONAL_MOUSE_ID);
        }
        catch {}
        return;
    }

    // 先标记启用，再发消息
    eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_BIDIRECTIONAL, true);
    console.log(`[双向] isBidirectional=true, 准备发送build_mapping`);

    sendToFusion360({ type: 'build_mapping', components: componentData });
    console.log(`[双向] build_mapping 已发送 (${componentData.length} 个元件)`);
    sendToFusion360({ type: 'enable_monitor' });
    console.log(`[双向] enable_monitor 已发送`);
    startFusionPolling();

    eda.sys_Message.showToastMessage(
        eda.sys_I18n.text('双向交互已启动。提示：请确保Fusion360中元件可移动，否则拖动无法同步'),
        ESYS_ToastMessageType.SUCCESS,
    );
    console.log(`[双向] ===== 启用完成 ===== ${stateSnapshot()}`);
}

export function disableBidirectional(): void {
    if (!isBidirectionalEnabled())
        return;
    eda.sys_Storage.setExtensionUserConfig(STORAGE_KEY_BIDIRECTIONAL, false);
    console.log(`[双向] ===== 停止 =====`);
    stopFusionPolling();

    try { eda.pcb_Event.removeEventListener(BIDIRECTIONAL_LISTENER_ID); } catch {}
    try { eda.pcb_Event.removeEventListener(BIDIRECTIONAL_MOUSE_ID); } catch {}

    sendToFusion360({ type: 'disable_monitor' });

    designatorToPrimitiveId.clear();
    primitiveIdToDesignator.clear();
    fusion360NameToDesignator.clear();

    eda.sys_Message.showToastMessage(eda.sys_I18n.text('双向交互已停止'), ESYS_ToastMessageType.INFO);
}

async function handleMappingResult(mapping: Array<{ designator: string; fusion360Name: string }>): Promise<void> {
    console.log(`[双向] 收到mapping_result: ${mapping?.length || 0} 条匹配, ${stateSnapshot()}`);
    fusion360NameToDesignator.clear();
    for (const item of mapping) {
        fusion360NameToDesignator.set(item.fusion360Name, item.designator);
        console.log(`[双向]   ${item.fusion360Name} <-> ${item.designator}`);
    }

    // 自愈：如果 edaMap 为空但 mapping 有结果，从 EDA API 重建
    if (mapping.length > 0) {
        console.log(`[双向] 开始自愈检查, edaMap=${designatorToPrimitiveId.size}, isBidirectional=${isBidirectionalEnabled()}`);
        const designators = new Set(mapping.map(m => m.designator));
        try {
            const components = await eda.pcb_PrimitiveComponent.getAll();
            let rebuilt = 0;
            for (const comp of components) {
                const d = comp.getState_Designator();
                const pid = comp.getState_PrimitiveId();
                if (d && designators.has(d)) {
                    designatorToPrimitiveId.set(d, pid);
                    primitiveIdToDesignator.set(pid, d);
                    rebuilt++;
                }
            }
            console.log(`[双向] 重建完成: edaMap=${rebuilt}, ${stateSnapshot()}`);

            if (isBidirectionalEnabled()) {
                if (!eda.pcb_Event.isEventListenerAlreadyExist(BIDIRECTIONAL_LISTENER_ID)) {
                    eda.pcb_Event.addPrimitiveEventListener(BIDIRECTIONAL_LISTENER_ID, "all", onPcbPrimitiveChange);
                    console.log(`[双向] 自愈: 补注册PrimitiveEventListener`);
                }
                if (!eda.pcb_Event.isEventListenerAlreadyExist(BIDIRECTIONAL_MOUSE_ID)) {
                    eda.pcb_Event.addMouseEventListener(BIDIRECTIONAL_MOUSE_ID, "selected", onPcbMouseSelect);
                    console.log(`[双向] 自愈: 补注册MouseEventListener`);
                }
            } else {
                console.log(`[双向] isBidirectional=false，跳过listener恢复`);
            }
        }
        catch (e) { console.error(`[双向] 重建失败:`, e); }
    }

    console.log(`[双向] 映射处理完毕, ${stateSnapshot()}`);
    if (mapping.length === 0)
        eda.sys_Message.showToastMessage(eda.sys_I18n.text("未匹配到任何元件，建议先导出模型再启用双向交互"), ESYS_ToastMessageType.WARNING);
}

// EDA → Fusion360
function onPcbPrimitiveChange(eventType: string, props: any[]): void {
    if (!isBidirectionalEnabled())
        return;
    if (eventType === 'delete') {
        console.log(`[DELETE-EDA] 收到delete事件, props数量=${props.length}, suppressDeleteSync=${suppressDeleteSync}, edaMap大小=${designatorToPrimitiveId.size}`);
        if (suppressDeleteSync) {
            console.log(`[DELETE-EDA] suppressDeleteSync=true, 跳过（F360触发的删除正在执行中）`);
            return;
        }
        const deleted = new Set<string>();
        for (let i = 0; i < props.length; i++) {
            const prop = props[i];
            const propDesignator = prop.designator;
            const propPrimitiveId = prop.primitiveId;
            const mappedDesignator = primitiveIdToDesignator.get(propPrimitiveId);
            const designator = propDesignator || mappedDesignator;
            console.log(`[DELETE-EDA] prop[${i}]: designator=${propDesignator}, primitiveId=${propPrimitiveId}, 映射=${mappedDesignator}, 最终=${designator}`);
            if (!designator) {
                console.log(`[DELETE-EDA] prop[${i}]: 跳过 — designator为空且primitiveId未在映射表中`);
                continue;
            }
            if (deleted.has(designator)) {
                console.log(`[DELETE-EDA] prop[${i}]: 跳过 — 已处理过`);
                continue;
            }
            if (!designatorToPrimitiveId.has(designator)) {
                console.log(`[DELETE-EDA] prop[${i}]: 跳过 — ${designator} 不在edaMap中`);
                continue;
            }
            const pid = designatorToPrimitiveId.get(designator);
            designatorToPrimitiveId.delete(designator);
            primitiveIdToDesignator.delete(pid);
            deleted.add(designator);
            console.log(`[DELETE-EDA] prop[${i}]: 发送delete_object到Fusion360, designator=${designator}, pid=${pid}`);
            sendToFusion360({ type: 'delete_object', designator });
        }
        console.log(`[DELETE-EDA] 完成, 发送${deleted.size}个, [${[...deleted].join(', ')}]`);
        return;
    }
    for (const prop of props) {
        const designator
            = prop.designator
                || prop.parentComponentDesignator
                || primitiveIdToDesignator.get(prop.primitiveId)
                || primitiveIdToDesignator.get(prop.parentComponentPrimitiveId);
        if (!designator)
            continue;
        if (eventType === 'move' || eventType === 'modify') {
            if (suppressPositionSync) {
                console.log(`[双向] 位置同步已抑制(Fusion触发), designator=${designator}`);
                continue;
            }
            syncPositionToFusion360(prop.primitiveId, designator);
        }
    }
}

async function syncPositionToFusion360(primitiveId: string, designator: string): Promise<void> {
    try {
        const comp = await eda.pcb_PrimitiveComponent.get(primitiveId);
        if (!comp) return;
        const { offsetX: oX, offsetY: oY } = await eda.pcb_Document.getCanvasOrigin();
        sendToFusion360({
            type: 'position_update',
            designator,
            x: (comp.getState_X() - oX) * MIL_TO_MM,
            y: (comp.getState_Y() - oY) * MIL_TO_MM,
            rotation: comp.getState_Rotation(),
        });
    }
    catch (error) { console.error('[双向] 同步位置失败:', error); }
}

async function onPcbMouseSelect(eventType: string, props: any[]): Promise<void> {
    if (!isBidirectionalEnabled() || !props || props.length === 0)
        return;
    try {
        const designator = props[0].parentComponentDesignator || props[0].designator;
        if (designator)
            sendToFusion360({ type: 'cross_probe', designator });
    }
    catch (error) { console.error('[双向] 交叉定位失败:', error); }
}

// Fusion360 → EDA
async function handlePositionUpdateFromFusion360(message: any): Promise<void> {
    console.log(`[F360→EDA] position_update: designator=${message.designator}, x=${message.x}, y=${message.y}`);
    if (!isBidirectionalEnabled()) {
        console.log(`[F360→EDA] 跳过: isBidirectional=false, ${stateSnapshot()}`);
        return;
    }
    const designator = message.designator;
    if (!designator) return;

    // 先从缓存查找，找不到则动态查找
    let primitiveId = designatorToPrimitiveId.get(designator);
    if (!primitiveId) {
        console.log(`[F360→EDA] edaMap中未找到 "${designator}"，尝试动态查找...`);
        try {
            const components = await eda.pcb_PrimitiveComponent.getAll();
            for (const comp of components) {
                if (comp.getState_Designator() === designator) {
                    primitiveId = comp.getState_PrimitiveId();
                    designatorToPrimitiveId.set(designator, primitiveId);
                    primitiveIdToDesignator.set(primitiveId, designator);
                    console.log(`[F360→EDA] 动态查找成功: ${designator} -> ${primitiveId}`);
                    break;
                }
            }
        } catch (e) { console.error(`[F360→EDA] 动态查找失败:`, e); }
    }
    if (!primitiveId) {
        console.log(`[F360→EDA] 彻底找不到: ${designator}`);
        return;
    }
    try {
        suppressPositionSync = true;
        const comp = await eda.pcb_PrimitiveComponent.get(primitiveId);
        if (!comp) return;
        const { offsetX: rX, offsetY: rY } = await eda.pcb_Document.getCanvasOrigin();
        comp.setState_X(message.x * MM_TO_MIL + rX);
        comp.setState_Y(message.y * MM_TO_MIL + rY);
        comp.setState_Rotation(message.rotation);
        await comp.done();
        console.log(`[F360→EDA] 位置更新成功: ${designator}`);
    }
    catch (error) { console.error('[F360→EDA] 位置更新异常:', error); }
    finally { suppressPositionSync = false; }
}

async function handleCrossProbeFromFusion360(message: any): Promise<void> {
    console.log(`[F360→EDA] cross_probe: designator=${message.designator}`);
    if (!isBidirectionalEnabled()) {
        console.log(`[F360→EDA] 跳过: isBidirectional=false, ${stateSnapshot()}`);
        return;
    }
    const designator = message.designator;
    if (!designator) {
        console.log(`[F360→EDA] 跳过: designator为空`);
        return;
    }
    console.log(`[F360→EDA] 执行交叉定位: ${designator}`);
    try {
        await eda.pcb_SelectControl.doCrossProbeSelect([designator], undefined, undefined, true, true);
        if (message.x !== undefined && message.y !== undefined) {
            // ✅ 添加画布原点偏移修正
            const { offsetX, offsetY } = await eda.pcb_Document.getCanvasOrigin();
            await eda.pcb_Document.navigateToCoordinates(
                (message.x * MM_TO_MIL) + offsetX, 
                (message.y * MM_TO_MIL) + offsetY
            );
        }
        console.log(`[F360→EDA] 交叉定位成功: ${designator}`);
    }
    catch (error) { console.error('[F360→EDA] 交叉定位异常:', error); }
}

async function handleDeleteFromFusion360(message: any): Promise<void> {
    console.log(`[DELETE-F360→EDA] 收到消息: designator=${message.designator}`);
    if (!isBidirectionalEnabled()) {
        console.log(`[DELETE-F360→EDA] 跳过: isBidirectional=false, ${stateSnapshot()}`);
        return;
    }
    const designator = message.designator;
    if (!designator) {
        console.log(`[DELETE-F360→EDA] 跳过: designator为空`);
        return;
    }
    let primitiveId = designatorToPrimitiveId.get(designator);
    console.log(`[DELETE-F360→EDA] designator=${designator}, 从edaMap查到pid=${primitiveId}`);
    if (!primitiveId) {
        console.log(`[DELETE-F360→EDA] edaMap未找到，动态查找...`);
        try {
            const allComps = await eda.pcb_PrimitiveComponent.getAll();
            for (const comp of allComps) {
                if (comp.getState_Designator() === designator) {
                    primitiveId = comp.getState_PrimitiveId();
                    console.log(`[DELETE-F360→EDA] 动态查找命中: ${designator} -> ${primitiveId}`);
                    break;
                }
            }
        } catch (e) {
            console.log(`[DELETE-F360→EDA] 动态查找失败: ${e}`);
        }
        if (!primitiveId) {
            console.log(`[DELETE-F360→EDA] 彻底找不到pid, 无法删除`);
            return;
        }
    }
    try {
        suppressDeleteSync = true;
        designatorToPrimitiveId.delete(designator);
        primitiveIdToDesignator.delete(primitiveId);
        console.log(`[DELETE-F360→EDA] 执行删除: ${designator}, pid=${primitiveId}`);
        await eda.pcb_PrimitiveComponent.delete([primitiveId]);
        console.log(`[DELETE-F360→EDA] 删除成功: ${designator}`);
    }
    catch (error) {
        console.error(`[DELETE-F360→EDA] 删除失败: ${designator}`, error);
    }
    finally {
        suppressDeleteSync = false;
    }
}

// ==================== Fusion360 → EDA 推送（WebSocket） ====================
// Fusion360 主线程定时轮询并通过 WebSocket 主动推送，无需 EDA 端轮询

function startFusionPolling(): void {
    // 不再需要 HTTP 轮询，Fusion 端通过 _push_to_client 主动推送
}

function stopFusionPolling(): void {
    // 空操作
}

function processPollUpdates(updates: any[]): void {
    if (!updates || updates.length === 0) return;
    for (const u of updates) {
        if (u.type === 'position_update_from_fusion360')
            handlePositionUpdateFromFusion360(u);
        else if (u.type === 'cross_probe_from_fusion360')
            handleCrossProbeFromFusion360(u);
        else if (u.type === 'delete_from_fusion360')
            handleDeleteFromFusion360(u);
    }
}

// ==================== 发送 ====================

function sendToFusion360(data: Record<string, any>): void {
    try { eda.sys_WebSocket.send(FUSION360_WEBSOCKET_ID, JSON.stringify(data)); }
    catch (error) { console.error('[发送失败]', error); wsReady = false; }
}

// ==================== 断开连接 ====================

export function disconnectFusion360(): void {
    if (isBidirectionalEnabled())
        disableBidirectional();
    if (!wsReady) {
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('未连接到Fusion360服务器'), ESYS_ToastMessageType.INFO);
        return;
    }
    try {
        eda.sys_WebSocket.close(FUSION360_WEBSOCKET_ID, 1000, '用户主动断开连接');
        wsReady = false;
        isExporting = false;
        console.log(`[连接] 已断开`);
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('已断开与Fusion360的连接'), ESYS_ToastMessageType.INFO);
    }
    catch (error) {
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('断开连接失败') + ': ' + ((error as Error).message), ESYS_ToastMessageType.ERROR);
    }
}

export function checkFusion360Connection(): void {
    console.log(`[检查] ${stateSnapshot()}`);
    eda.sys_Message.showToastMessage(
        eda.sys_I18n.text('Fusion360连接状态') + ': ' + (wsReady ? eda.sys_I18n.text('连接状态_已连接') : eda.sys_I18n.text('连接状态_未连接')),
        wsReady ? ESYS_ToastMessageType.SUCCESS : ESYS_ToastMessageType.WARNING,
    );
}

// ==================== 保存Fusion360脚本 ====================

export async function copyFusion360Script(): Promise<void> {
    const text = fusion360ScriptContent as string;
    if (!text) {
        eda.sys_Message.showToastMessage(eda.sys_I18n.text('脚本内容为空'), ESYS_ToastMessageType.ERROR);
        return;
    }
    try {
        const blob = new Blob([text], { type: 'text/x-python' });
        await eda.sys_FileSystem.saveFile(blob, 'Interactive-with-easyeda-fusion360.py');
        eda.sys_Message.showToastMessage(
            eda.sys_I18n.text('Fusion360脚本已保存，请在Fusion360中通过"脚本和Add-In"面板加载运行'),
            ESYS_ToastMessageType.SUCCESS,
        );
    }
    catch (error) {
        eda.sys_Message.showToastMessage(
            eda.sys_I18n.text('保存脚本失败') + ': ' + ((error as Error).message),
            ESYS_ToastMessageType.ERROR,
        );
    }
}
