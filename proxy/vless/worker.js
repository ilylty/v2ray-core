import { connect } from 'cloudflare:sockets';


var USER_ID = '';



const proxyIPs = [
    { region: 'US', domain: 'ProxyIP.US.CMLiussss.net', port: 443 },
    { region: 'SG', domain: 'ProxyIP.SG.CMLiussss.net', port: 443 },
    { region: 'JP', domain: 'ProxyIP.JP.CMLiussss.net', port: 443 },
    { region: 'KR', domain: 'ProxyIP.KR.CMLiussss.net', port: 443 },
    { region: 'DE', domain: 'ProxyIP.DE.CMLiussss.net', port: 443 },
    { region: 'SE', domain: 'ProxyIP.SE.CMLiussss.net', port: 443 },
    { region: 'NL', domain: 'ProxyIP.NL.CMLiussss.net', port: 443 },
    { region: 'FI', domain: 'ProxyIP.FI.CMLiussss.net', port: 443 },
    { region: 'GB', domain: 'ProxyIP.GB.CMLiussss.net', port: 443 },
    { region: 'Oracle', domain: 'ProxyIP.Oracle.cmliussss.net', port: 443 },
    { region: 'DigitalOcean', domain: 'ProxyIP.DigitalOcean.CMLiussss.net', port: 443 },
    { region: 'Vultr', domain: 'ProxyIP.Vultr.CMLiussss.net', port: 443 },
    { region: 'Multacom', domain: 'ProxyIP.Multacom.CMLiussss.net', port: 443 }
];

const VLESS_CMD_TCP = 1;
const VLESS_CMD_UDP = 2;
const VLESS_CMD_MUX = 3;

const MUX_STATUS_NEW = 1;
const MUX_STATUS_KEEP = 2;
const MUX_STATUS_END = 3;
const MUX_OPTION_DATA = 1;
const MUX_OPTION_ERROR = 2;
const MUX_NETWORK_TCP = 1;
const MUX_NETWORK_UDP = 2;

export default {
    async fetch(request, env, ctx) {
        try {
            USER_ID = env.USER_ID || '';
            const upgrade = request.headers.get('Upgrade');
            if (!upgrade || upgrade !== 'websocket') {
                if (!USER_ID) {
                    return new Response('env.USER_ID is required', { status: 200 });
                }

                const url = new URL(request.url);
                const headers = {};
                for (const [k, v] of request.headers.entries()) headers[k] = v;
                return new Response(JSON.stringify({
                    args: Object.fromEntries(url.searchParams),
                    headers,
                    origin: request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || '',
                    url: url.toString()
                }, null, 2), {
                    status: 200,
                    headers: { 'content-type': 'application/json' }
                });
            }
            
            
            const url = new URL(request.url);
            const pathRegion = url.pathname.replace('/', '').toUpperCase();

            return await handleWsRequest(request, pathRegion);
        } catch (err) {
            return new Response(err.toString(), { status: 500 });
        }
    },
};


async function handleWsRequest(request, targetRegion) {
    const wsPair = new WebSocketPair();
    const [clientSock, serverSock] = Object.values(wsPair);
    serverSock.accept();

    let remoteConnWrapper = { socket: null };
    let isDnsQuery = false;
    let protocolType = null;
    let muxWorker = null;

    const earlyData = request.headers.get('sec-websocket-protocol') || '';
    const readable = makeReadableStream(serverSock, earlyData);

    readable.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDnsQuery) return await forwardUDP(chunk, serverSock, null);

            if (protocolType === 'vless-mux') {
                return await muxWorker.handleChunk(chunk);
            }
            
            if (remoteConnWrapper.socket) {
                const writer = remoteConnWrapper.socket.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }

            if (!protocolType) {
                
                if (chunk.byteLength >= 24) {
                    const vlessResult = parseWsPacketHeader(chunk, USER_ID);
                    if (!vlessResult.hasError) {
                        protocolType = 'vless';
                        const { addressType, port, hostname, rawIndex, version, isUDP, command } = vlessResult;

                        if (command === VLESS_CMD_MUX) {
                            protocolType = 'vless-mux';
                            muxWorker = new VlessMuxWorker(serverSock, version[0]);
                            const rawData = chunk.slice(rawIndex);
                            if (rawData.byteLength > 0) {
                                await muxWorker.handleChunk(rawData);
                            }
                            return;
                        }
                        
                        
                        if (isUDP) {
                            if (port === 53) isDnsQuery = true;
                            else {
                                serverSock.close(); 
                                return;
                            }
                        }

                        
                        const respHeader = new Uint8Array([version[0], 0]);
                        const rawData = chunk.slice(rawIndex);

                        if (isDnsQuery) return forwardUDP(rawData, serverSock, respHeader);

                        
                        await forwardTCP(hostname, port, rawData, serverSock, respHeader, remoteConnWrapper, targetRegion);
                        return;
                    }
                }
                
                serverSock.close();
            }
        },
    })).catch((err) => { serverSock.close(); });

    return new Response(null, { status: 101, webSocket: clientSock });
}

async function forwardTCP(host, portNum, rawData, ws, respHeader, remoteConnWrapper, targetRegion) {
    
    async function connectAndSend(address, port) {
        const remoteSock = connect({ hostname: address, port: port });
        const writer = remoteSock.writable.getWriter();
        await writer.write(rawData);
        writer.releaseLock();
        return remoteSock;
    }

    
    async function retryConnection() {
        let backupHost = host;
        let backupPort = portNum;

        
        const selectedNode = proxyIPs.find(p => p.region === targetRegion) || proxyIPs[0];
        
        if (selectedNode) {
            backupHost = selectedNode.domain;
            backupPort = selectedNode.port;
        }

        try {
            const fallbackSocket = await connectAndSend(backupHost, backupPort);
            remoteConnWrapper.socket = fallbackSocket;
            
            fallbackSocket.closed.catch(() => {}).finally(() => closeSocketQuietly(ws));
            connectStreams(fallbackSocket, ws, respHeader, null);
        } catch (fallbackErr) {
            closeSocketQuietly(ws);
        }
    }

    
    try {
        const initialSocket = await connectAndSend(host, portNum);
        remoteConnWrapper.socket = initialSocket;
        connectStreams(initialSocket, ws, respHeader, retryConnection);
    } catch (err) {
        
        retryConnection();
    }
}

async function connectStreams(remoteSocket, webSocket, headerData, retryFunc) {
    let header = headerData;
    let hasData = false;

    await remoteSocket.readable.pipeTo(
        new WritableStream({
            async write(chunk, controller) {
                hasData = true;
                if (webSocket.readyState !== 1) {
                    controller.error('WS closed');
                    return;
                }
                
                if (header) {
                    const combined = new Uint8Array(header.length + chunk.length);
                    combined.set(header);
                    combined.set(chunk, header.length);
                    webSocket.send(combined);
                    header = null;
                } else {
                    webSocket.send(chunk);
                }
            },
        })
    ).catch(() => { closeSocketQuietly(webSocket); });
    if (!hasData && retryFunc) {
        retryFunc();
    }
}

function parseWsPacketHeader(chunk, targetID) {
    if (chunk.byteLength < 24) return { hasError: true };
    
    const version = new Uint8Array(chunk.slice(0, 1));
    const idBytes = new Uint8Array(chunk.slice(1, 17));
    
    if (stringifyUuid(idBytes) !== targetID) {
        return { hasError: true };
    }

    const optLen = new Uint8Array(chunk.slice(17, 18))[0];
    const cmd = new Uint8Array(chunk.slice(18 + optLen, 19 + optLen))[0];
    
    let isUDP = cmd === VLESS_CMD_UDP;
    
    if (cmd === VLESS_CMD_MUX) {
        return {
            hasError: false,
            addressType: 0,
            port: 0,
            hostname: '',
            isUDP: false,
            rawIndex: 19 + optLen,
            version,
            command: cmd
        };
    }

    if (cmd !== VLESS_CMD_TCP && cmd !== VLESS_CMD_UDP) return { hasError: true };

    const portIdx = 19 + optLen;
    const port = new DataView(chunk.slice(portIdx, portIdx + 2)).getUint16(0);
    
    let addrIdx = portIdx + 2;
    let addrValIdx = addrIdx + 1;
    let hostname = '';
    let addrLen = 0;
    
    const addressType = new Uint8Array(chunk.slice(addrIdx, addrValIdx))[0];

    switch (addressType) {
        case 1: 
            addrLen = 4;
            hostname = new Uint8Array(chunk.slice(addrValIdx, addrValIdx + addrLen)).join('.');
            break;
        case 2: 
            addrLen = new Uint8Array(chunk.slice(addrValIdx, addrValIdx + 1))[0];
            addrValIdx += 1;
            hostname = new TextDecoder().decode(chunk.slice(addrValIdx, addrValIdx + addrLen));
            break;
        case 3: 
            addrLen = 16;
            const ipv6 = [];
            const ipv6View = new DataView(chunk.slice(addrValIdx, addrValIdx + addrLen));
            for (let i = 0; i < 8; i++) ipv6.push(ipv6View.getUint16(i * 2).toString(16));
            hostname = ipv6.join(':');
            break;
        default:
            return { hasError: true };
    }

    if (!hostname) return { hasError: true };

    return { 
        hasError: false, 
        addressType, 
        port, 
        hostname, 
        isUDP, 
        rawIndex: addrValIdx + addrLen, 
        version,
        command: cmd
    };
}

class VlessMuxWorker {
    constructor(webSocket, versionByte) {
        this.webSocket = webSocket;
        this.versionByte = versionByte;
        this.pending = new Uint8Array(0);
        this.sentRespHeader = false;
        this.sessions = new Map();
    }

    async handleChunk(chunk) {
        const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        this.pending = concatUint8Arrays(this.pending, data);
        while (true) {
            const frame = tryParseMuxFrame(this.pending);
            if (!frame) break;
            this.pending = this.pending.slice(frame.totalSize);
            await this.handleFrame(frame);
        }
    }

    async handleFrame(frame) {
        if (frame.status === MUX_STATUS_NEW) {
            return await this.handleNew(frame);
        }

        const session = this.sessions.get(frame.sessionId);
        if (!session) return;

        if ((frame.option & MUX_OPTION_DATA) !== 0 && frame.data && frame.data.byteLength > 0) {
            try {
                const writer = session.socket.writable.getWriter();
                await writer.write(frame.data);
                writer.releaseLock();
            } catch (error) {
                this.closeSession(frame.sessionId, true);
            }
        }

        if (frame.status === MUX_STATUS_END) {
            this.closeSession(frame.sessionId, false);
        }
    }

    async handleNew(frame) {
        if (!frame.target || frame.target.network !== MUX_NETWORK_TCP) {
            this.sendMuxFrame(frame.sessionId, MUX_STATUS_END, MUX_OPTION_ERROR, null);
            return;
        }

        try {
            const socket = connect({ hostname: frame.target.hostname, port: frame.target.port });
            this.sessions.set(frame.sessionId, { socket });
            socket.closed.catch(() => {}).finally(() => {
                this.closeSession(frame.sessionId, false);
            });

            this.pipeRemoteToClient(frame.sessionId, socket);

            if ((frame.option & MUX_OPTION_DATA) !== 0 && frame.data && frame.data.byteLength > 0) {
                const writer = socket.writable.getWriter();
                await writer.write(frame.data);
                writer.releaseLock();
            }
        } catch (error) {
            this.sendMuxFrame(frame.sessionId, MUX_STATUS_END, MUX_OPTION_ERROR, null);
        }
    }

    async pipeRemoteToClient(sessionId, socket) {
        await socket.readable.pipeTo(new WritableStream({
            write: (chunk) => {
                this.sendMuxFrame(sessionId, MUX_STATUS_KEEP, MUX_OPTION_DATA, chunk);
            },
        })).catch(() => {});

        this.sendMuxFrame(sessionId, MUX_STATUS_END, 0, null);
        this.closeSession(sessionId, false);
    }

    sendMuxFrame(sessionId, status, option, payload) {
        if (this.webSocket.readyState !== 1) return;

        const meta = encodeMuxMeta(sessionId, status, option);
        let packet = meta;

        if ((option & MUX_OPTION_DATA) !== 0 && payload && payload.byteLength > 0) {
            const data = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
            const len = new Uint8Array(2);
            new DataView(len.buffer).setUint16(0, data.byteLength);
            packet = concatUint8Arrays(packet, len, data);
        }

        if (!this.sentRespHeader) {
            const vlessRespHeader = new Uint8Array([this.versionByte, 0]);
            packet = concatUint8Arrays(vlessRespHeader, packet);
            this.sentRespHeader = true;
        }

        this.webSocket.send(packet);
    }

    closeSession(sessionId, withError) {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        this.sessions.delete(sessionId);
        try {
            session.socket.close();
        } catch (error) {}
        if (withError) {
            this.sendMuxFrame(sessionId, MUX_STATUS_END, MUX_OPTION_ERROR, null);
        }
    }
}

function tryParseMuxFrame(buffer) {
    if (buffer.byteLength < 2) return null;

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const metaLen = view.getUint16(0);
    if (metaLen > 512) return null;
    if (buffer.byteLength < 2 + metaLen) return null;

    const meta = buffer.slice(2, 2 + metaLen);
    if (meta.byteLength < 4) return null;

    const metaView = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);
    let offset = 0;
    const sessionId = metaView.getUint16(offset);
    offset += 2;
    const status = metaView.getUint8(offset++);
    const option = metaView.getUint8(offset++);

    let target = null;
    if (status === MUX_STATUS_NEW) {
        if (meta.byteLength < offset + 4) return null;
        const network = metaView.getUint8(offset++);
        const port = metaView.getUint16(offset);
        offset += 2;
        const address = parseMuxAddress(meta, offset);
        if (!address) return null;
        target = { network, port, hostname: address.hostname };
    }

    let data = null;
    let totalSize = 2 + metaLen;
    if ((option & MUX_OPTION_DATA) !== 0) {
        if (buffer.byteLength < totalSize + 2) return null;
        const dataLen = new DataView(buffer.buffer, buffer.byteOffset + totalSize, 2).getUint16(0);
        if (buffer.byteLength < totalSize + 2 + dataLen) return null;
        data = buffer.slice(totalSize + 2, totalSize + 2 + dataLen);
        totalSize += 2 + dataLen;
    }

    return { sessionId, status, option, target, data, totalSize };
}

function parseMuxAddress(meta, offset) {
    if (meta.byteLength <= offset) return null;
    const type = new DataView(meta.buffer, meta.byteOffset + offset, 1).getUint8(0);
    offset += 1;

    if (type === 1) {
        if (meta.byteLength < offset + 4) return null;
        return { hostname: new Uint8Array(meta.slice(offset, offset + 4)).join('.') };
    }

    if (type === 2) {
        if (meta.byteLength < offset + 1) return null;
        const domainLen = new DataView(meta.buffer, meta.byteOffset + offset, 1).getUint8(0);
        offset += 1;
        if (meta.byteLength < offset + domainLen) return null;
        return { hostname: new TextDecoder().decode(meta.slice(offset, offset + domainLen)) };
    }

    if (type === 3) {
        if (meta.byteLength < offset + 16) return null;
        const ipv6 = [];
        const ipv6View = new DataView(meta.buffer, meta.byteOffset + offset, 16);
        for (let i = 0; i < 8; i++) ipv6.push(ipv6View.getUint16(i * 2).toString(16));
        return { hostname: ipv6.join(':') };
    }

    return null;
}

function encodeMuxMeta(sessionId, status, option) {
    const out = new Uint8Array(6);
    const view = new DataView(out.buffer);
    view.setUint16(0, 4);
    view.setUint16(2, sessionId);
    view.setUint8(4, status);
    view.setUint8(5, option);
    return out;
}

function concatUint8Arrays(...arrs) {
    let total = 0;
    for (const arr of arrs) total += arr.byteLength;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const arr of arrs) {
        out.set(arr, offset);
        offset += arr.byteLength;
    }
    return out;
}

async function forwardUDP(udpChunk, webSocket, respHeader) {
    try {
        const tcpSocket = connect({ hostname: '8.8.4.4', port: 53 });
        let header = respHeader;
        const writer = tcpSocket.writable.getWriter();
        await writer.write(udpChunk);
        writer.releaseLock();
        
        await tcpSocket.readable.pipeTo(new WritableStream({
            async write(chunk) {
                if (webSocket.readyState === 1) {
                    if (header) {
                        const combined = new Uint8Array(header.length + chunk.length);
                        combined.set(header);
                        combined.set(chunk, header.length);
                        webSocket.send(combined);
                        header = null;
                    } else {
                        webSocket.send(chunk);
                    }
                }
            },
        }));
    } catch (error) {}
}

function makeReadableStream(socket, earlyDataHeader) {
    let cancelled = false;
    return new ReadableStream({
        start(controller) {
            socket.addEventListener('message', (event) => { if (!cancelled) controller.enqueue(event.data); });
            socket.addEventListener('close', () => { if (!cancelled) { closeSocketQuietly(socket); controller.close(); } });
            socket.addEventListener('error', (err) => controller.error(err));
            const { earlyData } = base64ToArray(earlyDataHeader);
            if (earlyData) controller.enqueue(earlyData);
        },
        cancel() { cancelled = true; closeSocketQuietly(socket); }
    });
}

function base64ToArray(b64Str) {
    if (!b64Str) return { earlyData: null };
    try { 
        b64Str = b64Str.replace(/-/g, '+').replace(/_/g, '/'); 
        const bin = atob(b64Str);
        const u8 = new Uint8Array(bin.length);
        for (let i=0; i<bin.length; i++) u8[i] = bin.charCodeAt(i);
        return { earlyData: u8.buffer }; 
    }
    catch (error) { return { earlyData: null }; }
}

function closeSocketQuietly(socket) { 
    try { if (socket.readyState === 1 || socket.readyState === 2) socket.close(); } catch (error) {} 
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) byteToHex.push((i + 0x100).toString(16).substr(1));
function stringifyUuid(arr) {
    return (
        byteToHex[arr[0]] + byteToHex[arr[1]] + byteToHex[arr[2]] + byteToHex[arr[3]] + '-' +
        byteToHex[arr[4]] + byteToHex[arr[5]] + '-' +
        byteToHex[arr[6]] + byteToHex[arr[7]] + '-' +
        byteToHex[arr[8]] + byteToHex[arr[9]] + '-' +
        byteToHex[arr[10]] + byteToHex[arr[11]] + byteToHex[arr[12]] + byteToHex[arr[13]] + byteToHex[arr[14]] + byteToHex[arr[15]]
    ).toLowerCase();
}
