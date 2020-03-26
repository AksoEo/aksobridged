const { Server } = require('net');
const { workerData, parentPort } = require('worker_threads');
const { UserClient } = require('@tejo/akso-client');
const { CookieJar } = require('tough-cookie');
const { encode, decode } = require('@msgpack/msgpack');
const { setThreadName, info, debug } = require('./log');

setThreadName(`W${workerData.id}`);
parentPort.on('message', message => {
    if (!message) return;
    if (message.type === 'init') {
        init(message.channel);
    }
});

function init (channel) {
    debug('initializing');

    channel.on('message', message => {
        if (message.type === 'close') {
            debug('closing server');
            server.close();
            info('server closed');
            setTimeout(() => {
                channel.close();
            }, 30);
        }
    });

    const server = new Server(conn => {
        new ClientHandler(conn);
    });

    const listenAddr = `./ipc${workerData.id}`;
    server.listen(listenAddr, () => {
        info(`listening on ${listenAddr}`);
    });
}

const MAGIC = Buffer.from('abx1');
const MAX_SANE_MESSAGE_LEN = 10 * 1024 * 1024; // 10 MiB

const encodeMessage = msg => {
    const packed = encode(msg);
    const buf = Buffer.allocUnsafe(packed.length + 4);
    buf.writeInt32LE(buf.length, 0);
    packed.copy(buf, 4);
    return buf;
};

class ClientHandler {
    constructor (connection) {
        this.connection = connection;
        this.connection.on('data', data => this.onData(data));
        this.connection.on('close', () => this.onClose());

        this.didInit = false;
        this.currentMessageLen = null;
        this.currentMessageBuffer = null;
        this.currentMessageCursor = 0;

        // -----
        this.didHandshake = false;
        this.ip = null;
        this.cookies = null;
        this.client = null;
    }

    flushMessage () {
        this.currentMessageLen = null;
        let decoded;
        try {
            decoded = decode(this.currentMessageBuffer);
            if (typeof decoded !== 'object') throw new Error('expected object as root');
            if (typeof decoded.t !== 'string') throw new Error('expected t: string');
            if (typeof decoded.i !== 'string') throw new Error('expected i: string');
        } catch (err) {
            this.close('TXERR', 402, `failed to decode input: ${err}`);
            return;
        }

        this.handleInput(decoded);
    }

    onData (data) {
        let cursor = 0;

        if (!this.didInit) {
            if (data.slice(0, MAGIC.length).equals(MAGIC)) {
                this.didInit = true;
                cursor += MAGIC.length;
            } else {
                connection.write(encodeMessage({
                    t: 'TXERR',
                    c: 400,
                    m: 'bad magic',
                }));
                connection.close();
                return;
            }
        }

        while (cursor < data.length) {
            if (currentMessageLen === null) {
                // awaiting message length
                currentMessageLen = data.readInt32LE(cursor);
                if (currentMessageLen < 0) {
                    this.close('TXERR', 401, 'message has negative length');
                    return;
                } else if (currentMessageLen > MAX_SANE_MESSAGE_LEN) {
                    this.close('TXERR', 401, 'message is too long');
                    return;
                }
                cursor += 4;
                currentMessageBuffer = Buffer.allocUnsafe(currentMessageLen);
                currentMessageCursor = 0;
            } else {
                // message contents
                const messageBytesLeft = currentMessageLen - currentMessageCursor;
                const inputBytesLeft = data.length - cursor;

                if (inputBytesLeft >= messageBytesLeft) {
                    // rest of message is entirely contained in data
                    data.copy(currentMessageBuffer, currentMessageCursor, cursor, cursor + messageBytesLeft);
                    flushMessage();
                    cursor += messageBytesLeft;
                } else {
                    // data contains a part of the message
                    data.copy(currentMessageBuffer, currentMessageCursor, cursor, cursor + inputBytesLeft);
                    currentMessageCursor += inputBytesLeft;
                    cursor += inputBytesLeft;
                }
            }
        }
    }

    send (data) {
        this.connection.write(encodeMessage(data));
    }

    close (t, c, m) {
        this.send({ t, c, m });
        this.connection.close();
    }

    onClose () {
        debug('connection closed');
    }

    // -----

    handleInput (message) {
        if (!this.didHandshake && message.t !== 'hi') return;

        const handler = messageHandlers[message.t];
        if (!handler) {
            this.close('TXERR', 200, `unknown message type ${message.t}`);
            return;
        }

        handler(this, message).then(response => {
            this.send({
                t: '~',
                i: message.i,
                ...response,
            });
        }).catch(err => {
            this.send({
                t: '~!',
                i: message.i,
                m: err.toString(),
            });
        });
    }
}

function assertType (v, t, n) {
    if (typeof v !== t) {
        throw new Error(n);
    }
}

const messageHandlers = {
    hi: async (conn, { ip, co }) => {
        debug(`connection handshake from ip ${ip}`);
        assertType(ip, 'string', 'expected ip to be a string');
        assertType(co, 'object', 'expected co to be an object');
        if (conn.didHandshake) {
            throw new Error('double handshake');
        }

        conn.cookies = new CookieJar();

        for (const k in co) {
            const v = co[k];
            assertType(v, 'string', 'expected cookie value to be a string');
            conn.cookies.setCookieSync(`${k}=${v}`, workerData.host, {
                sameSiteContext: 'lax',
            });
        }

        // TODO: pass IP somehow...?
        conn.client = new UserClient({
            host: workerData.host,
            userAgent: workerData.userAgent,
            cookieJar: conn.cookies,
        });

        conn.didHandshake = true;
    },
};
